import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { BadRequestException } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { TransactionService } from './transaction.service';

function createService(rowsByCall: unknown[][] = []) {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const query = async (text: string, values: unknown[] = []) => {
    calls.push({ text, values });
    return { rows: rowsByCall.shift() ?? [] };
  };
  const database = {
    query,
    withTransaction: async (
      callback: (client: { query: typeof query }) => unknown,
    ) => callback({ query }),
  } as unknown as DatabaseService;

  return {
    calls,
    service: new TransactionService(database),
  };
}

function createStateStore() {
  const calls: Array<{ method: string; request: unknown }> = [];

  return {
    calls,
    store: {
      upsertState: async (request: unknown) => {
        calls.push({ method: 'upsertState', request });
        return {};
      },
      resetState: async (request: unknown) => {
        calls.push({ method: 'resetState', request });
        return {};
      },
    },
  };
}

function createManageStateStore(initialState?: {
  stateName: string;
  stateData: unknown;
  expiresAt?: string | null;
}) {
  const calls: Array<{ method: string; request: unknown }> = [];
  let state: {
    stateName: string;
    stateData: unknown;
    expiresAt: string | null;
  } = {
    stateName: initialState?.stateName ?? 'idle',
    stateData: initialState?.stateData ?? {},
    expiresAt: initialState?.expiresAt ?? null,
  };

  return {
    calls,
    get state() {
      return state;
    },
    store: {
      getState: async (userId: string | number) => {
        calls.push({ method: 'getState', request: userId });
        return state;
      },
      upsertState: async (request: {
        stateName: string;
        stateData?: unknown;
        expiresAt?: string | null;
      }) => {
        calls.push({ method: 'upsertState', request });
        state = {
          stateName: request.stateName,
          stateData: request.stateData ?? {},
          expiresAt: request.expiresAt ?? null,
        };
        return {};
      },
      resetState: async (request: unknown) => {
        calls.push({ method: 'resetState', request });
        state = { stateName: 'idle', stateData: {}, expiresAt: null };
        return {};
      },
    },
  };
}

const pendingTransaction = {
  id: 'pending-1',
  user_id: 'user-1',
  transaction_type: 'expense',
  amount: '50000',
  merchant: 'gopay',
  merchant_normalized: 'GoPay',
  category: 'Transport',
  transaction_date: '2026-06-17T10:00:00.000Z',
  source: 'email',
  bank: 'BCA',
  payment_type: 'QRIS',
  raw_payload: { emailId: 'email-1' },
  resolved: false,
};

const transaction = {
  id: 'tx-1',
  user_id: 'user-1',
  amount: '50000',
  merchant: 'gopay',
  merchant_normalized: 'GoPay',
  category: 'Transport',
  status: 'pending',
};

const manageTransaction = {
  id: '101',
  user_id: '1',
  transaction_type: 'expense',
  amount: '25000',
  merchant: 'Kopi Tuku',
  merchant_normalized: 'Kopi Tuku',
  category: 'Others',
  transaction_date: '2026-06-25T03:00:00.000Z',
  notes: null,
  status: 'confirmed',
  created_at: '2026-06-25T03:01:00.000Z',
};

const manageTransaction2 = {
  ...manageTransaction,
  id: '102',
  amount: '27000',
  transaction_date: '2026-06-24T03:00:00.000Z',
};

const budgetCategoryRows = [
  { id: 'budget-food', category: 'Food', parent_category: null },
  { id: 'budget-transport', category: 'Transport', parent_category: null },
  { id: 'budget-groceries', category: 'Groceries', parent_category: null },
  { id: 'budget-bills', category: 'Bills', parent_category: null },
  { id: 'budget-health', category: 'Health & Beauty', parent_category: null },
  { id: 'budget-shopping', category: 'Shopping', parent_category: null },
  {
    id: 'budget-entertainment',
    category: 'Entertainment',
    parent_category: null,
  },
  { id: 'budget-transfer', category: 'Transfer', parent_category: null },
  { id: 'budget-other', category: 'Other', parent_category: null },
];

test('normalizes a basic expense transaction', async () => {
  const { service } = createService([[], []]);

  const result = await service.normalizeTransaction({
    userId: 'user-1',
    transactionType: 'expense',
    amount: 'Rp50.000',
    merchant: ' gopay ',
    transactionDate: '2026-06-17T10:00:00.000Z',
  });

  assert.equal(result.userId, 'user-1');
  assert.equal(result.transactionType, 'expense');
  assert.equal(result.amount, 50000);
  assert.equal(result.merchant, 'gopay');
  assert.equal(result.merchantNormalized, 'gopay');
  assert.equal(result.category, null);
  assert.equal(result.source, 'manual');
  assert.equal(result.notes, null);
  assert.deepEqual(result.warnings, []);
});

test('normalizes uppercase transaction type', async () => {
  const { service } = createService([[], []]);

  const result = await service.normalizeTransaction({
    userId: 'user-1',
    transactionType: ' INCOME ',
    amount: 75000,
    merchant: 'Payroll',
  });

  assert.equal(result.transactionType, 'income');
});

test('maps refund cashback and reversal cases safely', async () => {
  const { service } = createService([[], [], [], []]);

  const cashback = await service.normalizeTransaction({
    userId: 'user-1',
    transactionType: 'cashback',
    amount: 10000,
    merchant: 'Bank Promo',
  });
  const reversal = await service.normalizeTransaction({
    userId: 'user-1',
    transactionType: 'expense',
    amount: 50000,
    merchant: 'Card',
    rawPayload: { description: 'void reversal' },
  });

  assert.equal(cashback.transactionType, 'income');
  assert.deepEqual(cashback.warnings, [
    'refund/cashback input mapped to income',
  ]);
  assert.equal(reversal.transactionType, 'reversal');
  assert.deepEqual(reversal.warnings, [
    'transactionType mapped to reversal from reversal-like input',
  ]);
});

test('uses merchant alias lookup when available', async () => {
  const { calls, service } = createService([[{ canonical_name: 'GoPay' }], []]);

  const result = await service.normalizeTransaction({
    userId: 'user-1',
    transactionType: 'expense',
    amount: 50000,
    merchant: 'gopay',
  });

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].values, ['gopay']);
  assert.match(calls[0].text, /canonical_name/);
  assert.match(calls[0].text, /alias_name/);
  assert.match(calls[0].text, /LIKE/);
  assert.doesNotMatch(calls[0].text, /user_id/);
  assert.equal(result.merchantNormalized, 'GoPay');
  assert.equal(result.confidence, 85);
});

test('keeps original merchant when alias lookup misses', async () => {
  const { calls, service } = createService([[], []]);

  const result = await service.normalizeTransaction({
    userId: 'user-1',
    transactionType: 'expense',
    amount: 'IDR 50,000.00',
    merchant: 'Coffee Shop',
  });

  assert.equal(calls.length, 2);
  assert.equal(result.amount, 50000);
  assert.equal(result.merchantNormalized, 'Coffee Shop');
  assert.equal(result.category, null);
  assert.equal(result.confidence, 70);
});

test('uses category rule lookup when available', async () => {
  const { calls, service } = createService([
    [{ canonical_name: 'GoPay' }],
    [{ category: 'Transport' }],
  ]);

  const result = await service.normalizeTransaction({
    userId: 'user-1',
    transactionType: 'expense',
    amount: 50000,
    merchant: 'gopay',
  });

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].values, ['GoPay', 'gopay']);
  assert.match(calls[1].text, /merchant_pattern/);
  assert.doesNotMatch(calls[1].text, /merchant_normalized/);
  assert.doesNotMatch(calls[1].text, /user_id/);
  assert.match(calls[1].text, /priority DESC NULLS LAST/);
  assert.equal(result.category, 'Transport');
  assert.equal(result.confidence, 95);
});

test('rejects invalid amount', async () => {
  const { service } = createService();

  await assert.rejects(
    () =>
      service.normalizeTransaction({
        userId: 'user-1',
        transactionType: 'expense',
        amount: 0,
        merchant: 'gopay',
      }),
    BadRequestException,
  );
});

test('rejects missing merchant for expense', async () => {
  const { service } = createService();

  await assert.rejects(
    () =>
      service.normalizeTransaction({
        userId: 'user-1',
        transactionType: 'expense',
        amount: 50000,
        merchant: ' ',
      }),
    BadRequestException,
  );
});

test('defaults optional fields', async () => {
  const { service } = createService([[], []]);

  const before = Date.now();
  const result = await service.normalizeTransaction({
    userId: 'user-1',
    transactionType: 'expense',
    amount: 50000,
    merchant: 'gopay',
  });
  const after = Date.now();
  const transactionTime = Date.parse(result.transactionDate);

  assert.equal(result.source, 'manual');
  assert.equal(result.notes, null);
  assert.equal(result.category, null);
  assert.ok(transactionTime >= before);
  assert.ok(transactionTime <= after);
});

