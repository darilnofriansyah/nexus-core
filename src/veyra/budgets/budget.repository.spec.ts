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
