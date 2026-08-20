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

test('pocket status SQL keeps assigned, child, and legacy spending boundaries', async () => {
  const { calls, repository } = createRepository([
    [
      {
        budget_id: '42',
        category: 'Monthly Transactions',
        parent_budget_id: null,
        budget_amount: '1000000',
        spent_amount: '500000',
        child_breakdown: [],
      },
    ],
  ]);

  const row = await repository.findPocketStatus({
    userId: '1',
    lookup: '42',
    cycleStart: '2026-08-01',
    cycleEnd: '2026-09-01',
  });

  assert.equal(row?.budget_id, '42');
  assert.deepEqual(calls[0].values, [
    '1',
    '42',
    '2026-08-01',
    '2026-09-01',
  ]);
  assert.match(calls[0].text, /t\.pocket_id = pocket\.id/);
  assert.doesNotMatch(
    calls[0].text,
    /t\.pocket_id = pocket\.id\s+AND lower\(t\.category\)/,
  );
  assert.match(calls[0].text, /t\.pocket_id = child\.parent_budget_id/);
  assert.match(
    calls[0].text,
    /lower\(t\.category\) = lower\(child\.category\)/,
  );
  assert.match(
    calls[0].text,
    /t\.pocket_id IS NULL AND lower\(t\.category\) IN/,
  );
  assert.match(calls[0].text, /t\.status = 'confirmed'/);
  assert.match(calls[0].text, /t\.transaction_type = 'expense'/);
  assert.match(calls[0].text, /t\.transaction_date >= \$3::date/);
  assert.match(calls[0].text, /t\.transaction_date < \$4::date/);
  assert.match(
    calls[0].text,
    /WHEN \(SELECT budget_amount FROM pocket\) IS NOT NULL/,
  );
  assert.match(calls[0].text, /SUM\(child_spending\.budget_amount\)/);
  assert.match(calls[0].text, /COALESCE\(child\.is_active, true\) = true/);
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
  assert.match(calls[0].text, /t\.transaction_date >= \$2::date/);
  assert.match(calls[0].text, /t\.transaction_date < \$3::date/);
  assert.match(calls[0].text, /COALESCE\(b\.amount, SUM\(child\.amount\)\)/);
  assert.match(calls[0].text, /child\.is_active = true/);
});
