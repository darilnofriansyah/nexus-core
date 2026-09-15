import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseService } from '../../database/database.service';
import { BudgetRepository } from './budget.repository';

function createRepository(rowsByCall: unknown[][] = []) {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const database = {
    query: async (text: string, values: unknown[] = []) => {
      calls.push({ text, values });
      return { rows: rowsByCall.shift() ?? [], rowCount: 0 };
    },
    withTransaction: async (
      callback: (client: { query: typeof database.query }) => Promise<unknown>,
    ) => callback(database),
  } as unknown as DatabaseService;

  return { calls, repository: new BudgetRepository(database) };
}

test('creates Main Pocket only when user has no top-level pocket', async () => {
  const { calls, repository } = createRepository();
  await repository.ensureDefaultPocket('1');
  assert.match(calls[0].text, /INSERT INTO budgets/);
  assert.match(calls[0].text, /'Main Pocket'/);
  assert.match(calls[0].text, /parent_budget_id IS NULL/);
});

test('finds only an active internal user by Telegram ID', async () => {
  const { calls, repository } = createRepository([[{ id: '1' }]]);

  assert.equal(await repository.findActiveUserIdByTelegramId('976684739'), '1');
  assert.match(calls[0].text, /FROM telegram_users/);
  assert.match(calls[0].text, /telegram_id = \$1::bigint/);
  assert.match(calls[0].text, /is_active IS TRUE/);
  assert.deepEqual(calls[0].values, ['976684739']);
});

test('explicit pocket lookup requires active top-level ownership', async () => {
  const { calls, repository } = createRepository();
  await repository.findPocket('1', '20');
  assert.match(calls[0].text, /user_id = \$1/);
  assert.match(calls[0].text, /id = \$2/);
  assert.match(calls[0].text, /parent_budget_id IS NULL/);
  assert.match(calls[0].text, /is_active = true/);
});

test('sets the default after locking the active pocket set and clearing the prior default', async () => {
  const { calls, repository } = createRepository([
    [{ id: '20', category: 'Main', amount: null, is_default: false }],
    [],
    [{ id: '20', category: 'Main', amount: null, is_default: true }],
  ]);
  await repository.setDefaultPocket('1', '20');
  assert.match(calls[0].text, /FOR UPDATE/);
  assert.match(calls[0].text, /parent_budget_id IS NULL/);
  assert.doesNotMatch(calls[0].text, /id::text = \$2/);
  assert.match(calls[1].text, /is_default = false/);
  assert.match(calls[2].text, /is_default = true/);
});

test('pocket status SQL gives explicit ID precedence over a colliding category', async () => {
  const { calls, repository } = createRepository([
    [
      {
        budget_id: '42',
        category: 'Monthly Transactions',
        parent_budget_id: null,
        budget_amount: '1000000',
        spent_amount: '500000',
        category_breakdown: [
          { category: 'Food', spent_amount: '250000' },
          { category: 'Other', spent_amount: '250000' },
        ],
      },
    ],
  ]);

  const row = await repository.findPocketStatus({
    userId: '1',
    pocketId: '42',
    category: '42',
    cycleStart: '2026-08-01',
    cycleEnd: '2026-09-01',
  });

  assert.equal(row?.budget_id, '42');
  assert.deepEqual(row?.category_breakdown, [
    { category: 'Food', spent_amount: '250000' },
    { category: 'Other', spent_amount: '250000' },
  ]);
  assert.deepEqual(calls[0].values, [
    '1',
    '42',
    '2026-08-01',
    '2026-09-01',
    '42',
  ]);
  assert.match(calls[0].text, /WHEN \$2::text IS NOT NULL THEN b\.id::text = \$2/);
  assert.match(
    calls[0].text,
    /ELSE lower\(b\.category\) = lower\(\$5\)/,
  );
  assert.doesNotMatch(
    calls[0].text,
    /b\.id::text = \$2 OR lower\(b\.category\)/,
  );
  assert.match(calls[0].text, /t\.pocket_id = pocket\.id/);
  assert.doesNotMatch(
    calls[0].text,
    /t\.pocket_id = pocket\.id\s+AND lower\(t\.category\)/,
  );
  assert.match(
    calls[0].text,
    /t\.pocket_id IS NULL AND lower\(t\.category\) IN/,
  );
  assert.match(calls[0].text, /t\.status = 'confirmed'/);
  assert.match(calls[0].text, /t\.transaction_type = 'expense'/);
  assert.match(
    calls[0].text,
    /t\.transaction_date >= \(\$3::date::timestamp AT TIME ZONE u\.timezone\)/,
  );
  assert.match(
    calls[0].text,
    /t\.transaction_date < \(\$4::date::timestamp AT TIME ZONE u\.timezone\)/,
  );
  assert.match(
    calls[0].text,
    /COALESCE\(timezone, 'Asia\/Jakarta'\) AS timezone/,
  );
  assert.match(calls[0].text, /COALESCE\(b\.amount, 0\) AS budget_amount/);
  assert.match(calls[0].text, /matched_transactions AS/);
  assert.match(
    calls[0].text,
    /totals AS \(\s*SELECT COALESCE\(SUM\(amount\), 0\) AS spent_amount\s+FROM matched_transactions\s*\)/,
  );
  assert.match(
    calls[0].text,
    /FROM matched_transactions\s+GROUP BY category/,
  );
  assert.match(calls[0].text, /'category', category/);
  assert.match(calls[0].text, /'spent_amount', spent_amount/);
  assert.equal(calls[0].text.match(/FROM matched_transactions/g)?.length, 2);
  assert.match(calls[0].text, /COALESCE\(child\.is_active, true\) = true/);
  assert.doesNotMatch(calls[0].text, /child_spending|child_breakdown/);
  assert.doesNotMatch(calls[0].text, /SUM\(child\.amount\)/);
});

