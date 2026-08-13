import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseService } from '../../database/database.service';
import {
  WebTransactionChanges,
  WebTransactionsFilter,
} from './dto/web-transactions.dto';
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

interface TransactionLifecycle {
  committed: boolean;
  rolledBack: boolean;
}

function createUpdateRepository(
  rowsByCall: unknown[][],
  failSummary = false,
) {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const lifecycle: TransactionLifecycle = {
    committed: false,
    rolledBack: false,
  };
  let transactionCount = 0;
  const client = {
    query: async (text: string, values: unknown[] = []) => {
      calls.push({ text, values });
      if (failSummary && /INSERT INTO credit_card_cycle_summaries/.test(text)) {
        throw new Error('summary write failed');
      }
      return { rows: rowsByCall.shift() ?? [] };
    },
  };
  const database = {
    withTransaction: async <T>(
      callback: (transactionClient: typeof client) => Promise<T>,
    ): Promise<T> => {
      transactionCount += 1;
      try {
        const result = await callback(client);
        lifecycle.committed = true;
        return result;
      } catch (error) {
        lifecycle.rolledBack = true;
        throw error;
      }
    },
  } as unknown as DatabaseService;

  return {
    calls,
    lifecycle,
    transactionCount: () => transactionCount,
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

const transactionDate = '2026-08-13T03:00:00.123456Z';
const oldTime = '2026-08-13T03:01:00.654321Z';

function lockedRow(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: '123',
    user_id: '1',
    transaction_type: 'expense',
    amount: '25000',
    merchant: 'TUKU',
    category: 'Dining',
    transaction_date: transactionDate,
    source: 'email',
    status: 'confirmed',
    updated_at: oldTime,
    version_matches: true,
    raw_payload: { parsed: { paymentType: ' Credit Card ' } },
    ...overrides,
  };
}

function returnedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: '123',
    amount: '30000',
    merchant: 'TUKU',
    category: 'Dining',
    transaction_type: 'expense',
    source: 'email',
    transaction_date: transactionDate,
    updated_at: '2026-08-13T04:00:00.000001Z',
    credit_card: true,
    ...overrides,
  };
}

function updateInput(changes: WebTransactionChanges) {
  return {
    userId: '1',
    transactionId: '123',
    expectedUpdatedAt: oldTime,
    changes,
  };
}

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