test('handles manual transaction with decimal confidence as confirmed', async () => {
  const { calls, service } = createService([[], [{ id: 'tx-123' }]]);

  const result = await service.handleManualTransaction({
    telegramUserId: '976684739',
    userId: 1,
    source: 'manual',
    text: 'Spend 25k for kopi tuku',
    llmResult: {
      transaction_type: 'expense',
      amount: 25000,
      merchant: 'kopi tuku',
      category: 'Coffee',
      confidence: 0.94,
      transaction_date: null,
      notes: null,
      missing_fields: [],
    },
  });

  assert.equal(result.status, 'confirmed');
  assert.equal(result.transactionId, 'tx-123');
  assert.match(
    result.message,
    /Recorded: Rp25\.000 at Kopi Tuku under Coffee\./,
  );
  assert.match(calls[1].text, /INSERT INTO transactions/);
  assert.deepEqual(calls[1].values.slice(0, 11), [
    '1',
    'expense',
    25000,
    'kopi tuku',
    'kopi tuku',
    'Coffee',
    calls[1].values[6],
    null,
    'confirmed',
    94,
    {
      text: 'Spend 25k for kopi tuku',
      source: 'manual',
      telegramUserId: '976684739',
      llmResult: {
        transaction_type: 'expense',
        amount: 25000,
        merchant: 'kopi tuku',
        category: 'Coffee',
        confidence: 0.94,
        transaction_date: null,
        notes: null,
        missing_fields: [],
      },
    },
  ]);
});

test('confirmed manual transaction resets state after insert', async () => {
  const { calls, service } = createService([[], [{ id: 'tx-confirmed' }]]);
  const state = createStateStore();

  const result = await service.handleManualTransaction(
    {
      userId: 1,
      source: 'manual',
      llmResult: {
        transaction_type: 'expense',
        amount: 25000,
        merchant: 'kopi tuku',
        category: 'Coffee',
        confidence: 95,
      },
    },
    state.store,
  );

  assert.equal(result.status, 'confirmed');
  assert.match(calls[1].text, /INSERT INTO transactions/);
  assert.deepEqual(state.calls, [
    { method: 'resetState', request: { userId: 1 } },
  ]);
});

test('handles manual transaction with integer confidence as confirmed', async () => {
  const { calls, service } = createService([[], [{ id: 'tx-94' }]]);

  const result = await service.handleManualTransaction({
    userId: 1,
    source: 'manual',
    llmResult: {
      transaction_type: 'expense',
      amount: 25000,
      merchant: 'kopi tuku',
      category: 'Coffee',
      confidence: 94,
    },
  });

  assert.equal(result.status, 'confirmed');
  assert.equal(calls[1].values[9], 94);
  assert.equal(calls[1].values[8], 'confirmed');
});

test('handles manual transaction with low confidence as pending confirmation', async () => {
  const { calls, service } = createService([[], [{ id: 'tx-pending' }]]);

  const result = await service.handleManualTransaction({
    userId: 1,
    source: 'manual',
    llmResult: {
      transaction_type: 'expense',
      amount: 25000,
      merchant: 'kopi tuku',
      category: 'Coffee',
      confidence: 0.75,
    },
  });

  assert.equal(result.status, 'pending');
  assert.equal(calls[1].values[8], 'pending');
  assert.equal(calls[1].values[9], 75);
  assert.equal(result.message, 'Please confirm this transaction.');
  assert.match(result.confirmationPayload?.text ?? '', /Confirm transaction/);
  assert.deepEqual(result.confirmationPayload?.reply_markup.inline_keyboard, [
    [
      { text: 'Save', callback_data: 'save_transaction:tx-pending' },
      {
        text: 'Change Category',
        callback_data: 'change_categories:tx-pending',
      },
    ],
    [{ text: 'Cancel', callback_data: 'cancel_transaction:tx-pending' }],
  ]);
});

test('pending manual transaction resets state after insert', async () => {
  const { calls, service } = createService([[], [{ id: 'tx-pending' }]]);
  const state = createStateStore();

  const result = await service.handleManualTransaction(
    {
      userId: 1,
      source: 'manual',
      llmResult: {
        transaction_type: 'expense',
        amount: 25000,
        merchant: 'kopi tuku',
        category: 'Coffee',
        confidence: 75,
      },
    },
    state.store,
  );

  assert.equal(result.status, 'pending');
  assert.match(calls[1].text, /INSERT INTO transactions/);
  assert.deepEqual(state.calls, [
    { method: 'resetState', request: { userId: 1 } },
  ]);
});

test('cancel text resets state without inserting transaction', async () => {
  const { calls, service } = createService();
  const state = createStateStore();

  const result = await service.handleManualTransaction(
    {
      userId: 1,
      source: 'manual',
      text: 'batal',
      llmResult: {
        transaction_type: 'expense',
        amount: 25000,
        merchant: 'kopi tuku',
        category: 'Coffee',
        confidence: 95,
      },
    },
    state.store,
  );

  assert.deepEqual(result, {
    status: 'cancelled',
    transactionId: null,
    message: 'Transaction recording cancelled.',
  });
  assert.equal(calls.length, 0);
  assert.deepEqual(state.calls, [
    { method: 'resetState', request: { userId: 1 } },
  ]);
});

test('failed manual transaction insert does not reset state', async () => {
  const { service } = createService([[], []]);
  const state = createStateStore();

  await assert.rejects(
    () =>
      service.handleManualTransaction(
        {
          userId: 1,
          source: 'manual',
          llmResult: {
            transaction_type: 'expense',
            amount: 25000,
            merchant: 'kopi tuku',
            category: 'Coffee',
            confidence: 95,
          },
        },
        state.store,
      ),
    BadRequestException,
  );
  assert.deepEqual(state.calls, []);
});

test('accepts llm-provided category even when it is not in budgets', async () => {
  const { calls, service } = createService([[], [{ id: 'tx-new-category' }]]);

  const result = await service.handleManualTransaction({
    userId: 1,
    source: 'manual',
    llmResult: {
      transaction_type: 'expense',
      amount: 25000,
      merchant: 'kopi tuku',
      category: 'Specialty Coffee',
      confidence: 95,
    },
  });

  assert.equal(result.status, 'confirmed');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].values[5], 'Specialty Coffee');
});

test('rejects missing category when no category rule resolves it', async () => {
  const { calls, service } = createService([[], []]);

  await assert.rejects(
    () =>
      service.handleManualTransaction({
        userId: 1,
        source: 'manual',
        llmResult: {
          transaction_type: 'expense',
          amount: 25000,
          merchant: 'kopi tuku',
          confidence: 95,
        },
      }),
    BadRequestException,
  );
  assert.equal(calls.length, 2);
});

test('resolves missing category from category rule before saving', async () => {
  const { calls, service } = createService([
    [],
    [{ category: 'Coffee' }],
    [{ id: 'tx-rule' }],
  ]);

  const result = await service.handleManualTransaction({
    userId: 1,
    source: 'manual',
    llmResult: {
      transaction_type: 'expense',
      amount: 25000,
      merchant: 'kopi tuku',
      confidence: 95,
    },
  });

  assert.equal(result.status, 'confirmed');
  assert.equal(calls[2].values[5], 'Coffee');
  assert.match(calls[1].text, /FROM category_rules/);
});

test('returns unsupported source response without saving', async () => {
  const { calls, service } = createService();

  const result = await service.handleManualTransaction({
    userId: 1,
    source: 'email',
    llmResult: {
      transaction_type: 'expense',
      amount: 25000,
      merchant: 'kopi tuku',
      category: 'Coffee',
      confidence: 95,
    },
  });

  assert.deepEqual(result, {
    status: 'unsupported_source',
    transactionId: null,
    message: 'Transaction source email is not supported yet.',
  });
  assert.equal(calls.length, 0);
});

test('rejects missing llmResult without saving', async () => {
  const { calls, service } = createService();

  await assert.rejects(
    () =>
      service.handleManualTransaction({
        userId: 1,
        source: 'manual',
      }),
    BadRequestException,
  );
  assert.equal(calls.length, 0);
});

test('manual transaction missing field saves pending state and asks follow-up', async () => {
  const { calls, service } = createService();
  const state = createStateStore();

  const result = await service.handleManualTransaction(
    {
      userId: 1,
      source: 'manual',
      llmResult: {
        transaction_type: 'expense',
        amount: 25000,
        merchant: 'kopi tuku',
        confidence: 95,
        missing_fields: ['category'],
      },
    },
    state.store,
  );

  assert.deepEqual(result, {
    status: 'awaiting_missing_field',
    transactionId: null,
    message: 'Which category should I use?',
    state: {
      nextState: 'record_transaction_state',
      payload: {
        transaction_type: 'expense',
        amount: 25000,
        merchant: 'kopi tuku',
        confidence: 95,
        missing_fields: ['category'],
        pending: true,
      },
    },
  });
  assert.deepEqual(state.calls, [
    {
      method: 'upsertState',
      request: {
        userId: 1,
        stateName: 'record_transaction_state',
        stateData: result.state?.payload,
      },
    },
  ]);
  assert.equal(calls.length, 0);
});

test('rejects missing required transaction fields without saving', async () => {
  const { calls, service } = createService();

  await assert.rejects(
    () =>
      service.handleManualTransaction({
        userId: 1,
        source: 'manual',
        llmResult: {
          amount: 25000,
          merchant: 'kopi tuku',
          category: 'Coffee',
          confidence: 95,
        },
      }),
    BadRequestException,
  );
  assert.equal(calls.length, 0);
});

