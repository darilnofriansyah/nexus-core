import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { VeyraController } from './veyra.controller';

function createController() {
  const calls: Array<{ method: string; request: unknown }> = [];
  const manageResponse = {
    ok: true,
    status: 'needs_confirmation',
    message: 'Confirm edit?',
    reply_markup: {
      inline_keyboard: [
        [
          { text: 'Confirm', callback_data: 'veyra_tx_manage:confirm' },
          { text: 'Cancel', callback_data: 'veyra_tx_manage:cancel' },
        ],
      ],
    },
    state: {
      state_name: 'confirm_action',
      state_data: { transaction_id: '163' },
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
    getEmailSourceReference: async (request: unknown) => {
      calls.push({ method: 'getEmailSourceReference', request });
      return { transactionId: '123', messageId: 'gmail-message-id' };
    },
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

test('/transactions/email/source-reference delegates lookup', async () => {
  const { calls, controller } = createController();
  const request = {
    telegramUserId: '976684739',
    transactionId: '123',
  };

  const result = await controller.getEmailSourceReference(request);

  assert.deepEqual(result, {
    transactionId: '123',
    messageId: 'gmail-message-id',
  });
  assert.deepEqual(calls.at(-1), {
    method: 'getEmailSourceReference',
    request,
  });
});

test('/transactions/callback/handle routes manage select callback to transaction manage handler', async () => {
  const { calls, controller } = createController();

  await controller.handleTransactionCallback({
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

test('/transactions/callback/handle routes manage confirm callback to transaction manage handler', async () => {
  const { calls, controller } = createController();

  await controller.handleTransactionCallback({
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

test('/transactions/callback/handle routes manage cancel callback to transaction manage handler', async () => {
  const { calls, controller } = createController();

  await controller.handleTransactionCallback({
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

test('/transactions/callback/handle returns manage callback as telegram edit payload', async () => {
  const { controller, manageResponse } = createController();

  const result = await controller.handleTransactionCallback({
    telegramUserId: '123456789',
    data: 'veyra_tx_manage:select:1',
    chatId: '123456789',
    messageId: '42',
  });

  assert.deepEqual(result, {
    status: 'ok',
    action: 'veyra_tx_manage',
    transactionId: 163,
    telegram: {
      method: 'editMessageText',
      chat_id: '123456789',
      message_id: 42,
      text: manageResponse.message,
      parse_mode: 'HTML',
      reply_markup: manageResponse.reply_markup,
    },
  });
});

test('/transactions/callback/handle does not mutate transactions directly for manage callbacks', async () => {
  const { calls, controller } = createController();

  await controller.handleTransactionCallback({
    telegramUserId: '123456789',
    callbackData: 'veyra_tx_manage:confirm',
  });

  assert.deepEqual(
    calls.map((call) => call.method),
    ['handleManagedTransaction'],
  );
});

test('/transactions/callback/handle stale manage callback delegates without direct mutation', async () => {
  const { calls, controller } = createController();

  await controller.handleTransactionCallback({
    telegramUserId: '123456789',
    callbackData: 'veyra_tx_manage:confirm',
  });

  assert.equal(calls[0]?.method, 'handleManagedTransaction');
  assert.equal(
    calls.some((call) => call.method === 'confirmTransaction'),
    false,
  );
});

test('/transactions/callback/handle non-manage callbacks use existing transaction callback behavior', async () => {
  const { calls, callbackResponse, controller } = createController();

  const result = await controller.handleTransactionCallback({
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

test('/transactions/callback/handle missing callback data returns existing callback fallback', async () => {
  const { calls, controller } = createController();

  await controller.handleTransactionCallback({
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

test('/transactions/callback/handle missing telegram user id returns invalid without direct mutation', async () => {
  const { calls, controller } = createController();

  await controller.handleTransactionCallback({
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