test('resolves a legacy category to its active top-level pocket', async () => {
  const { calls, repository } = createRepository([[{ id: '42' }]]);

  assert.equal(await repository.resolveLegacyPocketId('1', 'Food'), '42');
  assert.deepEqual(calls[0].values, ['1', 'Food']);
  assert.match(calls[0].text, /pocket\.user_id = \$1::bigint/);
  assert.match(calls[0].text, /pocket\.parent_budget_id IS NULL/);
  assert.match(calls[0].text, /pocket\.is_active = true/);
  assert.match(calls[0].text, /lower\(pocket\.category\) = lower\(\$2\)/);
  assert.match(calls[0].text, /child\.parent_budget_id = pocket\.id/);
  assert.match(calls[0].text, /child\.user_id = pocket\.user_id/);
  assert.match(calls[0].text, /child\.is_active = true/);
  assert.match(
    calls[0].text,
    /ORDER BY\s+CASE WHEN lower\(pocket\.category\) = lower\(\$2\) THEN 0 ELSE 1 END,\s+pocket\.id/,
  );
});

test('returns null when a legacy category has no active pocket', async () => {
  const { repository } = createRepository();

  assert.equal(await repository.resolveLegacyPocketId('1', 'Food'), null);
});

test('pocket status SQL uses category compatibility only when ID is omitted', async () => {
  const { calls, repository } = createRepository();

  await repository.findPocketStatus({
    userId: '1',
    category: 'Food',
    cycleStart: '2026-08-01',
    cycleEnd: '2026-09-01',
  });

  assert.deepEqual(calls[0].values, [
    '1',
    null,
    '2026-08-01',
    '2026-09-01',
    'Food',
  ]);
  assert.match(calls[0].text, /WHEN \$2::text IS NOT NULL THEN b\.id::text = \$2/);
  assert.match(
    calls[0].text,
    /ELSE lower\(b\.category\) = lower\(\$5\)/,
  );
});

test('pocket overview SQL keeps assigned and null-pocket compatibility isolated', async () => {
  const { calls, repository } = createRepository();

  await repository.listPocketOverview({
    userId: '1',
    cycleStart: '2026-08-01',
    cycleEnd: '2026-09-01',
  });

  assert.deepEqual(calls[0].values, [
    '1',
    '2026-08-01',
    '2026-09-01',
  ]);
  assert.match(
    calls[0].text,
    /b\.parent_budget_id IS NULL AND \(t\.pocket_id = b\.id OR \(t\.pocket_id IS NULL/,
  );
  assert.match(
    calls[0].text,
    /t\.pocket_id = b\.parent_budget_id AND lower\(t\.category\) = lower\(b\.category\)/,
  );
  assert.match(
    calls[0].text,
    /t\.pocket_id IS NULL AND lower\(t\.category\) = lower\(b\.category\)/,
  );
  assert.match(calls[0].text, /t\.status = 'confirmed'/);
  assert.match(calls[0].text, /t\.transaction_type = 'expense'/);
  assert.match(
    calls[0].text,
    /t\.transaction_date >= \(\$2::date::timestamp AT TIME ZONE u\.timezone\)/,
  );
  assert.match(
    calls[0].text,
    /t\.transaction_date < \(\$3::date::timestamp AT TIME ZONE u\.timezone\)/,
  );
  assert.match(
    calls[0].text,
    /COALESCE\(timezone, 'Asia\/Jakarta'\) AS timezone/,
  );
  assert.match(calls[0].text, /COALESCE\(b\.amount, 0\) AS amount/);
  assert.doesNotMatch(calls[0].text, /SUM\(child\.amount\)/);
  assert.match(calls[0].text, /child\.is_active = true/);
});
