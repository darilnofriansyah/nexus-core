import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { VeyraController } from './veyra.controller';

function createController() {
  const calls: Array<{ method: string; request: unknown }> = [];
  const manageResponse = {
    ok: true,
    status: 'needs_confirmation',
    message: 'Confirm edit?',
    reply_markup: null,
    state: {
      state_name: 'confirm_action',
      state_data: {},
    },
    data: {},
  };
  const callbackResponse = {
    status: 'error',
    action: 'unknown_callback',
    telegram: {
      method: 'editMessageText',
      text: 'Unsupported transaction callback.',
      parse_mode: 'HTML',
      reply_markup: null,
    },
  };
  const transactionService = {
    handleManagedTransaction: async (request: unknown) => {
      calls.push({ method: 'handleManagedTransaction', request });
      return manageResponse;
    },
    handleTransactionCallback: async (request: unknown) => {
      calls.push({ method: 'handleTransactionCallback', request });
      return callbackResponse;
    },
    confirmTransaction: async () => {
      calls.push({ method: 'confirmTransaction', request: {} });
      return {};
    },
    cancelTransaction: async () => {
      calls.push({ method: 'cancelTransaction', request: {} });
      return {};
    },
    placeholderStatus: () => ({}),
  };
  const controller = new VeyraController(
    {
      placeholderStatus: () => ({
        implemented: false,
        nextStep: '',
      }),
    } as unknown as ConstructorParameters<typeof VeyraController>[0],
    {} as unknown as ConstructorParameters<typeof VeyraController>[1],
    {
      detectIntent: () => ({ intent: 'unknown' }),
    } as unknown as ConstructorParameters<typeof VeyraController>[2],
    {} as unknown as ConstructorParameters<typeof VeyraController>[3],
    {
      formatPlaceholderReply: () => '',
    } as unknown as ConstructorParameters<typeof VeyraController>[4],
    transactionService as unknown as ConstructorParameters<
      typeof VeyraController
    >[5],
  );

  return { calls, controller, manageResponse, callbackResponse };
}

test('/callback routes manage select callback to transaction manage handler', async () => {
  const { calls, controller } = createController();

  await controller.handleCallback({
    telegramUserId: '123456789',
    callbackData: 'veyra_tx_manage:select:1',
  });

  assert.deepEqual(calls, [
    {
      method: 'handleManagedTransaction',
      request: {
        telegramUserId: '123456789',
        text: 'veyra_tx_manage:select:1',
        llmResult: null,
        statePayload: {},
      },
    },
  ]);
});

test('/callback routes manage confirm callback to transaction manage handler', async () => {
  const { calls, controller } = createController();

  await controller.handleCallback({
    callback_query: {
      data: 'veyra_tx_manage:confirm',
      from: { id: 123456789 },
    },
  });

  assert.equal(calls[0]?.method, 'handleManagedTransaction');
  assert.deepEqual(calls[0]?.request, {
    telegramUserId: '123456789',
    text: 'veyra_tx_manage:confirm',
    llmResult: null,
    statePayload: {},
  });
});

test('/callback routes manage cancel callback to transaction manage handler', async () => {
  const { calls, controller } = createController();

  await controller.handleCallback({
    telegramUserId: '123456789',
    text: 'veyra_tx_manage:cancel',
  });

  assert.equal(calls[0]?.method, 'handleManagedTransaction');
  assert.deepEqual(calls[0]?.request, {
    telegramUserId: '123456789',
    text: 'veyra_tx_manage:cancel',
    llmResult: null,
    statePayload: {},
  });
});

test('/callback returns transaction manage response as-is', async () => {
  const { controller, manageResponse } = createController();

  const result = await controller.handleCallback({
    telegramUserId: '123456789',
    data: 'veyra_tx_manage:select:1',
  });

  assert.equal(result, manageResponse);
});

test('/callback does not mutate transactions directly for manage callbacks', async () => {
  const { calls, controller } = createController();

  await controller.handleCallback({
    telegramUserId: '123456789',
    callbackData: 'veyra_tx_manage:confirm',
  });

  assert.deepEqual(
    calls.map((call) => call.method),
    ['handleManagedTransaction'],
  );
});

test('/callback stale manage callback delegates without direct mutation', async () => {
  const { calls, controller } = createController();

  await controller.handleCallback({
    telegramUserId: '123456789',
    callbackData: 'veyra_tx_manage:confirm',
  });

  assert.equal(calls[0]?.method, 'handleManagedTransaction');
  assert.equal(
    calls.some((call) => call.method === 'confirmTransaction'),
    false,
  );
});

test('/callback non-manage callbacks use existing transaction callback behavior', async () => {
  const { calls, callbackResponse, controller } = createController();

  const result = await controller.handleCallback({
    telegramUserId: '123456789',
    userId: '1',
    callbackData: 'save_transaction:123',
    chatId: 'chat-1',
    messageId: '42',
  });

  assert.equal(result, callbackResponse);
  assert.deepEqual(calls, [
    {
      method: 'handleTransactionCallback',
      request: {
        telegramUserId: '123456789',
        userId: 1,
        callbackData: 'save_transaction:123',
        chatId: 'chat-1',
        messageId: 42,
      },
    },
  ]);
});

test('/callback missing callback data returns existing callback fallback', async () => {
  const { calls, controller } = createController();

  await controller.handleCallback({
    telegramUserId: '123456789',
    userId: 1,
  });

  assert.equal(calls[0]?.method, 'handleTransactionCallback');
  assert.deepEqual(calls[0]?.request, {
    telegramUserId: '123456789',
    userId: 1,
    callbackData: '',
    chatId: undefined,
    messageId: 0,
  });
});

test('/callback missing telegram user id returns invalid without direct mutation', async () => {
  const { calls, controller } = createController();

  await controller.handleCallback({
    callbackData: 'veyra_tx_manage:confirm',
  });

  assert.deepEqual(calls, [
    {
      method: 'handleManagedTransaction',
      request: {
        telegramUserId: '',
        text: 'veyra_tx_manage:confirm',
        llmResult: null,
        statePayload: {},
      },
    },
  ]);
});
