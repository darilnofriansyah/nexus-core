import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseService } from '../../database/database.service';
import { WebTransactionsFilter } from './dto/web-transactions.dto';
import { WebTransactionsRepository } from './web-transactions.repository';

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
    repository: new WebTransactionsRepository(database),
  };
}

function filter(
  overrides: Partial<WebTransactionsFilter> = {},
): WebTransactionsFilter {
  return {
    cursor: null,
    direction: 'next',
    limit: 50,
    type: null,
    category: null,
    merchantQuery: null,
    cycle: null,
    asOfDate: '2026-08-13',
    startDate: null,
    endDate: null,
    timezone: 'Asia/Jakarta',
    ...overrides,
  };
}

const transactionRows = [
  {
    id: '124',
    amount: '12000.00',
    merchant: 'TUKU',
    category: 'Dining',
    transaction_type: 'expense',
    source: 'email',
    transaction_date: '2026-08-13T04:00:00.123456Z',
    updated_at: '2026-08-13T05:00:00.654321Z',
    credit_card: true,
  },
  {
    id: '125',
    amount: '25000.00',
    merchant: null,
    category: null,
    transaction_type: 'income',
    source: 'manual',
    transaction_date: '2026-08-13T06:00:00.000001Z',
    updated_at: '2026-08-13T06:01:00.000002Z',
    credit_card: false,
  },
];

test('web transactions repository resolves one active user and clamps its cycle day', async () => {
  const { calls, repository } = createRepository([
    [{ id: '1', telegram_id: '976684739', cycle_start_day: '44' }],
  ]);

  const user = await repository.findActiveUserByTelegramId('976684739');

  assert.deepEqual(user, {
    id: '1',
    telegramUserId: '976684739',
    cycleStartDay: 31,
  });
  assert.match(calls[0].text, /FROM telegram_users/);
  assert.match(calls[0].text, /telegram_id = \$1::bigint/);
  assert.match(calls[0].text, /is_active IS TRUE/);
  assert.match(calls[0].text, /LIMIT 1/);
  assert.deepEqual(calls[0].values, ['976684739']);
});

test('web transactions repository returns null for an unresolved active user', async () => {
  const { repository } = createRepository([[]]);

  assert.equal(await repository.findActiveUserByTelegramId('976684739'), null);
});

test('web transactions repository scopes finalized rows to filters and a duplicate-safe next keyset', async () => {
  const { calls, repository } = createRepository([transactionRows]);

  const rows = await repository.findTransactions(
    '1',
    filter({
      type: 'expense',
      category: 'Dining',
      merchantQuery: 'tuku',
      cycle: 'current',
      startDate: '2026-08-01',
      endDate: '2026-09-01',
      cursor: {
        transactionDate: '2026-08-13T03:00:00.000000Z',
        id: '123',
      },
      direction: 'next',
      limit: 1,
    }),
  );

  assert.match(calls[0].text, /WHERE user_id = \$1/);
  assert.match(calls[0].text, /status = 'confirmed'/);
  assert.match(calls[0].text, /transaction_type IN \('income', 'expense'\)/);
  assert.match(calls[0].text, /transaction_type = \$\d+/);
  assert.match(calls[0].text, /category = \$\d+/);
  assert.match(
    calls[0].text,
    /COALESCE\(merchant_normalized, merchant, ''\) ILIKE '%' \|\| \$\d+ \|\| '%'/,
  );
  assert.match(
    calls[0].text,
    /transaction_date >= \(\$\d+::date AT TIME ZONE \$\d+\)/,
  );
  assert.match(
    calls[0].text,
    /\(transaction_date, id\) < \(\$\d+::timestamptz, \$\d+::bigint\)/,
  );
  assert.match(calls[0].text, /ORDER BY transaction_date DESC, id DESC/);
  assert.match(calls[0].text, /LIMIT \$\d+/);
  assert.equal(calls[0].values.at(-1), 2);
  assert.doesNotMatch(calls[0].text, /SELECT[\s\S]*raw_payload,/);
  assert.deepEqual(rows[0], {
    id: '124',
    amount: 12000,
    merchant: 'TUKU',
    category: 'Dining',
    transactionType: 'expense',
    source: 'email',
    transactionDate: '2026-08-13T04:00:00.123456Z',
    updatedAt: '2026-08-13T05:00:00.654321Z',
    creditCard: true,
  });
});

test('web transactions repository queries newer rows ascending then reverses previous results', async () => {
  const { calls, repository } = createRepository([transactionRows]);

  const rows = await repository.findTransactions(
    '1',
    filter({
      cursor: {
        transactionDate: '2026-08-13T03:00:00.000000Z',
        id: '123',
      },
      direction: 'previous',
    }),
  );

  assert.match(
    calls[0].text,
    /\(transaction_date, id\) > \(\$\d+::timestamptz, \$\d+::bigint\)/,
  );
  assert.match(calls[0].text, /ORDER BY transaction_date ASC, id ASC/);
  assert.deepEqual(
    rows.map((row) => row.id),
    ['125', '124'],
  );
});

test('web transactions repository category options retain type date and search scope only', async () => {
  const { calls, repository } = createRepository([
    [{ category: 'Dining' }, { category: 'Transport' }],
  ]);

  const categories = await repository.findCategories('1', {
    type: 'expense',
    merchantQuery: 'tuku',
    cycle: 'current',
    asOfDate: '2026-08-13',
    startDate: '2026-08-01',
    endDate: '2026-09-01',
    timezone: 'Asia/Jakarta',
  });

  assert.match(calls[0].text, /GROUP BY category/);
  assert.match(calls[0].text, /WHERE user_id = \$1/);
  assert.match(calls[0].text, /transaction_type = \$\d+/);
  assert.match(calls[0].text, /merchant_normalized/);
  assert.match(calls[0].text, /transaction_date >=/);
  assert.doesNotMatch(calls[0].text, /category = \$\d+/);
  assert.doesNotMatch(calls[0].text, /\(transaction_date, id\) [<>]/);
  assert.deepEqual(categories, ['Dining', 'Transport']);
});