test('confirms a pending transaction created by manual handle', async () => {
  const { calls, service } = createService([
    [],
    [{ id: 'tx-created' }],
    [
      {
        id: 'tx-created',
        user_id: '1',
        amount: '25000',
        merchant: 'kopi tuku',
        merchant_normalized: 'kopi tuku',
        category: 'Coffee',
        status: 'pending',
      },
    ],
    [],
  ]);

  const handleResult = await service.handleManualTransaction({
    userId: 1,
    source: 'manual',
    llmResult: {
      transaction_type: 'expense',
      amount: 25000,
      merchant: 'kopi tuku',
      category: 'Coffee',
      confidence: 75,
    },
  });
  const confirmResult = await service.confirmTransaction({
    transactionId: handleResult.transactionId ?? '',
    userId: '1',
  });

  assert.equal(handleResult.status, 'pending');
  assert.equal(confirmResult.status, 'confirmed');
  assert.deepEqual(calls[3].values, ['confirmed', 'tx-created', '1']);
  assert.match(calls[3].text, /UPDATE transactions/);
});

test('builds confirmation payload for normal pending transaction', () => {
  const { service } = createService();

  const result = service.buildConfirmationPayload({
    pendingTransactionId: 'pending-1',
    transactionId: 'tx-1',
    userId: 'user-1',
    transactionType: 'expense',
    amount: 50000,
    merchant: 'gopay',
    merchantNormalized: 'GoPay',
    category: 'Transport',
    wallet: 'BCA',
    notes: 'QRIS payment',
    transactionDate: '2026-06-17T10:00:00.000Z',
    source: 'email',
    confidence: 95,
    warnings: [],
  });

  assert.equal(
    result.text,
    '<b>Confirm transaction</b>\n\nType: Expense\nAmount: Rp50.000\nMerchant: GoPay\nCategory: Transport\nWallet: BCA\nNotes: QRIS payment',
  );
  assert.equal(result.parseMode, 'HTML');
  assert.deepEqual(result.replyMarkup.inline_keyboard, [
    [
      { text: 'Save', callback_data: 'save_transaction:tx-1' },
      { text: 'Change Category', callback_data: 'change_categories:tx-1' },
    ],
    [{ text: 'Cancel', callback_data: 'cancel_transaction:tx-1' }],
  ]);
  assert.equal(
    result.replyMarkup.inline_keyboard
      .flat()
      .some((button) => button.callback_data.startsWith('tx_')),
    false,
  );
  assert.deepEqual(result.summary, {
    amount: 50000,
    merchant: 'GoPay',
    category: 'Transport',
    wallet: 'BCA',
    notes: 'QRIS payment',
  });
  assert.deepEqual(result.warnings, []);
});

test('builds readable confirmation payload without pendingTransactionId', () => {
  const { service } = createService();

  const result = service.buildConfirmationPayload({
    userId: 'user-1',
    transactionType: 'expense',
    amount: 50000,
    merchant: 'gopay',
    category: 'Transport',
    transactionDate: '2026-06-17T10:00:00.000Z',
    source: 'manual',
  });

  assert.equal(
    result.text,
    'Confirm transaction\n\nType: Expense\nAmount: Rp50.000\nMerchant: gopay\nCategory: Transport\nWallet: -\nNotes: -\n\nWarnings:\n- callbacks require transactionId',
  );
  assert.equal(result.parseMode, null);
  assert.deepEqual(result.replyMarkup.inline_keyboard, []);
  assert.deepEqual(result.warnings, ['callbacks require transactionId']);
});

test('builds experimental tx callbacks only in experimental mode', () => {
  const { service } = createService();

  const result = service.buildConfirmationPayload({
    pendingTransactionId: 'pending-1',
    callbackMode: 'experimental',
    format: 'plain',
    userId: 'user-1',
    transactionType: 'expense',
    amount: 50000,
    merchant: 'gopay',
    category: 'Transport',
    transactionDate: '2026-06-17T10:00:00.000Z',
    source: 'manual',
  });

  assert.deepEqual(result.replyMarkup.inline_keyboard, [
    [
      { text: 'Approve', callback_data: 'tx_confirm:pending-1' },
      { text: 'Change Category', callback_data: 'tx_category:pending-1' },
    ],
    [{ text: 'Reject', callback_data: 'tx_reject:pending-1' }],
  ]);
  assert.deepEqual(result.warnings, []);
});

test('includes low confidence transaction in confirmation text', () => {
  const { service } = createService();

  const result = service.buildConfirmationPayload({
    pendingTransactionId: 'pending-1',
    transactionId: 'tx-1',
    userId: 'user-1',
    transactionType: 'expense',
    amount: 50000,
    merchant: 'gopay',
    category: 'Transport',
    transactionDate: '2026-06-17T10:00:00.000Z',
    source: 'manual',
    confidence: 45,
  });

  assert.equal(
    result.text,
    'Confirm transaction\n\nType: Expense\nAmount: Rp50.000\nMerchant: gopay\nCategory: Transport\nWallet: -\nNotes: -',
  );
});

test('builds income confirmation payload', () => {
  const { service } = createService();

  const result = service.buildConfirmationPayload({
    pendingTransactionId: 'pending-income',
    userId: 'user-1',
    transactionType: 'income',
    amount: 2500000,
    merchant: 'Payroll',
    category: 'Salary',
    transactionDate: '2026-06-17T10:00:00.000Z',
    source: 'manual',
  });

  assert.match(result.text, /Type: Income/);
  assert.match(result.text, /Amount: Rp2\.500\.000/);
  assert.equal(result.summary.category, 'Salary');
  assert.equal(result.summary.wallet, '-');
  assert.equal(result.summary.notes, '-');
});

test('builds expense confirmation payload', () => {
  const { service } = createService();

  const result = service.buildConfirmationPayload({
    pendingTransactionId: 'pending-expense',
    userId: 'user-1',
    transactionType: 'expense',
    amount: 125000,
    merchant: 'Coffee Shop',
    category: 'Food',
    transactionDate: '2026-06-17T10:00:00.000Z',
    source: 'manual',
  });

  assert.match(result.text, /Type: Expense/);
  assert.match(result.text, /Category: Food/);
  assert.equal(result.summary.amount, 125000);
});

test('builds manual confirmation payload snapshot with wallet and notes', () => {
  const { service } = createService();

  const result = service.buildConfirmationPayload({
    transactionId: 'tx-manual',
    userId: 'user-1',
    transactionType: 'expense',
    amount: 75000,
    merchant: 'Coffee Shop',
    category: 'Food',
    wallet: 'Cash',
    notes: 'Latte and breakfast',
    transactionDate: '2026-06-17T10:00:00.000Z',
    source: 'manual',
  });

  assert.equal(
    result.text,
    'Confirm transaction\n\nType: Expense\nAmount: Rp75.000\nMerchant: Coffee Shop\nCategory: Food\nWallet: Cash\nNotes: Latte and breakfast',
  );
  assert.equal(result.parseMode, null);
  assert.deepEqual(result.replyMarkup.inline_keyboard, [
    [
      { text: 'Save', callback_data: 'save_transaction:tx-manual' },
      {
        text: 'Change Category',
        callback_data: 'change_categories:tx-manual',
      },
    ],
    [{ text: 'Cancel', callback_data: 'cancel_transaction:tx-manual' }],
  ]);
});

test('builds email confirmation payload snapshot with escaped HTML', () => {
  const { service } = createService();

  const result = service.buildConfirmationPayload({
    transactionId: 'tx-email',
    userId: 'user-1',
    transactionType: 'expense',
    amount: 125000,
    merchant: 'R&D <Cafe>',
    category: 'Food',
    wallet: 'BCA & QRIS',
    notes: 'Lunch <team>',
    transactionDate: '2026-06-17T10:00:00.000Z',
    source: 'email',
  });

  assert.equal(
    result.text,
    '<b>Confirm transaction</b>\n\nType: Expense\nAmount: Rp125.000\nMerchant: R&amp;D &lt;Cafe&gt;\nCategory: Food\nWallet: BCA &amp; QRIS\nNotes: Lunch &lt;team&gt;',
  );
  assert.equal(result.parseMode, 'HTML');
});

test('displays normalization warnings in confirmation text', () => {
  const { service } = createService();

  const result = service.buildConfirmationPayload({
    pendingTransactionId: 'pending-warning',
    transactionId: 'tx-warning',
    userId: 'user-1',
    transactionType: 'income',
    amount: 10000,
    merchant: 'Bank Promo',
    category: 'Rewards',
    transactionDate: '2026-06-17T10:00:00.000Z',
    source: 'manual',
    warnings: ['refund/cashback input mapped to income'],
  });

  assert.match(result.text, /Warnings:/);
  assert.match(result.text, /- refund\/cashback input mapped to income/);
  assert.deepEqual(result.warnings, ['refund/cashback input mapped to income']);
});

