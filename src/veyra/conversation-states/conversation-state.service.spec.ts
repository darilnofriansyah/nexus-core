import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { BadRequestException } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { ConversationStateService } from './conversation-state.service';

function createService(rowsByCall: unknown[][] = []) {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const database = {
    query: async (text: string, values: unknown[] = []) => {
      calls.push({ text, values });
      return { rows: rowsByCall.shift() ?? [] };
    },
  } as unknown as DatabaseService;

  return {
    calls,
    service: new ConversationStateService(database),
  };
}

test('returns idle state when no conversation state row exists', async () => {
  const { calls, service } = createService([[]]);

  const state = await service.getState(123);

  assert.equal(calls.length, 1);
  assert.match(calls[0].text, /FROM conversation_states/);
  assert.deepEqual(calls[0].values, ['123']);
  assert.deepEqual(state, {
    userId: '123',
    stateName: 'idle',
    stateData: {},
    expiresAt: null,
    updatedAt: null,
  });
});

test('maps an existing conversation state row', async () => {
  const updatedAt = new Date('2026-06-20T10:00:00.000Z');
  const { service } = createService([
    [
      {
        user_id: 123,
        state_name: 'budget_conversation_state',
        state_data: { step: 'amount' },
        expires_at: null,
        updated_at: updatedAt,
      },
    ],
  ]);

  const state = await service.getState('123');

  assert.deepEqual(state, {
    userId: '123',
    stateName: 'budget_conversation_state',
    stateData: { step: 'amount' },
    expiresAt: null,
    updatedAt: '2026-06-20T10:00:00.000Z',
  });
});

test('upserts slash command aliases as supported state names', async () => {
  const { calls, service } = createService([
    [
      {
        user_id: '123',
        state_name: 'record_transaction_state',
        state_data: { step: 'merchant' },
        expires_at: '2026-06-20T11:00:00.000Z',
        updated_at: '2026-06-20T10:00:00.000Z',
      },
    ],
  ]);

  const state = await service.upsertState({
    userId: '123',
    stateName: '/record',
    stateData: { step: 'merchant' },
    expiresAt: '2026-06-20T11:00:00.000Z',
  });

  assert.equal(calls.length, 1);
  assert.match(calls[0].text, /INSERT INTO conversation_states/);
  assert.match(calls[0].text, /ON CONFLICT \(user_id\) DO UPDATE/);
  assert.match(calls[0].text, /updated_at = NOW\(\)/);
  assert.deepEqual(calls[0].values, [
    '123',
    'record_transaction_state',
    '{"step":"merchant"}',
    '2026-06-20T11:00:00.000Z',
  ]);
  assert.deepEqual(state, {
    userId: '123',
    stateName: 'record_transaction_state',
    stateData: { step: 'merchant' },
    expiresAt: '2026-06-20T11:00:00.000Z',
    updatedAt: '2026-06-20T10:00:00.000Z',
  });
});

test('upserts budget state with empty state data by default', async () => {
  const { calls, service } = createService([
    [
      {
        user_id: '123',
        state_name: 'budget_conversation_state',
        state_data: {},
        expires_at: null,
        updated_at: '2026-06-20T10:00:00.000Z',
      },
    ],
  ]);

  const state = await service.upsertState({
    userId: 123,
    stateName: '/budget',
  });

  assert.deepEqual(calls[0].values, [
    '123',
    'budget_conversation_state',
    '{}',
    null,
  ]);
  assert.equal(state.stateName, 'budget_conversation_state');
  assert.deepEqual(state.stateData, {});
});

test('resets conversation state to idle with empty state data', async () => {
  const { calls, service } = createService([
    [
      {
        user_id: '123',
        state_name: 'idle',
        state_data: {},
        expires_at: null,
        updated_at: '2026-06-20T10:00:00.000Z',
      },
    ],
  ]);

  const state = await service.resetState({ userId: '123' });

  assert.equal(calls.length, 1);
  assert.match(
    calls[0].text,
    /VALUES \(\$1, 'idle', '\{\}'::jsonb, NULL, NOW\(\)\)/,
  );
  assert.match(calls[0].text, /expires_at = NULL/);
  assert.deepEqual(calls[0].values, ['123']);
  assert.deepEqual(state, {
    userId: '123',
    stateName: 'idle',
    stateData: {},
    expiresAt: null,
    updatedAt: '2026-06-20T10:00:00.000Z',
  });
});

test('rejects unsupported state names', async () => {
  const { service } = createService();

  await assert.rejects(
    () =>
      service.upsertState({
        userId: '123',
        stateName: 'unknown' as never,
      }),
    BadRequestException,
  );
});

test('requires numeric user id', async () => {
  const { service } = createService();

  await assert.rejects(
    () => service.getState('telegram-123'),
    BadRequestException,
  );
});
