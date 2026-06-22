import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { BadRequestException } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { TransactionService } from './transaction.service';

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
    service: new TransactionService(database),
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

const budgetCategoryRows = [
  { id: 'budget-food', category: 'Food', parent_category: null },
  { id: 'budget-transport', category: 'Transport', parent_category: null },
  { id: 'budget-groceries', category: 'Groceries', parent_category: null },
  { id: 'budget-bills', category: 'Bills', parent_category: null },
  { id: 'budget-health', category: 'Health & Beauty', parent_category: null },
  { id: 'budget-shopping', category: 'Shopping', parent_category: null },
  { id: 'budget-entertainment', category: 'Entertainment', parent_category: null },
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
  assert.deepEqual(cashback.warnings, ['refund/cashback input mapped to income']);
  assert.equal(reversal.transactionType, 'reversal');
  assert.deepEqual(reversal.warnings, [
    'transactionType mapped to reversal from reversal-like input',
  ]);
});

test('uses merchant alias lookup when available', async () => {
  const { calls, service } = createService([
    [{ canonical_name: 'GoPay' }],
    [],
  ]);

  const result = await service.normalizeTransaction({
    userId: 'user-1',
    transactionType: 'expense',
    amount: 50000,
    merchant: 'gopay',
  });

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].values, ['user-1', 'gopay']);
  assert.match(calls[0].text, /canonical_name/);
  assert.match(calls[0].text, /alias_name/);
  assert.match(calls[0].text, /LIKE/);
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
  assert.deepEqual(calls[1].values, ['user-1', 'GoPay', 'gopay']);
  assert.match(calls[1].text, /merchant_pattern/);
  assert.doesNotMatch(calls[1].text, /merchant_normalized/);
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
  assert.match(result.message, /Recorded: Rp25\.000 at Kopi Tuku under Coffee\./);
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
      { text: 'Approve', callback_data: 'save_transaction:tx-pending' },
      {
        text: 'Change Category',
        callback_data: 'change_categories:tx-pending',
      },
    ],
    [{ text: 'Reject', callback_data: 'cancel_transaction:tx-pending' }],
  ]);
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

test('rejects non-empty llm missing_fields without saving', async () => {
  const { calls, service } = createService();

  await assert.rejects(
    () =>
      service.handleManualTransaction({
        userId: 1,
        source: 'manual',
        llmResult: {
          transaction_type: 'expense',
          amount: 25000,
          merchant: 'kopi tuku',
          category: 'Coffee',
          confidence: 95,
          missing_fields: ['category'],
        },
      }),
    BadRequestException,
  );
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
      { text: 'Approve', callback_data: 'save_transaction:tx-1' },
      { text: 'Change Category', callback_data: 'change_categories:tx-1' },
    ],
    [{ text: 'Reject', callback_data: 'cancel_transaction:tx-1' }],
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
      { text: 'Approve', callback_data: 'save_transaction:tx-manual' },
      {
        text: 'Change Category',
        callback_data: 'change_categories:tx-manual',
      },
    ],
    [{ text: 'Reject', callback_data: 'cancel_transaction:tx-manual' }],
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
  const { service } = createService([[transaction], [pendingTransaction], budgetCategoryRows]);

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
  const { service } = createService([[{ ...pendingTransaction, resolved: true }]]);

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
  const { service } = createService([[transaction], [pendingTransaction], budgetCategoryRows]);

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
  assert.equal(result.editMessage?.text, 'Transaction tx-1 confirmed: GoPay 50000');
  assert.deepEqual(calls[2].values, ['Food', 'tx-1', 'user-1']);
  assert.match(calls[2].text, /UPDATE transactions/);
  assert.match(calls[2].text, /status = 'confirmed'/);
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