test('confirms a pending transaction row', async () => {
  const { calls, service } = createService([
    [
      {
        id: 'tx-1',
        user_id: 'user-1',
        amount: '50000',
        merchant: 'gopay',
        merchant_normalized: 'GoPay',
        category: 'Transport',
        status: 'pending',
      },
    ],
    [],
  ]);

  const result = await service.confirmTransaction({
    transactionId: 'tx-1',
    userId: 'user-1',
  });

  assert.deepEqual(result, {
    status: 'confirmed',
    transactionId: 'tx-1',
    userId: 'user-1',
    summary: {
      amount: 50000,
      merchant: 'GoPay',
      category: 'Transport',
    },
    editMessage: {
      text: 'Transaction tx-1 confirmed: GoPay 50000',
      parseMode: null,
    },
  });
  assert.deepEqual(calls[0].values, ['tx-1', 'user-1']);
  assert.match(calls[0].text, /FROM transactions/);
  assert.match(calls[1].text, /UPDATE transactions/);
  assert.match(calls[1].text, /updated_at = now\(\)/);
  assert.deepEqual(calls[1].values, ['confirmed', 'tx-1', 'user-1']);
});

test('cancels a pending transaction row', async () => {
  const { calls, service } = createService([
    [
      {
        id: 'tx-1',
        user_id: 'user-1',
        amount: '50000',
        merchant: 'gopay',
        merchant_normalized: 'GoPay',
        category: 'Transport',
        status: 'pending',
      },
    ],
    [],
  ]);

  const result = await service.cancelTransaction({
    transactionId: 'tx-1',
    userId: 'user-1',
  });

  assert.equal(result.status, 'rejected');
  assert.deepEqual(result.summary, {
    amount: 50000,
    merchant: 'GoPay',
    category: 'Transport',
  });
  assert.deepEqual(result.editMessage, {
    text: 'Transaction tx-1 cancelled.',
    parseMode: null,
  });
  assert.match(calls[1].text, /UPDATE transactions/);
  assert.deepEqual(calls[1].values, ['rejected', 'tx-1', 'user-1']);
});

test('returns already_confirmed without updating transaction row', async () => {
  const { calls, service } = createService([
    [
      {
        id: 'tx-1',
        user_id: 'user-1',
        amount: '50000',
        merchant: 'gopay',
        merchant_normalized: 'GoPay',
        category: 'Transport',
        status: 'confirmed',
      },
    ],
  ]);

  const result = await service.confirmTransaction({
    transactionId: 'tx-1',
    userId: 'user-1',
  });

  assert.equal(result.status, 'already_confirmed');
  assert.equal(calls.length, 1);
});

test('returns already_rejected without updating transaction row', async () => {
  const { calls, service } = createService([
    [
      {
        id: 'tx-1',
        user_id: 'user-1',
        amount: '50000',
        merchant: 'gopay',
        merchant_normalized: 'GoPay',
        category: 'Transport',
        status: 'rejected',
      },
    ],
  ]);

  const result = await service.cancelTransaction({
    transactionId: 'tx-1',
    userId: 'user-1',
  });

  assert.equal(result.status, 'already_rejected');
  assert.equal(calls.length, 1);
});

test('returns not_found when transaction row does not exist', async () => {
  const { calls, service } = createService([[]]);

  const result = await service.confirmTransaction({
    transactionId: 'missing',
    userId: 'user-1',
  });

  assert.deepEqual(result, {
    status: 'not_found',
    transactionId: 'missing',
    userId: 'user-1',
    summary: null,
    editMessage: null,
  });
  assert.equal(calls.length, 1);
});

test('returns not_found for transaction owned by a different user', async () => {
  const { calls, service } = createService([[]]);

  const result = await service.confirmTransaction({
    transactionId: 'tx-1',
    userId: 'user-2',
  });

  assert.deepEqual(result, {
    status: 'not_found',
    transactionId: 'tx-1',
    userId: 'user-2',
    summary: null,
    editMessage: null,
  });
  assert.deepEqual(calls[0].values, ['tx-1', 'user-2']);
  assert.match(calls[0].text, /AND user_id::text = \$2/);
  assert.equal(calls.length, 1);
});

test('builds category options for pending transaction', async () => {
  const { service } = createService([
    [transaction],
    [pendingTransaction],
    budgetCategoryRows,
  ]);

  const result = await service.buildCategoryOptions({
    pendingTransactionId: 'pending-1',
    transactionId: 'tx-1',
    userId: 'user-1',
  });

  assert.equal(result.status, 'ok');
  assert.match(result.text ?? '', /Choose transaction category/);
  assert.match(result.text ?? '', /Merchant: GoPay/);
  assert.equal(result.replyMarkup?.inline_keyboard.length, 9);
});

test('returns not_found for missing category options pending transaction', async () => {
  const { service } = createService([[]]);

  const result = await service.buildCategoryOptions({
    pendingTransactionId: 'missing',
    userId: 'user-1',
  });

  assert.deepEqual(result, {
    status: 'not_found',
    pendingTransactionId: 'missing',
    text: null,
    replyMarkup: null,
  });
});

test('returns already_resolved for category options resolved transaction', async () => {
  const { service } = createService([
    [{ ...pendingTransaction, resolved: true }],
  ]);

  const result = await service.buildCategoryOptions({
    pendingTransactionId: 'pending-1',
    userId: 'user-1',
  });

  assert.deepEqual(result, {
    status: 'already_resolved',
    pendingTransactionId: 'pending-1',
    text: null,
    replyMarkup: null,
  });
});

test('rejects invalid category selection', async () => {
  const { service } = createService();

  await assert.rejects(
    () =>
      service.setPendingTransactionCategory({
        pendingTransactionId: 'pending-1',
        userId: 'user-1',
        category: 'Travel',
      }),
    BadRequestException,
  );
});

test('sets pending transaction category and returns confirmation payload', async () => {
  const { calls, service } = createService([[pendingTransaction], []]);

  const result = await service.setPendingTransactionCategory({
    pendingTransactionId: 'pending-1',
    userId: 'user-1',
    category: 'Food',
  });

  assert.equal(result.status, 'updated');
  assert.equal(result.confirmationPayload?.summary.category, 'Food');
  assert.match(result.confirmationPayload?.text ?? '', /Category: Food/);
  assert.deepEqual(calls[1].values, ['Food', 'pending-1', 'user-1']);
  assert.match(calls[1].text, /UPDATE pending_transactions/);
  assert.match(calls[1].text, /category_suggested/);
});

test('formats production category callback data with budget and transaction ids', async () => {
  const { service } = createService([
    [transaction],
    [pendingTransaction],
    budgetCategoryRows,
  ]);

  const result = await service.buildCategoryOptions({
    pendingTransactionId: 'pending-1',
    transactionId: 'tx-1',
    userId: 'user-1',
  });

  const buttons = result.replyMarkup?.inline_keyboard.flat() ?? [];

  assert.deepEqual(
    buttons.map((button) => button.callback_data),
    [
      'catid:budget-food:tx-1',
      'catid:budget-transport:tx-1',
      'catid:budget-groceries:tx-1',
      'catid:budget-bills:tx-1',
      'catid:budget-health:tx-1',
      'catid:budget-shopping:tx-1',
      'catid:budget-entertainment:tx-1',
      'catid:budget-transfer:tx-1',
      'catid:budget-other:tx-1',
    ],
  );
  assert.equal(
    buttons.some((button) => button.callback_data.startsWith('tx_')),
    false,
  );
});

test('builds production category options from custom leaf budgets', async () => {
  const { calls, service } = createService([
    [transaction],
    [pendingTransaction],
    [
      {
        id: 'budget-dining',
        category: 'Dining Out With A Very Long Name',
        parent_category: 'Food',
      },
      { id: 'budget-meds', category: 'Medicine', parent_category: 'Health' },
    ],
  ]);

  const result = await service.buildCategoryOptions({
    pendingTransactionId: 'pending-1',
    transactionId: 'tx-1',
    userId: 'user-1',
  });

  const buttons = result.replyMarkup?.inline_keyboard.flat() ?? [];

  assert.deepEqual(
    buttons.map((button) => button.callback_data),
    ['catid:budget-dining:tx-1', 'catid:budget-meds:tx-1'],
  );
  assert.equal(buttons[0].text.length, 32);
  assert.equal(buttons[0].text, 'Food / Dining Out With A Very...');
  assert.equal(buttons[1].text, 'Health / Medicine');
  assert.match(calls[2].text, /NOT EXISTS/);
  assert.match(calls[2].text, /active_child\.parent_budget_id = child\.id/);
});

test('falls back to production default categories when user has no active leaf budgets', async () => {
  const { service } = createService([[transaction], [pendingTransaction], []]);

  const result = await service.buildCategoryOptions({
    pendingTransactionId: 'pending-1',
    transactionId: 'tx-1',
    userId: 'user-1',
  });

  const buttons = result.replyMarkup?.inline_keyboard.flat() ?? [];

  assert.deepEqual(
    buttons.map((button) => button.text),
    [
      'Food',
      'Transport',
      'Groceries',
      'Bills',
      'Health & Beauty',
      'Shopping',
      'Entertainment',
      'Transfer',
      'Other',
    ],
  );
});