test('web transactions repository search falls back to a corrected merchant when normalization is cleared', async () => {
  const correctedMerchant = 'Kopi Tetangga';
  const { calls, repository } = createRepository([
    [
      {
        ...transactionRows[0],
        merchant: correctedMerchant,
      },
    ],
  ]);

  const rows = await repository.findTransactions(
    '1',
    filter({ merchantQuery: 'tetangga' }),
  );

  assert.match(
    calls[0].text,
    /COALESCE\(merchant_normalized, merchant, ''\) ILIKE '%' \|\| \$\d+ \|\| '%'/,
  );
  assert.equal(rows[0]?.merchant, correctedMerchant);
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

test('web transactions repository update locks owned finalized row and atomically writes eligible amount increase', async () => {
  const { calls, lifecycle, repository, transactionCount } = createUpdateRepository([
    [lockedRow()],
    [returnedRow()],
    [],
  ]);

  const result = await repository.updateTransaction(updateInput({ amount: 30000 }));

  assert.equal(result.kind, 'updated');
  assert.match(calls[0].text, /FOR UPDATE/);
  assert.match(calls[0].text, /updated_at = \$3::timestamptz AS version_matches/);
  assert.deepEqual(calls[0].values, ['123', '1', oldTime]);
  assert.match(calls[1].text, /UPDATE transactions/);
  assert.match(calls[1].text, /SET amount = \$1, updated_at = now\(\)/);
  assert.doesNotMatch(calls[1].text, /merchant =|category =/);
  assert.match(calls[2].text, /INSERT INTO credit_card_cycle_summaries/);
  assert.deepEqual(calls[2].values, ['1', transactionDate, 5000, 5000]);
  assert.doesNotMatch(calls[2].text, /credit_limit =|statement_balance =/);
  assert.equal(lifecycle.committed, true);
  assert.equal(lifecycle.rolledBack, false);
  assert.equal(transactionCount(), 1);
});

test('web transactions repository credit-card update uses negative delta and skips non-amount or non-card changes', async () => {
  const summaryValues: unknown[][] = [];
  const scenarios: Array<{
    locked: Record<string, unknown>;
    changes: WebTransactionChanges;
    returned: Record<string, unknown>;
  }> = [
    {
      locked: lockedRow(),
      changes: { amount: 20000 },
      returned: returnedRow({ amount: '20000' }),
    },
    {
      locked: lockedRow(),
      changes: { merchant: 'Tuku Kemang' },
      returned: returnedRow({ amount: '25000', merchant: 'Tuku Kemang' }),
    },
    {
      locked: lockedRow(),
      changes: { category: 'Coffee' },
      returned: returnedRow({ amount: '25000', category: 'Coffee' }),
    },
    {
      locked: lockedRow(),
      changes: { amount: 25000, merchant: 'Tuku Kemang' },
      returned: returnedRow({ amount: '25000', merchant: 'Tuku Kemang' }),
    },
    {
      locked: lockedRow({ source: 'manual' }),
      changes: { amount: 30000 },
      returned: returnedRow({ source: 'manual', credit_card: false }),
    },
  ];

  for (const scenario of scenarios) {
    const { calls, repository } = createUpdateRepository([
      [scenario.locked],
      [scenario.returned],
      [],
    ]);
    await repository.updateTransaction(updateInput(scenario.changes));
    summaryValues.push(
      ...calls
        .filter(({ text }) => /INSERT INTO credit_card_cycle_summaries/.test(text))
        .map(({ values }) => values),
    );
  }

  assert.deepEqual(summaryValues, [['1', transactionDate, 0, -5000]]);
});

test('web transactions repository credit-card update rolls back when the eligible summary write fails', async () => {
  const { calls, lifecycle, repository } = createUpdateRepository(
    [[lockedRow()], [returnedRow()]],
    true,
  );

  await assert.rejects(
    () => repository.updateTransaction(updateInput({ amount: 30000 })),
    /summary write failed/,
  );

  const summaryCall = calls.find(({ text }) =>
    /INSERT INTO credit_card_cycle_summaries/.test(text),
  );
  assert.deepEqual(summaryCall?.values, ['1', transactionDate, 5000, 5000]);
  assert.equal(lifecycle.committed, false);
  assert.equal(lifecycle.rolledBack, true);
});

test('web transactions repository update returns not found conflict invalid and no-change under one lock', async () => {
  const scenarios: Array<{
    rows: unknown[][];
    changes: WebTransactionChanges;
    kind: string;
  }> = [
    { rows: [[]], changes: { amount: 30000 }, kind: 'not_found' },
    {
      rows: [[lockedRow({ version_matches: false })]],
      changes: { amount: 30000 },
      kind: 'conflict',
    },
    {
      rows: [[lockedRow({ merchant: null })]],
      changes: { category: null },
      kind: 'invalid',
    },
    {
      rows: [[lockedRow()]],
      changes: { merchant: 'TUKU' },
      kind: 'no_change',
    },
  ];

  for (const scenario of scenarios) {
    const { calls, repository } = createUpdateRepository(scenario.rows);
    const result = await repository.updateTransaction(updateInput(scenario.changes));
    assert.equal(result.kind, scenario.kind);
    assert.equal(calls.length, 1);
  }
});

test('web transactions repository update permits null merchant and category for income', async () => {
  const { calls, repository } = createUpdateRepository([
    [
      lockedRow({
        transaction_type: 'income',
        source: 'manual',
        merchant: 'Salary',
        category: 'Income',
        raw_payload: null,
      }),
    ],
    [
      returnedRow({
        transaction_type: 'income',
        source: 'manual',
        amount: '25000',
        merchant: null,
        category: null,
        credit_card: false,
      }),
    ],
  ]);

  const result = await repository.updateTransaction(
    updateInput({ merchant: null, category: null }),
  );

  assert.equal(result.kind, 'updated');
  assert.deepEqual(calls[1].values, [null, null, '123', '1']);
  assert.equal(calls.length, 2);
});

test('web transactions repository merchant correction atomically clears stale normalization', async () => {
  const { calls, repository } = createUpdateRepository([
    [lockedRow()],
    [returnedRow({ amount: '25000', merchant: 'Kopi Tetangga' })],
  ]);

  const result = await repository.updateTransaction(
    updateInput({ merchant: 'Kopi Tetangga' }),
  );

  assert.equal(result.kind, 'updated');
  assert.match(
    calls[1].text,
    /SET merchant = \$1, merchant_normalized = NULL, updated_at = now\(\)/,
  );
  assert.deepEqual(calls[1].values, ['Kopi Tetangga', '123', '1']);
  assert.equal(calls.length, 2);
});

test('web transactions repository unchanged merchant remains a no-op', async () => {
  const { calls, repository } = createUpdateRepository([[lockedRow()]]);

  const result = await repository.updateTransaction(
    updateInput({ merchant: 'TUKU' }),
  );

  assert.deepEqual(result, { kind: 'no_change' });
  assert.equal(calls.length, 1);
});

test('web transactions repository unchanged merchant is not rewritten with another change', async () => {
  const { calls, repository } = createUpdateRepository([
    [lockedRow({ source: 'manual' })],
    [returnedRow({ amount: '30000', source: 'manual', credit_card: false })],
  ]);

  const result = await repository.updateTransaction(
    updateInput({ amount: 30000, merchant: 'TUKU' }),
  );

  assert.equal(result.kind, 'updated');
  assert.match(calls[1].text, /SET amount = \$1, updated_at = now\(\)/);
  assert.doesNotMatch(calls[1].text, /merchant(?:_normalized)?\s*=/);
  assert.deepEqual(calls[1].values, [30000, '123', '1']);
});

test('web transactions repository update binds every and only supplied patch column', async () => {
  const { calls, repository } = createUpdateRepository([
    [lockedRow()],
    [returnedRow({ amount: '27500', merchant: 'Tuku Blok M', category: 'Coffee' })],
    [],
  ]);

  await repository.updateTransaction(
    updateInput({ amount: 27500, merchant: 'Tuku Blok M', category: 'Coffee' }),
  );

  assert.match(
    calls[1].text,
    /SET amount = \$1, merchant = \$2, merchant_normalized = NULL, category = \$3, updated_at = now\(\)/,
  );
  assert.deepEqual(calls[1].values, [27500, 'Tuku Blok M', 'Coffee', '123', '1']);
});
