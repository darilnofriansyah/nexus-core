import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { VeyraAiService } from '../../ai/veyra-ai.service';
import { MasterIntentResultDto } from './dto/message-route.dto';
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
  databaseCalls: string[] = [];
  stateCalls: number[] = [];

  constructor(
    private readonly user: VeyraMessageRouteUser | null,
    private readonly state: VeyraMessageRouteState | null = null,
  ) {}

  async findUser() {
    this.databaseCalls.push('findUser');
    return this.user;
  }

  async findActiveState(userId: number) {
    this.databaseCalls.push('findActiveState');
    this.stateCalls.push(userId);
    return this.state;
  }
}

const masterIntent: MasterIntentResultDto = {
  intent: 'spending_summary',
  period: 'this_month',
  merchant: null,
  category: null,
  limit: null,
  target: {
    id: null,
    merchant: null,
    category: null,
    amount: null,
    period: null,
  },
  changes: {
    amount: null,
    merchant: null,
    merchant_normalized: null,
    category: null,
    transaction_date: null,
    transaction_type: null,
    notes: null,
  },
  selection: null,
  confidence: 0.97,
};

class StubVeyraAiService {
  calls: unknown[] = [];

  constructor(private readonly error?: Error) {}

  async classifyMasterIntent(input: unknown) {
    this.calls.push(input);
    if (this.error) throw this.error;
    return masterIntent;
  }
}

function createService(
  state: VeyraMessageRouteState | null = null,
  user: VeyraMessageRouteUser | null = {
    id: 1,
    telegramUserId: '976684739',
  },
  aiService = new StubVeyraAiService(),
) {
  const repository = new StubMessageRouteRepository(user, state);
  const service = new VeyraMessageRouteService(
    repository as unknown as VeyraMessageRouteRepository,
    aiService as unknown as VeyraAiService,
  );

  return { aiService, repository, service };
}

test('callback query routes to callback', async () => {
  const { aiService, repository, service } = createService({
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
  assert.deepEqual(aiService.calls, []);
});

test('/budget routes to slash_command', async () => {
  const { aiService, repository, service } = createService({
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
  assert.deepEqual(aiService.calls, []);
});

test('active budget_conversation_state routes to budget', async () => {
  const { aiService, service } = createService({
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
  assert.deepEqual(aiService.calls, []);
});

test('active record_transaction_state routes to record', async () => {
  const { aiService, service } = createService({
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
  assert.deepEqual(aiService.calls, []);
});

test('active veyra_regret_note routes to record', async () => {
  const { aiService, service } = createService({
    name: 'veyra_regret_note',
    data: { review_id: '7', transaction_id: '123' },
    expiresAt: null,
  });

  const result = await service.routeMessage({
    userId: 1,
    text: 'Planned sale',
    messageType: 'text',
    callbackQuery: null,
  });

  assert.equal(result.route, 'record');
  assert.equal(result.reason, 'active_record_state');
  assert.deepEqual(aiService.calls, []);
});

test('active awaiting_confirmation routes to transaction_edit', async () => {
  const { aiService, service } = createService({
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
  assert.deepEqual(aiService.calls, []);
});

test('active awaiting_transaction_selection routes to transaction_edit', async () => {
  const { aiService, service } = createService({
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
  assert.deepEqual(aiService.calls, []);
});

test('unknown active state routes to fallback without inference', async () => {
  const { aiService, service } = createService({
    name: 'future_state',
    data: {},
    expiresAt: null,
  });

  const result = await service.routeMessage({
    userId: 1,
    text: 'hello',
    messageType: 'text',
    callbackQuery: null,
  });

  assert.equal(result.route, 'fallback');
  assert.equal(result.reason, 'unknown_active_state');
  assert.deepEqual(aiService.calls, []);
});

test('no state routes to conversational', async () => {
  const { aiService, service } = createService(null);

  const result = await service.routeMessage({
    userId: 1,
    text: 'how much did I spend?',
    messageType: 'text',
    callbackQuery: null,
  });

  assert.deepEqual(result, {
    route: 'conversational',
    reason: 'no_active_state',
    userId: 1,
    telegramUserId: '976684739',
    text: 'how much did I spend?',
    messageType: 'text',
    command: null,
    state: null,
    masterIntent,
  });
  assert.deepEqual(aiService.calls, [
    {
      message: 'how much did I spend?',
      currentState: null,
      stateData: {},
    },
  ]);
});

test('inference failure returns 503 without database mutation', async () => {
  const error = new ServiceUnavailableException(
    'AI master intent classification failed',
  );
  const aiService = new StubVeyraAiService(error);
  const { repository, service } = createService(null, undefined, aiService);

  await assert.rejects(
    service.routeMessage({
      userId: 1,
      text: 'private message',
      messageType: 'text',
      callbackQuery: null,
    }),
    error,
  );
  assert.deepEqual(repository.stateCalls, [1]);
  assert.deepEqual(repository.databaseCalls, ['findUser', 'findActiveState']);
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
  const { aiService, service } = createService(null, null);

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
  assert.deepEqual(aiService.calls, []);
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