test('rejects category selection with unauthorized budget id', async () => {
  const { service } = createService([[transaction], []]);

  const result = await service.setPendingTransactionCategory({
    transactionId: 'tx-1',
    budgetId: 'budget-other-user',
    userId: 'user-1',
  });

  assert.equal(result.status, 'unauthorized_budget');
  assert.equal(result.transactionId, 'tx-1');
  assert.equal(result.editMessage, null);
});

test('sets transaction category and confirms on production category selection', async () => {
  const { calls, service } = createService([
    [transaction],
    [{ id: 'budget-food', category: 'Food', parent_category: null }],
    [],
  ]);

  const result = await service.setPendingTransactionCategory({
    transactionId: 'tx-1',
    budgetId: 'budget-food',
    userId: 'user-1',
  });

  assert.equal(result.status, 'updated');
  assert.equal(result.transactionId, 'tx-1');
  assert.equal(result.summary?.category, 'Food');
  assert.equal(
    result.editMessage?.text,
    'Transaction tx-1 confirmed: GoPay 50000',
  );
  assert.deepEqual(calls[2].values, ['Food', 'tx-1', 'user-1']);
  assert.match(calls[2].text, /UPDATE transactions/);
  assert.match(calls[2].text, /status = 'confirmed'/);
});

test('handles save_transaction callback with Telegram edit payload', async () => {
  const { calls, service } = createService([
    [{ ...transaction, id: '123', user_id: '1' }],
    [],
  ]);

  const result = await service.handleTransactionCallback({
    telegramUserId: '976684739',
    userId: 1,
    callbackData: 'save_transaction:123',
    chatId: 'chat-1',
    messageId: 42,
  });

  assert.equal(result.status, 'ok');
  assert.equal(result.action, 'save_transaction');
  assert.equal(result.transactionId, 123);
  assert.deepEqual(result.telegram, {
    method: 'editMessageText',
    chat_id: 'chat-1',
    message_id: 42,
    text: 'Transaction 123 confirmed: GoPay 50000',
    parse_mode: 'HTML',
    reply_markup: null,
  });
  assert.deepEqual(calls[0].values, ['123', '1']);
  assert.deepEqual(calls[1].values, ['confirmed', '123', '1']);
});

test('handles cancel_transaction callback with Telegram edit payload', async () => {
  const { calls, service } = createService([
    [{ ...transaction, id: '123', user_id: '1' }],
    [],
  ]);

  const result = await service.handleTransactionCallback({
    telegramUserId: '976684739',
    userId: 1,
    callbackData: 'cancel_transaction:123',
  });

  assert.equal(result.status, 'ok');
  assert.equal(result.action, 'cancel_transaction');
  assert.equal(result.transactionId, 123);
  assert.deepEqual(result.telegram, {
    method: 'editMessageText',
    text: 'Transaction 123 cancelled.',
    parse_mode: 'HTML',
    reply_markup: null,
  });
  assert.deepEqual(calls[1].values, ['rejected', '123', '1']);
});

test('handles change_categories callback with category buttons', async () => {
  const { service } = createService([
    [{ ...transaction, id: '123', user_id: '1' }],
    [
      { id: '10', category: 'Food', parent_category: null },
      { id: '11', category: 'Transport', parent_category: null },
    ],
  ]);

  const result = await service.handleTransactionCallback({
    telegramUserId: '976684739',
    userId: 1,
    callbackData: 'change_categories:123',
  });

  assert.equal(result.status, 'ok');
  assert.equal(result.action, 'change_categories');
  assert.equal(result.transactionId, 123);
  assert.match(result.telegram.text, /Choose transaction category/);
  assert.deepEqual(result.telegram.reply_markup, {
    inline_keyboard: [
      [{ text: 'Food', callback_data: 'catid:10:123' }],
      [{ text: 'Transport', callback_data: 'catid:11:123' }],
    ],
  });
});

test('handles catid callback by setting category and confirming transaction', async () => {
  const { calls, service } = createService([
    [{ ...transaction, id: '123', user_id: '1' }],
    [{ id: '10', category: 'Food', parent_category: null }],
    [],
  ]);

  const result = await service.handleTransactionCallback({
    telegramUserId: '976684739',
    userId: 1,
    callbackData: 'catid:10:123',
  });

  assert.equal(result.status, 'ok');
  assert.equal(result.action, 'catid');
  assert.equal(result.transactionId, 123);
  assert.equal(result.telegram.text, 'Transaction 123 confirmed: GoPay 50000');
  assert.equal(result.telegram.reply_markup, null);
  assert.deepEqual(calls[2].values, ['Food', '123', '1']);
});

test('returns safe error payload for invalid transaction callback data', async () => {
  const { calls, service } = createService();

  const result = await service.handleTransactionCallback({
    telegramUserId: '976684739',
    userId: 1,
    callbackData: 'save_transaction:not-a-number',
    chatId: 1001,
    messageId: 7,
  });

  assert.deepEqual(result, {
    status: 'error',
    action: 'save_transaction',
    transactionId: undefined,
    telegram: {
      method: 'editMessageText',
      chat_id: 1001,
      message_id: 7,
      text: 'Invalid transaction callback.',
      parse_mode: 'HTML',
      reply_markup: null,
    },
  });
  assert.equal(calls.length, 0);
});

test('manage returns invalid when telegram user is not found', async () => {
  const { calls, service } = createService([[]]);
  const state = createManageStateStore();

  const result = await service.handleManagedTransaction(
    {
      telegramUserId: '976684739',
      text: 'edit kopi tuku to Food',
      statePayload: {
        state_name: 'confirm_action',
        state_data: { transaction_id: 101 },
      },
      llmResult: {
        intent: 'edit_transaction',
        target: { merchant: 'kopi tuku', period: 'recent' },
        changes: { category: 'Food' },
      },
    },
    state.store,
  );

  assert.equal(result.ok, false);
  assert.equal(result.status, 'invalid');
  assert.equal(state.calls.length, 0);
  assert.equal(calls.length, 1);
});

test('manage callback cancel resets DB state', async () => {
  const { service } = createService([[{ id: '1', telegram_id: '976684739' }]]);
  const state = createManageStateStore({
    stateName: 'select_transaction',
    stateData: { action: 'delete', candidates: [manageTransaction] },
  });

  const result = await service.handleManagedTransaction(
    {
      telegramUserId: '976684739',
      text: 'veyra_tx_manage:cancel',
      llmResult: null,
    },
    state.store,
  );

  assert.equal(result.status, 'cancelled');
  assert.equal(result.reply_markup, null);
  assert.equal(state.state.stateName, 'idle');
  assert.deepEqual(state.calls.at(-1), {
    method: 'resetState',
    request: { userId: '1' },
  });
});

test('manage edit no match resets state and returns not_found', async () => {
  const { calls, service } = createService([
    [{ id: '1', telegram_id: '976684739' }],
    [],
  ]);
  const state = createManageStateStore();

  const result = await service.handleManagedTransaction(
    {
      telegramUserId: '976684739',
      text: 'edit kopi tuku to Food',
      llmResult: {
        intent: 'edit_transaction',
        target: { merchant: 'kopi tuku' },
        changes: { category: 'Food' },
      },
    },
    state.store,
  );

  assert.equal(result.status, 'not_found');
  assert.equal(result.reply_markup, null);
  assert.match(calls[1].text, /FROM transactions/);
  assert.deepEqual(state.calls.at(-1), {
    method: 'resetState',
    request: { userId: '1' },
  });
});

test('manage edit one match creates confirm_action with confirm keyboard', async () => {
  const { service } = createService([
    [{ id: '1', telegram_id: '976684739' }],
    [manageTransaction],
  ]);
  const state = createManageStateStore();

  const result = await service.handleManagedTransaction(
    {
      telegramUserId: '976684739',
      text: 'edit kopi tuku to Food',
      llmResult: {
        intent: 'edit_transaction',
        target: { merchant: 'kopi tuku' },
        changes: { category: 'Food' },
      },
    },
    state.store,
  );

  assert.equal(result.status, 'needs_confirmation');
  assert.equal(state.state.stateName, 'confirm_action');
  assert.equal((state.state.stateData as { action: string }).action, 'edit');
  assert.deepEqual(result.reply_markup?.inline_keyboard, [
    [
      { text: 'Confirm', callback_data: 'veyra_tx_manage:confirm' },
      { text: 'Cancel', callback_data: 'veyra_tx_manage:cancel' },
    ],
  ]);
  assert.match(result.message, /Before:\nKopi Tuku — Others — Rp25\.000/);
  assert.match(result.message, /After:\nKopi Tuku — Food — Rp25\.000/);
});

