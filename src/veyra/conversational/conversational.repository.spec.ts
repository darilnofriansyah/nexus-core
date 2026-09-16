import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseService } from '../../database/database.service';
import { ConversationalRepository } from './conversational.repository';

function createRepository(rowsByCall: unknown[][] = [[{ total: 0, count: 0 }]]) {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const database = {
    query: async (text: string, values: unknown[] = []) => {
      calls.push({ text, values });
      return { rows: rowsByCall.shift() ?? [] };
    },
  } as unknown as DatabaseService;

  return {
    calls,
    repository: new ConversationalRepository(database),
  };
}

test('expense totals only count confirmed expense transactions', async () => {
  const { calls, repository } = createRepository();

  await repository.expenseTotal('1', '2026-06-25', '2026-07-25');

  assert.match(calls[0].text, /status = 'confirmed'/);
  assert.match(calls[0].text, /transaction_type = 'expense'/);
  assert.deepEqual(calls[0].values, ['1', '2026-06-25', '2026-07-25']);
});

test('category totals keep the same confirmed expense filter', async () => {
  const { calls, repository } = createRepository();

  await repository.categoryTotal('1', 'Food', '2026-06-25', '2026-07-25');

  assert.match(calls[0].text, /status = 'confirmed'/);
  assert.match(calls[0].text, /transaction_type = 'expense'/);
  assert.match(calls[0].text, /lower\(category\) = lower\(\$4\)/);
  assert.deepEqual(calls[0].values, [
    '1',
    '2026-06-25',
    '2026-07-25',
    'Food',
  ]);
});

test('weekpart spending uses user-scoped confirmed expense transaction dates', async () => {
  const { calls, repository } = createRepository([
    [{ period: 'weekday', amount: '120000', count: '2' }],
  ]);

  const result = await repository.spendingByWeekpart(
    '1',
    '2026-06-29',
    '2026-07-06',
    'Asia/Jakarta',
  );

  assert.match(calls[0].text, /user_id::text = \$1/);
  assert.match(calls[0].text, /status = 'confirmed'/);
  assert.match(calls[0].text, /transaction_type = 'expense'/);
  assert.match(calls[0].text, /transaction_date >= \$2::date/);
  assert.match(calls[0].text, /transaction_date < \$3::date/);
  assert.match(calls[0].text, /AT TIME ZONE \$4/);
  assert.doesNotMatch(calls[0].text, /created_at/);
  assert.deepEqual(calls[0].values, [
    '1',
    '2026-06-29',
    '2026-07-06',
    'Asia/Jakarta',
  ]);
  assert.deepEqual(result, [
    { period: 'weekday', amount: 120000, count: 2 },
  ]);
});

test('active pockets use their own amount while retaining legacy category names', async () => {
  const { calls, repository } = createRepository([
    [
      {
        id: '42',
        category: 'Daily',
        amount: '1200000',
        categories: ['Food', 'Transport'],
      },
    ],
  ]);

  const budgets = await repository.activeBudgets('1', null);

  assert.match(calls[0].text, /LEFT JOIN budgets child/);
  assert.match(calls[0].text, /COALESCE\(b\.amount, 0\) AS amount/);
  assert.match(calls[0].text, /b\.parent_budget_id IS NULL/);
  assert.match(calls[0].text, /ARRAY_AGG\(child\.category/);
  assert.doesNotMatch(calls[0].text, /SUM\(child\.amount\)/);
  assert.deepEqual(calls[0].values, ['1', null]);
  assert.deepEqual(budgets, [
    {
      id: '42',
      category: 'Daily',
      amount: 1200000,
      categories: ['Food', 'Transport'],
    },
  ]);
});

test('active budget legacy categories include pocket and active child names', async () => {
  const { calls, repository } = createRepository([
    [
      {
        id: '42',
        category: 'Daily',
        amount: '1200000',
        categories: ['Daily', 'Food', 'Transport'],
      },
    ],
  ]);

  const budgets = await repository.activeBudgets('1', null);

  assert.match(
    calls[0].text,
    /ARRAY\[b\.category\][\s\S]*ARRAY_AGG\(child\.category/,
  );
  assert.match(calls[0].text, /child\.is_active = true/);
  assert.doesNotMatch(calls[0].text, /child\.amount IS NOT NULL/);
  assert.deepEqual(budgets[0]?.categories, ['Daily', 'Food', 'Transport']);
});

test('pocket totals exclude assigned rows from another pocket', async () => {
  const { calls, repository } = createRepository();
  await repository.pocketTotal('1', '42', ['Food'], '2026-06-25', '2026-07-25');
  assert.match(calls[0].text, /t\.pocket_id::text = \$4/);
  assert.match(calls[0].text, /t\.pocket_id IS NULL/);
  assert.deepEqual(calls[0].values, ['1', '2026-06-25', '2026-07-25', '42', ['Food']]);
});

test('risk review summary uses answered high-risk expense reviews in the period', async () => {
  const { calls, repository } = createRepository([
    [
      {
        flagged_count: '5',
        answered_count: '3',
        regret_count: '2',
        regret_amount: '450000',
        top_regret_category: 'Shopping',
        top_regret_category_count: '2',
        top_regret_merchant: 'Shopee',
        top_regret_merchant_count: '2',
      },
    ],
  ]);

  const summary = await repository.riskReviewSummary(
    '1',
    '2026-06-25',
    '2026-07-25',
  );

  assert.match(calls[0].text, /r\.risk_level IN \('high', 'critical'\)/);
  assert.match(calls[0].text, /t\.user_id = r\.user_id/);
  assert.match(calls[0].text, /user_response = 'regret'/);
  assert.match(calls[0].text, /t\.status = 'confirmed'/);
  assert.deepEqual(calls[0].values, ['1', '2026-06-25', '2026-07-25']);
  assert.deepEqual(summary, {
    flaggedCount: 5,
    answeredCount: 3,
    regretCount: 2,
    regretAmount: 450000,
    topRegretCategory: { name: 'Shopping', count: 2 },
    topRegretMerchant: { name: 'Shopee', count: 2 },
  });
});
