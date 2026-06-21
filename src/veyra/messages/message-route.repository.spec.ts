import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseService } from '../../database/database.service';
import { VeyraMessageRouteRepository } from './message-route.repository';

function createRepository(rowsByCall: unknown[][] = []) {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const database = {
    query: async (text: string, values: unknown[] = []) => {
      calls.push({ text, values });
      return { rows: rowsByCall.shift() ?? [] };
    },
  } as unknown as DatabaseService;

  return {
    calls,
    repository: new VeyraMessageRouteRepository(database),
  };
}

test('findUser resolves by internal or telegram user id using text-safe comparisons', async () => {
  const { calls, repository } = createRepository([
    [{ id: '1', telegram_id: '976684739' }],
  ]);

  const user = await repository.findUser('1', '976684739');

  assert.deepEqual(user, {
    id: 1,
    telegramUserId: '976684739',
  });
  assert.match(calls[0].text, /FROM telegram_users/);
  assert.match(calls[0].text, /id::text = \$1::text/);
  assert.match(calls[0].text, /telegram_id::text = \$2::text/);
  assert.deepEqual(calls[0].values, ['1', '976684739']);
});

test('findUser returns null when no telegram user matches', async () => {
  const { repository } = createRepository([[]]);

  const user = await repository.findUser(null, 'unknown');

  assert.equal(user, null);
});

test('findActiveState excludes idle and expired states in SQL', async () => {
  const { calls, repository } = createRepository([
    [
      {
        state_name: 'awaiting_confirmation',
        state_data: { pendingTransactionId: 10 },
        expires_at: null,
      },
    ],
  ]);

  const state = await repository.findActiveState(1);

  assert.deepEqual(state, {
    name: 'awaiting_confirmation',
    data: { pendingTransactionId: 10 },
    expiresAt: null,
  });
  assert.match(calls[0].text, /FROM conversation_states/);
  assert.match(calls[0].text, /state_name IS NOT NULL/);
  assert.match(calls[0].text, /state_name <> 'idle'/);
  assert.match(calls[0].text, /expires_at IS NULL OR expires_at > NOW\(\)/);
  assert.deepEqual(calls[0].values, ['1']);
});

test('findActiveState returns null when there is no active state row', async () => {
  const { repository } = createRepository([[]]);

  const state = await repository.findActiveState(1);

  assert.equal(state, null);
});