test('manage edit multiple matches creates select_transaction with candidate keyboard', async () => {
  const { service } = createService([
    [{ id: '1', telegram_id: '976684739' }],
    [manageTransaction, manageTransaction2],
  ]);
  const state = createManageStateStore();

  const result = await service.handleManagedTransaction(
    {
      telegramUserId: '976684739',
      text: 'edit kopi tuku to Food',
      llmResult: {
        intent: 'edit_transaction',
        target: { merchant: 'kopi tuku' },
        changes: { category: 'Food' },
      },
    },
    state.store,
  );

  assert.equal(result.status, 'needs_selection');
  assert.equal(state.state.stateName, 'select_transaction');
  assert.equal(result.reply_markup?.inline_keyboard.length, 3);
  assert.deepEqual(result.reply_markup?.inline_keyboard[0], [
    {
      text: '1. Kopi Tuku — Rp25.000',
      callback_data: 'veyra_tx_manage:select:1',
    },
  ]);
  assert.deepEqual(result.reply_markup?.inline_keyboard[2], [
    { text: 'Cancel', callback_data: 'veyra_tx_manage:cancel' },
  ]);
});

test('manage delete one match creates confirm_action with confirm keyboard', async () => {
  const { service } = createService([
    [{ id: '1', telegram_id: '976684739' }],
    [manageTransaction],
  ]);
  const state = createManageStateStore();

  const result = await service.handleManagedTransaction(
    {
      telegramUserId: '976684739',
      text: 'delete kopi tuku',
      llmResult: {
        intent: 'delete_transaction',
        target: { merchant: 'kopi tuku' },
      },
    },
    state.store,
  );

  assert.equal(result.status, 'needs_confirmation');
  assert.equal((state.state.stateData as { action: string }).action, 'delete');
  assert.match(result.message, /This will mark it as rejected/);
  assert.deepEqual(result.reply_markup?.inline_keyboard[0][0], {
    text: 'Confirm',
    callback_data: 'veyra_tx_manage:confirm',
  });
});

test('manage delete multiple matches creates select_transaction with candidate keyboard', async () => {
  const { service } = createService([
    [{ id: '1', telegram_id: '976684739' }],
    [manageTransaction, manageTransaction2],
  ]);
  const state = createManageStateStore();

  const result = await service.handleManagedTransaction(
    {
      telegramUserId: '976684739',
      text: 'delete kopi tuku',
      llmResult: {
        intent: 'delete_transaction',
        target: { merchant: 'kopi tuku' },
      },
    },
    state.store,
  );

  assert.equal(result.status, 'needs_selection');
  assert.equal(state.state.stateName, 'select_transaction');
  assert.equal((state.state.stateData as { action: string }).action, 'delete');
  assert.equal(
    result.reply_markup?.inline_keyboard[1][0].callback_data,
    'veyra_tx_manage:select:2',
  );
});

test('manage select callback without DB state returns invalid', async () => {
  const { service } = createService([[{ id: '1', telegram_id: '976684739' }]]);
  const state = createManageStateStore();

  const result = await service.handleManagedTransaction(
    {
      telegramUserId: '976684739',
      text: 'veyra_tx_manage:select:1',
      llmResult: null,
    },
    state.store,
  );

  assert.equal(result.status, 'invalid');
  assert.equal(result.reply_markup, null);
  assert.equal(state.state.stateName, 'idle');
});

test('manage confirm callback without DB state returns invalid and clears state', async () => {
  const { service } = createService([[{ id: '1', telegram_id: '976684739' }]]);
  const state = createManageStateStore();

  const result = await service.handleManagedTransaction(
    {
      telegramUserId: '976684739',
      text: 'veyra_tx_manage:confirm',
      llmResult: null,
    },
    state.store,
  );

  assert.equal(result.status, 'invalid');
  assert.deepEqual(state.calls.at(-1), {
    method: 'resetState',
    request: { userId: '1' },
  });
});

test('manage invalid callback selection returns invalid and keeps state', async () => {
  const state = createManageStateStore({
    stateName: 'select_transaction',
    stateData: { action: 'edit', candidates: [manageTransaction] },
  });
  const { service } = createService([[{ id: '1', telegram_id: '976684739' }]]);

  const result = await service.handleManagedTransaction(
    {
      telegramUserId: '976684739',
      text: 'veyra_tx_manage:select:9',
      llmResult: null,
    },
    state.store,
  );

  assert.equal(result.status, 'invalid');
  assert.equal(state.state.stateName, 'select_transaction');
});

test('manage valid callback selection moves to confirm_action', async () => {
  const state = createManageStateStore({
    stateName: 'select_transaction',
    stateData: {
      action: 'edit',
      candidates: [manageTransaction, manageTransaction2],
      changes: { category: 'Food' },
    },
  });
  const { service } = createService([[{ id: '1', telegram_id: '976684739' }]]);

  const result = await service.handleManagedTransaction(
    {
      telegramUserId: '976684739',
      text: 'veyra_tx_manage:select:2',
      llmResult: null,
    },
    state.store,
  );

  assert.equal(result.status, 'needs_confirmation');
  assert.equal(state.state.stateName, 'confirm_action');
  assert.equal(
    (state.state.stateData as { transaction_id: string }).transaction_id,
    '102',
  );
  assert.match(result.message, /Rp27\.000/);
});

test('manage callback confirm without valid DB state cannot mutate', async () => {
  const state = createManageStateStore({
    stateName: 'confirm_action',
    stateData: {
      action: 'edit',
      transaction_id: '101',
      changes: { category: 'Food' },
    },
  });
  const { calls, service } = createService([
    [{ id: '1', telegram_id: '976684739' }],
    [],
  ]);

  const result = await service.handleManagedTransaction(
    {
      telegramUserId: '976684739',
      text: 'veyra_tx_manage:confirm',
      llmResult: null,
    },
    state.store,
  );

  assert.equal(result.status, 'invalid');
  assert.equal(calls.length, 2);
  assert.doesNotMatch(
    calls.map((call) => call.text).join('\n'),
    /UPDATE transactions/,
  );
  assert.equal(state.state.stateName, 'idle');
});

test('manage confirmed edit updates transaction and clears state', async () => {
  const state = createManageStateStore({
    stateName: 'confirm_action',
    stateData: {
      action: 'edit',
      transaction_id: '101',
      before: manageTransaction,
      changes: { category: 'Food' },
    },
  });
  const { calls, service } = createService([
    [{ id: '1', telegram_id: '976684739' }],
    [manageTransaction],
    [],
  ]);

  const result = await service.handleManagedTransaction(
    {
      telegramUserId: '976684739',
      text: 'veyra_tx_manage:confirm',
      llmResult: null,
    },
    state.store,
  );

  assert.equal(result.status, 'completed');
  assert.equal(result.reply_markup, null);
  assert.match(result.message, /Updated\.\n\nKopi Tuku — Food — Rp25\.000/);
  assert.match(calls[2].text, /UPDATE transactions/);
  assert.match(calls[2].text, /category = \$1/);
  assert.deepEqual(calls[2].values, ['Food', '101', '1']);
  assert.equal(state.state.stateName, 'idle');
});

test('manage confirmed delete sets rejected and clears state', async () => {
  const state = createManageStateStore({
    stateName: 'confirm_action',
    stateData: {
      action: 'delete',
      transaction_id: '101',
      before: manageTransaction,
    },
  });
  const { calls, service } = createService([
    [{ id: '1', telegram_id: '976684739' }],
    [manageTransaction],
    [],
  ]);

  const result = await service.handleManagedTransaction(
    {
      telegramUserId: '976684739',
      text: 'veyra_tx_manage:confirm',
      llmResult: null,
    },
    state.store,
  );

  assert.equal(result.status, 'completed');
  assert.match(result.message, /Deleted\./);
  assert.match(calls[2].text, /status = 'rejected'/);
  assert.deepEqual(calls[2].values, ['101', '1']);
  assert.equal(state.state.stateName, 'idle');
});

test('manage request statePayload alone cannot trigger mutation', async () => {
  const { calls, service } = createService([
    [{ id: '1', telegram_id: '976684739' }],
  ]);
  const state = createManageStateStore();

  const result = await service.handleManagedTransaction(
    {
      telegramUserId: '976684739',
      text: 'yes',
      statePayload: {
        state_name: 'confirm_action',
        state_data: { action: 'delete', transaction_id: '101' },
      },
      llmResult: null,
    },
    state.store,
  );

  assert.equal(result.status, 'invalid');
  assert.equal(calls.length, 1);
});

test('manage callback data alone cannot trigger mutation', async () => {
  const { calls, service } = createService([
    [{ id: '1', telegram_id: '976684739' }],
  ]);
  const state = createManageStateStore();

  const result = await service.handleManagedTransaction(
    {
      telegramUserId: '976684739',
      text: 'veyra_tx_manage:confirm',
      llmResult: null,
    },
    state.store,
  );

  assert.equal(result.status, 'invalid');
  assert.equal(calls.length, 1);
});

test('manage normal typed number is not accepted as selection', async () => {
  const state = createManageStateStore({
    stateName: 'select_transaction',
    stateData: { action: 'edit', candidates: [manageTransaction] },
  });
  const { service } = createService([[{ id: '1', telegram_id: '976684739' }]]);

  const result = await service.handleManagedTransaction(
    { telegramUserId: '976684739', text: '1', llmResult: null },
    state.store,
  );

  assert.equal(result.status, 'invalid');
  assert.equal(state.state.stateName, 'select_transaction');
});

