import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { BadRequestException } from '@nestjs/common';
import {
  VeyraMessageRouteRepository,
  VeyraMessageRouteState,
  VeyraMessageRouteUser,
} from './message-route.repository';
import { VeyraMessageRouteService } from './message-route.service';

class StubMessageRouteRepository implements Pick<
  VeyraMessageRouteRepository,
  'findUser' | 'findActiveState'
> {
  stateCalls: number[] = [];

  constructor(
    private readonly user: VeyraMessageRouteUser | null,
    private readonly state: VeyraMessageRouteState | null = null,
  ) {}

  async findUser() {
    return this.user;
  }

  async findActiveState(userId: number) {
    this.stateCalls.push(userId);
    return this.state;
  }
}

function createService(
  state: VeyraMessageRouteState | null = null,
  user: VeyraMessageRouteUser | null = {
    id: 1,
    telegramUserId: '976684739',
  },
) {
  const repository = new StubMessageRouteRepository(user, state);
  const service = new VeyraMessageRouteService(
    repository as unknown as VeyraMessageRouteRepository,
  );

  return { repository, service };
}

test('callback query routes to callback', async () => {
  const { repository, service } = createService({
    name: 'budget_conversation_state',
    data: {},
    expiresAt: null,
  });

  const result = await service.routeMessage({
    telegramUserId: 976684739,
    text: null,
    messageType: 'callback_query',
    callbackQuery: { data: 'tx_confirm:1' },
  });

  assert.equal(result.route, 'callback');
  assert.equal(result.reason, 'callback_query');
  assert.equal(result.telegramUserId, '976684739');
  assert.equal(result.userId, 1);
  assert.equal(result.state, null);
  assert.deepEqual(repository.stateCalls, []);
});

test('/budget routes to slash_command', async () => {
  const { repository, service } = createService({
    name: 'record_transaction_state',
    data: {},
    expiresAt: null,
  });

  const result = await service.routeMessage({
    userId: 1,
    text: '/budget Food',
    messageType: 'text',
    callbackQuery: null,
  });

  assert.equal(result.route, 'slash_command');
  assert.equal(result.reason, 'slash_command');
  assert.equal(result.command, '/budget');
  assert.deepEqual(repository.stateCalls, []);
});

test('active budget_conversation_state routes to budget', async () => {
  const { service } = createService({
    name: 'budget_conversation_state',
    data: { step: 'amount' },
    expiresAt: null,
  });

  const result = await service.routeMessage({
    userId: 1,
    text: 'Get all budgets',
    messageType: 'text',
    callbackQuery: null,
  });

  assert.equal(result.route, 'budget');
  assert.equal(result.reason, 'active_budget_state');
  assert.deepEqual(result.state, {
    name: 'budget_conversation_state',
    data: { step: 'amount' },
  });
});

test('active record_transaction_state routes to record', async () => {
  const { service } = createService({
    name: 'record_transaction_state',
    data: { step: 'merchant' },
    expiresAt: null,
  });

  const result = await service.routeMessage({
    userId: 1,
    text: 'coffee',
    messageType: 'text',
    callbackQuery: null,
  });

  assert.equal(result.route, 'record');
  assert.equal(result.reason, 'active_record_state');
});

test('active awaiting_confirmation routes to transaction_edit', async () => {
  const { service } = createService({
    name: 'awaiting_confirmation',
    data: { transactionId: 10 },
    expiresAt: null,
  });

  const result = await service.routeMessage({
    userId: 1,
    text: 'yes',
    messageType: 'text',
    callbackQuery: null,
  });

  assert.equal(result.route, 'transaction_edit');
  assert.equal(result.reason, 'active_transaction_edit_state');
});

test('active awaiting_transaction_selection routes to transaction_edit', async () => {
  const { service } = createService({
    name: 'awaiting_transaction_selection',
    data: { selection: 'recent' },
    expiresAt: null,
  });

  const result = await service.routeMessage({
    userId: 1,
    text: '2',
    messageType: 'text',
    callbackQuery: null,
  });

  assert.equal(result.route, 'transaction_edit');
  assert.equal(result.reason, 'active_transaction_edit_state');
});

test('no state routes to conversational', async () => {
  const { service } = createService(null);

  const result = await service.routeMessage({
    userId: 1,
    text: 'how much did I spend?',
    messageType: 'text',
    callbackQuery: null,
  });

  assert.equal(result.route, 'conversational');
  assert.equal(result.reason, 'no_active_state');
  assert.equal(result.state, null);
});

test('idle state routes to conversational', async () => {
  const { service } = createService(null);

  const result = await service.routeMessage({
    userId: 1,
    text: 'hello',
    messageType: 'text',
    callbackQuery: null,
  });

  assert.equal(result.route, 'conversational');
});

test('expired state routes to conversational', async () => {
  const { service } = createService(null);

  const result = await service.routeMessage({
    userId: 1,
    text: 'hello',
    messageType: 'text',
    callbackQuery: null,
  });

  assert.equal(result.route, 'conversational');
});

test('missing or unknown user routes to fallback when an identifier is present', async () => {
  const { service } = createService(null, null);

  const result = await service.routeMessage({
    telegramUserId: 'unknown',
    text: 'hello',
    messageType: 'text',
    callbackQuery: null,
  });

  assert.equal(result.route, 'fallback');
  assert.equal(result.reason, 'user_not_resolved');
  assert.equal(result.userId, null);
  assert.equal(result.telegramUserId, 'unknown');
});

test('requires either telegramUserId or userId', async () => {
  const { service } = createService();

  await assert.rejects(
    () =>
      service.routeMessage({
        text: 'hello',
        messageType: 'text',
        callbackQuery: null,
      }),
    BadRequestException,
  );
});
