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

test('active budgets aggregate child budget amounts and categories', async () => {
  const { calls, repository } = createRepository([
    [
      {
        category: 'Daily',
        amount: '1200000',
        categories: ['Food', 'Transport'],
      },
    ],
  ]);

  const budgets = await repository.activeBudgets('1', null);

  assert.match(calls[0].text, /LEFT JOIN budgets child/);
  assert.match(calls[0].text, /SUM\(child\.amount\)/);
  assert.match(calls[0].text, /ARRAY_AGG\(child\.category/);
  assert.deepEqual(calls[0].values, ['1', null]);
  assert.deepEqual(budgets, [
    {
      category: 'Daily',
      amount: 1200000,
      categories: ['Food', 'Transport'],
    },
  ]);
});
