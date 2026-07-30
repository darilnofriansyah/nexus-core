import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseService } from '../../database/database.service';
import { DashboardOverviewRepository } from './dashboard-overview.repository';

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
    repository: new DashboardOverviewRepository(database),
  };
}

test('findUser resolves an active Telegram user with string-safe identifiers', async () => {
  const { calls, repository } = createRepository([
    [{ id: '1', telegram_id: '976684739', cycle_start_day: '31' }],
  ]);

  const user = await repository.findUser(null, '976684739');

  assert.deepEqual(user, {
    id: '1',
    telegramUserId: '976684739',
    cycleStartDay: 31,
  });
  assert.match(calls[0].text, /is_active IS TRUE/);
  assert.match(calls[0].text, /\(\$1::text IS NULL OR id::text = \$1\)/);
  assert.match(
    calls[0].text,
    /\(\$2::text IS NULL OR telegram_id::text = \$2\)/,
  );
  assert.doesNotMatch(calls[0].text, /\)\s+OR\s+\(/);
  assert.deepEqual(calls[0].values, [null, '976684739']);
});

test('findUser returns null when identifiers do not resolve one row', async () => {
  const { repository } = createRepository([[]]);

  assert.equal(await repository.findUser('1', '999'), null);
});

test('findTransactions reads only confirmed income and expenses in local dates', async () => {
  const { calls, repository } = createRepository([
    [
      {
        id: '123',
        transaction_type: 'expense',
        amount: '25000.00',
        merchant: 'TUKU',
        category: 'Food',
        transaction_day: '2026-07-24',
        transaction_date: '2026-07-24T03:00:00.000Z',
      },
    ],
  ]);

  const transactions = await repository.findTransactions(
    '1',
    '2026-05-01',
    '2026-07-26',
    'Asia/Jakarta',
  );

  assert.match(calls[0].text, /status = 'confirmed'/);
  assert.match(calls[0].text, /transaction_type IN \('income', 'expense'\)/);
  assert.match(calls[0].text, /transaction_date AT TIME ZONE \$4/);
  assert.match(
    calls[0].text,
    /transaction_date >= \(\$2::date AT TIME ZONE \$4\)/,
  );
  assert.match(
    calls[0].text,
    /transaction_date < \(\$3::date AT TIME ZONE \$4\)/,
  );
  assert.deepEqual(calls[0].values, [
    '1',
    '2026-05-01',
    '2026-07-26',
    'Asia/Jakarta',
  ]);
  assert.deepEqual(transactions, [
    {
      id: '123',
      type: 'expense',
      amount: 25000,
      merchant: 'TUKU',
      category: 'Food',
      date: '2026-07-24',
      timestamp: '2026-07-24T03:00:00.000Z',
    },
  ]);
});

test('findActiveBudgets returns active top-level budgets and active children', async () => {
  const { calls, repository } = createRepository([
    [
      {
        id: '10',
        parent_budget_id: null,
        category: 'Living',
        amount: null,
      },
      {
        id: '11',
        parent_budget_id: '10',
        category: 'Food',
        amount: '1500000',
      },
    ],
  ]);

  const budgets = await repository.findActiveBudgets('1');

  assert.match(calls[0].text, /FROM budgets b/);
  assert.match(calls[0].text, /LEFT JOIN budgets parent/);
  assert.match(calls[0].text, /b\.is_active = true/);
  assert.match(
    calls[0].text,
    /b\.parent_budget_id IS NULL OR parent\.is_active = true/,
  );
  assert.deepEqual(calls[0].values, ['1']);
  assert.deepEqual(budgets, [
    { id: '10', parentId: null, category: 'Living', amount: 0 },
    { id: '11', parentId: '10', category: 'Food', amount: 1500000 },
  ]);
});

test('findCreditCardSummaries maps only requested cycles to safe IDR integers', async () => {
  const { calls, repository } = createRepository([
    [
      {
        cycle_start: '2026-07-15',
        credit_limit: '10000000',
        credit_used: '2500000',
        statement_balance: '0',
      },
      {
        cycle_start: '2026-06-15',
        credit_limit: '-1',
        credit_used: '1.5',
        statement_balance: '9007199254740992',
      },
    ],
  ]);

  const summaries = await repository.findCreditCardSummaries('1', [
    '2026-07-15',
    '2026-06-15',
  ]);

  assert.match(calls[0].text, /FROM credit_card_cycle_summaries/);
  assert.match(calls[0].text, /cycle_start = ANY\(\$2::date\[\]\)/);
  assert.deepEqual(calls[0].values, [
    '1',
    ['2026-07-15', '2026-06-15'],
  ]);
  assert.deepEqual(summaries, [
    {
      cycleStart: '2026-07-15',
      limit: 10000000,
      used: 2500000,
      statementBalance: 0,
    },
    {
      cycleStart: '2026-06-15',
      limit: 0,
      used: 0,
      statementBalance: 0,
    },
  ]);
});