test('manage normal typed yes is not accepted as confirmation', async () => {
  const state = createManageStateStore({
    stateName: 'confirm_action',
    stateData: {
      action: 'delete',
      transaction_id: '101',
      before: manageTransaction,
    },
  });
  const { service } = createService([[{ id: '1', telegram_id: '976684739' }]]);

  const result = await service.handleManagedTransaction(
    { telegramUserId: '976684739', text: 'yes', llmResult: null },
    state.store,
  );

  assert.equal(result.status, 'invalid');
  assert.equal(state.state.stateName, 'confirm_action');
});

test('manage cannot edit another user transaction by target id', async () => {
  const { calls, service } = createService([
    [{ id: '1', telegram_id: '976684739' }],
    [],
  ]);
  const state = createManageStateStore();

  const result = await service.handleManagedTransaction(
    {
      telegramUserId: '976684739',
      text: 'edit transaction 999',
      llmResult: {
        intent: 'edit_transaction',
        target: { id: 999 },
        changes: { category: 'Food' },
      },
    },
    state.store,
  );

  assert.equal(result.status, 'not_found');
  assert.match(calls[1].text, /AND id::text = \$2/);
  assert.deepEqual(calls[1].values, ['1', '999']);
});

test('manage expired state resets to idle', async () => {
  const state = createManageStateStore({
    stateName: 'confirm_action',
    stateData: {
      action: 'delete',
      transaction_id: '101',
      before: manageTransaction,
    },
    expiresAt: '2000-01-01T00:00:00.000Z',
  });
  const { service } = createService([[{ id: '1', telegram_id: '976684739' }]]);

  const result = await service.handleManagedTransaction(
    {
      telegramUserId: '976684739',
      text: 'veyra_tx_manage:confirm',
      llmResult: null,
    },
    state.store,
  );

  assert.equal(result.status, 'invalid');
  assert.equal(
    result.message,
    'This edit/delete session expired. Please start again.',
  );
  assert.equal(state.state.stateName, 'idle');
});

test('formats experimental set category callback data only in experimental mode', async () => {
  const { service } = createService([[pendingTransaction]]);

  const result = await service.buildCategoryOptions({
    pendingTransactionId: 'pending-1',
    callbackMode: 'experimental',
    userId: 'user-1',
  });

  const buttons = result.replyMarkup?.inline_keyboard.flat() ?? [];

  assert.deepEqual(
    buttons.map((button) => button.callback_data),
    [
      'tx_set_category:pending-1:food',
      'tx_set_category:pending-1:transport',
      'tx_set_category:pending-1:groceries',
      'tx_set_category:pending-1:bills',
      'tx_set_category:pending-1:health_and_beauty',
      'tx_set_category:pending-1:shopping',
      'tx_set_category:pending-1:entertainment',
      'tx_set_category:pending-1:transfer',
      'tx_set_category:pending-1:other',
    ],
  );
});

test('resolves high confidence email review as confirmed with canonical category', async () => {
  const { calls, service } = createService([
    [{ id: '1', telegram_id: '976684739' }],
    [{ category: 'Food' }],
    [{ id: 'tx-review' }],
    [],
    [],
    [],
    [],
  ]);

  const result = await service.resolveEmailTransactionReview({
    telegramUserId: '976684739',
    reviewToken: 'review-1',
    transactionCandidate: {
      source: 'email',
      bank: 'bca',
      transactionType: 'expense',
      amount: 25000,
      merchant: 'TUKU',
      merchantNormalized: 'tuku',
      transactionDate: '2026-06-25T00:00:00+07:00',
      description: 'BCA Credit Card transaction',
      rawPayload: { emailId: 'email-1' },
    },
    resolution: {
      category: 'food',
      confidence: 0.86,
      resolver: 'llm',
    },
  });

  assert.equal(result.status, 'confirmed');
  assert.equal(result.transaction?.status, 'confirmed');
  assert.equal(result.transaction?.category, 'Food');
  assert.equal(result.transaction?.confidence, 86);
  assert.match(result.telegramText ?? '', /Transaction recorded/);
  assert.match(calls[1].text, /FROM budgets/);
  assert.match(calls[1].text, /lower\(category\) = lower\(\$2\)/);
  assert.deepEqual(calls[1].values, ['1', 'food']);
  assert.match(calls[2].text, /INSERT INTO transactions/);
  assert.deepEqual(calls[2].values, [
    '1',
    'expense',
    25000,
    'TUKU',
    'tuku',
    'Food',
    '2026-06-24T17:00:00.000Z',
    'BCA Credit Card transaction',
    'confirmed',
    86,
    { emailId: 'email-1' },
  ]);
  assert.match(calls[3].text, /FROM merchant_aliases/);
  assert.match(calls[4].text, /INSERT INTO merchant_aliases/);
  assert.deepEqual(calls[4].values, ['1', 'TUKU', 'tuku']);
  assert.match(calls[5].text, /FROM category_rules/);
  assert.match(calls[6].text, /INSERT INTO category_rules/);
  assert.deepEqual(calls[6].values, ['1', 'tuku', 'Food']);
});

test('resolves medium confidence email review as pending with production actions', async () => {
  const { calls, service } = createService([
    [{ id: '1', telegram_id: '976684739' }],
    [{ category: 'Food' }],
    [{ id: '123' }],
  ]);

  const result = await service.resolveEmailTransactionReview({
    telegramUserId: '976684739',
    transactionCandidate: {
      source: 'email',
      bank: 'bca',
      transactionType: 'expense',
      amount: 25000,
      merchant: 'TUKU',
      merchantNormalized: 'tuku',
      transactionDate: '2026-06-25T00:00:00+07:00',
      rawPayload: {},
    },
    resolution: {
      category: 'Food',
      confidence: 84,
      resolver: 'llm',
    },
  });

  assert.equal(result.status, 'pending');
  assert.equal(result.transaction?.status, 'pending');
  assert.equal(result.actions?.confirm.action, 'save_transaction');
  assert.equal(result.actions?.confirm.transactionId, '123');
  assert.equal(result.actions?.cancel.action, 'cancel_transaction');
  assert.equal(result.actions?.changeCategory.action, 'change_categories');
  assert.deepEqual(result.replyMarkup?.inline_keyboard, [
    [
      { text: 'Save', callback_data: 'save_transaction:123' },
      { text: 'Change Category', callback_data: 'change_categories:123' },
    ],
    [{ text: 'Cancel', callback_data: 'cancel_transaction:123' }],
  ]);
  assert.equal(calls[2].values[8], 'pending');
  assert.equal(calls[2].values[9], 84);
  assert.equal(
    calls.some((call) => /merchant_aliases|category_rules/.test(call.text)),
    false,
  );
});

test('resolves low confidence email review as pending with LLM category', async () => {
  const { calls, service } = createService([
    [{ id: '1', telegram_id: '976684739' }],
    [{ category: 'Food' }],
    [{ id: '123' }],
  ]);

  const result = await service.resolveEmailTransactionReview({
    telegramUserId: '976684739',
    transactionCandidate: {
      source: 'email',
      transactionType: 'expense',
      amount: 25000,
      merchant: 'TUKU',
      merchantNormalized: 'tuku',
      rawPayload: {},
    },
    resolution: {
      category: 'Food',
      confidence: 0.74,
      resolver: 'llm',
    },
  });

  assert.equal(result.status, 'pending');
  assert.equal(result.reason, undefined);
  assert.equal(result.transaction?.status, 'pending');
  assert.equal(result.transaction?.category, 'Food');
  assert.equal(result.transaction?.confidence, 74);
  assert.equal(result.actions?.confirm.transactionId, '123');
  assert.equal(result.replyMarkup?.inline_keyboard[0][0].text, 'Save');
  assert.equal(calls[2].values[8], 'pending');
  assert.equal(calls[2].values[9], 74);
});

test('resolves low confidence email review with unknown LLM category as pending', async () => {
  const { calls, service } = createService([
    [{ id: '1', telegram_id: '976684739' }],
    [],
    [{ id: '123' }],
  ]);

  const result = await service.resolveEmailTransactionReview({
    telegramUserId: '976684739',
    transactionCandidate: {
      source: 'email',
      transactionType: 'expense',
      amount: 25000,
      merchant: 'TUKU',
      merchantNormalized: 'tuku',
      rawPayload: {},
    },
    resolution: {
      category: 'LLM Made Category',
      confidence: 0.74,
      resolver: 'llm',
    },
  });

  assert.equal(result.status, 'pending');
  assert.equal(result.transaction?.category, 'LLM Made Category');
  assert.equal(calls[2].values[5], 'LLM Made Category');
  assert.equal(calls[2].values[8], 'pending');
});

test('returns needs_review when email review category is not in budgets', async () => {
  const { calls, service } = createService([
    [{ id: '1', telegram_id: '976684739' }],
    [],
  ]);

  const result = await service.resolveEmailTransactionReview({
    telegramUserId: '976684739',
    transactionCandidate: {
      source: 'email',
      transactionType: 'expense',
      amount: 25000,
      merchant: 'TUKU',
      merchantNormalized: 'tuku',
      rawPayload: {},
    },
    resolution: {
      category: 'LLM Made Category',
      confidence: 95,
      resolver: 'llm',
    },
  });

  assert.deepEqual(result, {
    status: 'needs_review',
    reason: 'category_not_found',
    message: 'Category was not found in user budgets.',
    transactionCandidate: {
      source: 'email',
      transactionType: 'expense',
      amount: 25000,
      merchant: 'TUKU',
      merchantNormalized: 'tuku',
      rawPayload: {},
    },
    resolution: {
      category: 'LLM Made Category',
      confidence: 95,
      resolver: 'llm',
    },
  });
  assert.match(calls[1].text, /FROM budgets/);
  assert.equal(calls.length, 2);
});

test('returns safe email review response when telegram user is not found', async () => {
  const { calls, service } = createService([[]]);

  const result = await service.resolveEmailTransactionReview({
    telegramUserId: '976684739',
    transactionCandidate: {
      source: 'email',
      transactionType: 'expense',
      amount: 25000,
      merchant: 'TUKU',
      rawPayload: {},
    },
    resolution: {
      category: 'Food',
      confidence: 95,
    },
  });

  assert.equal(result.status, 'needs_review');
  assert.equal(result.reason, 'user_not_found');
  assert.equal(result.message, 'Telegram user was not found.');
  assert.match(calls[0].text, /FROM telegram_users/);
  assert.equal(calls.length, 1);
});

test('rejects invalid email review source', async () => {
  const { service } = createService([[{ id: '1', telegram_id: '976684739' }]]);

  await assert.rejects(
    () =>
      service.resolveEmailTransactionReview({
        telegramUserId: '976684739',
        transactionCandidate: {
          source: 'manual',
          transactionType: 'expense',
          amount: 25000,
          merchant: 'TUKU',
          rawPayload: {},
        },
        resolution: {
          category: 'Food',
          confidence: 95,
        },
      }),
    BadRequestException,
  );
});

test('rejects invalid email review amount', async () => {
  const { service } = createService([[{ id: '1', telegram_id: '976684739' }]]);

  await assert.rejects(
    () =>
      service.resolveEmailTransactionReview({
        telegramUserId: '976684739',
        transactionCandidate: {
          source: 'email',
          transactionType: 'expense',
          amount: 0,
          merchant: 'TUKU',
          rawPayload: {},
        },
        resolution: {
          category: 'Food',
          confidence: 95,
        },
      }),
    BadRequestException,
  );
});

test('handles confirmed Krom QRIS email with category rule', async () => {
  const { calls, service } = createService([
    [],
    [{ canonical_name: 'Kopi Tuku Canonical' }],
    [{ category: 'Food' }],
    [{ id: 'import-1' }],
    [{ id: 'tx-email' }],
    [],
    [],
  ]);

  const result = await service.handleEmailTransaction({
    telegramUserId: '976684739',
    userId: 1,
    source: 'email',
    email: {
      messageId: 'gmail-qris',
      threadId: 'thread-qris',
      from: 'no-reply@krom.id',
      subject: 'Transaksi QRIS berhasil',
      date: '2026-06-22T10:00:00+07:00',
      emailText:
        'Transaksi QRIS berhasil. Merchant: Kopi Tuku Jumlah: Rp25.000',
    },
  });

  assert.equal(result.status, 'confirmed');
  assert.equal(result.provider, 'Krom');
  assert.equal(result.templateKey, 'krom-qris-payment');
  assert.equal(result.transaction?.id, 'tx-email');
  assert.equal(result.transaction?.category, 'Food');
  assert.equal(result.transaction?.merchant, 'Kopi Tuku');
  assert.equal(result.transaction?.merchantNormalized, 'Kopi Tuku Canonical');
  assert.match(result.telegram.text, /Merchant: Kopi Tuku Canonical/);
  assert.equal(calls.length, 7);
  assert.match(calls[2].text, /FROM category_rules/);
  assert.deepEqual(calls[2].values, ['1', 'Kopi Tuku Canonical', 'Kopi Tuku']);
  assert.match(calls[4].text, /INSERT INTO transactions/);
  assert.deepEqual(calls[4].values.slice(0, 8), [
    '1',
    'expense',
    25000,
    'Kopi Tuku',
    'Kopi Tuku Canonical',
    'Food',
    '2026-06-22T03:00:00.000Z',
    97,
  ]);
});

test('returns needs_review for BCA known template without category', async () => {
  const { calls, service } = createService([
    [],
    [{ canonical_name: 'Toko Buku' }],
    [],
    [{ id: 'import-review' }],
    [],
  ]);

  const result = await service.handleEmailTransaction({
    telegramUserId: '976684739',
    userId: 1,
    source: 'email',
    email: {
      messageId: 'gmail-bca',
      from: 'card@bca.co.id',
      subject: 'Notifikasi Transaksi',
      date: '2026-06-22T10:00:00+07:00',
      emailText:
        'Notifikasi Transaksi Merchant/ATM TOKO BUKU Jenis Transaksi Pembelian Sejumlah Rp123.456',
    },
  });

  assert.equal(result.status, 'needs_review');
  assert.equal(result.provider, 'BCA');
  assert.equal(result.reason, 'category could not be resolved');
  assert.equal(result.transaction, undefined);
  assert.match(calls[3].text, /INSERT INTO transaction_imports/);
  assert.match(calls[4].text, /INSERT INTO email_parse_attempts/);
});

test('returns needs_review for known email when merchant alias is missing', async () => {
  const { calls, service } = createService([
    [],
    [],
    [{ id: 'import-alias-review' }],
    [],
  ]);

  const result = await service.handleEmailTransaction({
    telegramUserId: '976684739',
    userId: 1,
    source: 'email',
    email: {
      messageId: 'gmail-bca-missing-alias',
      from: 'card@bca.co.id',
      subject: 'Notifikasi Transaksi',
      date: '2026-06-25T00:05:42+07:00',
      emailText:
        'Notifikasi Transaksi Merchant / ATM SHOPEE.CO.ID Jenis Transaksi E-COMMERCE Sejumlah : Rp243.000,00',
    },
  });

  assert.equal(result.status, 'needs_review');
  assert.equal(result.provider, 'BCA');
  assert.equal(result.reason, 'merchant alias could not be resolved');
  assert.equal(result.transaction, undefined);
  assert.equal(result.parsed?.merchant, 'SHOPEE.CO.ID');
  assert.match(result.telegram.text, /Merchant: SHOPEE\.CO\.ID/);
  assert.equal(calls.length, 4);
  assert.match(calls[1].text, /FROM merchant_aliases/);
  assert.doesNotMatch(calls[2].text, /FROM category_rules/);
  assert.match(calls[2].text, /INSERT INTO transaction_imports/);
  assert.match(calls[3].text, /INSERT INTO email_parse_attempts/);
});

test('returns unsupported_template for Mandiri non e-money email', async () => {
  const { calls, service } = createService([
    [],
    [{ id: 'import-mandiri' }],
    [],
  ]);

  const result = await service.handleEmailTransaction({
    telegramUserId: '976684739',
    userId: 1,
    source: 'email',
    email: {
      messageId: 'gmail-mandiri',
      from: 'bankmandiri@bankmandiri.co.id',
      subject: 'Mandiri Transaction',
      date: '2026-06-22T10:00:00+07:00',
      emailText: 'Mandiri Transaction berhasil sebesar Rp50.000',
    },
  });

  assert.equal(result.status, 'unsupported_template');
  assert.equal(result.provider, 'Mandiri');
  assert.equal(result.templateKey, null);
  assert.equal(calls.length, 3);
});

test('returns duplicate for existing Gmail message import', async () => {
  const { calls, service } = createService([
    [
      {
        id: 'import-existing',
        transaction_id: 'tx-existing',
        status: 'confirmed',
      },
    ],
  ]);

  const result = await service.handleEmailTransaction({
    telegramUserId: '976684739',
    userId: 1,
    source: 'email',
    email: {
      messageId: 'gmail-existing',
      from: 'no-reply@krom.id',
      subject: 'Transaksi QRIS berhasil',
      date: '2026-06-22T10:00:00+07:00',
      emailText:
        'Transaksi QRIS berhasil. Merchant: Kopi Tuku Jumlah: Rp25.000',
    },
  });

  assert.equal(result.status, 'duplicate');
  assert.equal(result.transaction, undefined);
  assert.equal(calls.length, 1);
});

test('missing amount in known email returns parse_failed instead of confirmed', async () => {
  const { calls, service } = createService([
    [],
    [{ id: 'import-parse-failed' }],
    [],
  ]);

  const result = await service.handleEmailTransaction({
    telegramUserId: '976684739',
    userId: 1,
    source: 'email',
    email: {
      messageId: 'gmail-missing-amount',
      from: 'no-reply@krom.id',
      subject: 'Transaksi QRIS berhasil',
      date: '2026-06-22T10:00:00+07:00',
      emailText: 'Transaksi QRIS berhasil. Merchant: Kopi Tuku Jumlah:',
    },
  });

  assert.equal(result.status, 'parse_failed');
  assert.equal(result.reason, 'amount must exist and be positive');
  assert.equal(result.transaction, undefined);
  assert.equal(calls.length, 3);
});
