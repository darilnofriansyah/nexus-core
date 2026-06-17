import assert from 'node:assert/strict';
import test from 'node:test';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { BudgetService } from './budget.service';

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
    service: new BudgetService(database),
  };
}

test('calculates a current cycle using the user cycle_start_day', () => {
  const { service } = createService();

  assert.deepEqual(
    service.calculateCurrentCycle(new Date('2026-06-17T08:00:00.000Z'), 15),
    {
      cycle_start: '2026-06-15',
      cycle_end: '2026-07-15',
    },
  );

  assert.deepEqual(
    service.calculateCurrentCycle(new Date('2026-06-14T08:00:00.000Z'), 15),
    {
      cycle_start: '2026-05-15',
      cycle_end: '2026-06-15',
    },
  );
});

test('clamps cycle_start_day to the last day of shorter months', () => {
  const { service } = createService();

  assert.deepEqual(
    service.calculateCurrentCycle(new Date('2026-03-30T08:00:00.000Z'), 31),
    {
      cycle_start: '2026-02-28',
      cycle_end: '2026-03-31',
    },
  );
});

test('maps budget status amounts and percentage', () => {
  const { service } = createService();

  const status = service.mapBudgetStatusRow(
    {
      budget_id: 42,
      category: 'Food',
      parent_budget_id: null,
      budget_amount: '1500000',
      spent_amount: '375000',
    },
    {
      cycle_start: '2026-06-15',
      cycle_end: '2026-07-15',
    },
  );

  assert.deepEqual(status, {
    budget_id: '42',
    category: 'Food',
    parent_budget_id: null,
    budget_amount: 1500000,
    spent_amount: 375000,
    remaining_amount: 1125000,
    spent_percent: 25,
    cycle_start: '2026-06-15',
    cycle_end: '2026-07-15',
  });
});

test('looks up user cycle then maps budget status from confirmed spending query', async () => {
  const { calls, service } = createService([
    [{ cycle_start_day: 15 }],
    [
      {
        budget_id: 'budget-1',
        category: 'Food',
        parent_budget_id: 'parent-1',
        budget_amount: '1000000',
        spent_amount: '250000',
      },
    ],
  ]);

  const status = await service.getBudgetStatus({
    telegramUserId: 'telegram-123',
    category: 'food',
    asOfDate: '2026-06-17',
  });

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].values, ['telegram-123']);
  assert.deepEqual(calls[1].values, [
    'telegram-123',
    'food',
    '2026-06-15',
    '2026-07-15',
  ]);
  assert.match(calls[1].text, /t\.status = 'confirmed'/);
  assert.match(calls[1].text, /t\.transaction_date >= \$3::date/);
  assert.match(calls[1].text, /t\.transaction_date < \$4::date/);
  assert.deepEqual(status, {
    budget_id: 'budget-1',
    category: 'Food',
    parent_budget_id: 'parent-1',
    budget_amount: 1000000,
    spent_amount: 250000,
    remaining_amount: 750000,
    spent_percent: 25,
    cycle_start: '2026-06-15',
    cycle_end: '2026-07-15',
  });
});

test('creates a budget without parent', async () => {
  const { calls, service } = createService([
    [
      {
        budget_id: 'budget-1',
        user_id: 'user-1',
        category: 'Food',
        amount: '1500000',
        parent_budget_id: null,
        parent_category: null,
        period_type: 'monthly',
        inserted: true,
      },
    ],
  ]);

  const result = await service.upsertBudget({
    userId: 'user-1',
    category: 'Food',
    amount: 1500000,
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].values, [
    'user-1',
    'Food',
    1500000,
    null,
    'monthly',
    false,
  ]);
  assert.match(calls[0].text, /ON CONFLICT \(user_id, category\)/);
  assert.deepEqual(result, {
    budget_id: 'budget-1',
    user_id: 'user-1',
    category: 'Food',
    amount: 1500000,
    parent_budget_id: null,
    parent_category: null,
    period_type: 'monthly',
    action: 'created',
  });
});

test('creates a child budget with parent', async () => {
  const { calls, service } = createService([
    [{ id: 'parent-1', category: 'Monthly Allowance' }],
    [
      {
        budget_id: 'budget-2',
        user_id: 'user-1',
        category: 'Food',
        amount: '1000000',
        parent_budget_id: 'parent-1',
        parent_category: 'Monthly Allowance',
        period_type: 'monthly',
        inserted: true,
      },
    ],
  ]);

  const result = await service.upsertBudget({
    userId: 'user-1',
    category: 'Food',
    amount: 1000000,
    parentCategory: 'Monthly Allowance',
  });

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].values, ['user-1', 'Monthly Allowance']);
  assert.deepEqual(calls[1].values, [
    'user-1',
    'Food',
    1000000,
    'parent-1',
    'monthly',
    true,
  ]);
  assert.equal(result.parent_budget_id, 'parent-1');
  assert.equal(result.parent_category, 'Monthly Allowance');
  assert.equal(result.action, 'created');
});

test('updates an existing budget', async () => {
  const { service } = createService([
    [
      {
        budget_id: 'budget-1',
        user_id: 'user-1',
        category: 'Food',
        amount: '1750000',
        parent_budget_id: null,
        parent_category: null,
        period_type: 'monthly',
        inserted: false,
      },
    ],
  ]);

  const result = await service.upsertBudget({
    userId: 'user-1',
    category: 'Food',
    amount: 1750000,
    periodType: 'monthly',
  });

  assert.equal(result.action, 'updated');
  assert.equal(result.amount, 1750000);
});

test('preserves parent_budget_id when parentCategory is missing', async () => {
  const { calls, service } = createService([
    [
      {
        budget_id: 'budget-2',
        user_id: 'user-1',
        category: 'Food',
        amount: '1250000',
        parent_budget_id: 'parent-1',
        parent_category: 'Monthly Allowance',
        period_type: 'monthly',
        inserted: false,
      },
    ],
  ]);

  const result = await service.upsertBudget({
    userId: 'user-1',
    category: 'Food',
    amount: 1250000,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].values[3], null);
  assert.equal(calls[0].values[5], false);
  assert.match(calls[0].text, /ELSE budgets\.parent_budget_id/);
  assert.equal(result.parent_budget_id, 'parent-1');
  assert.equal(result.parent_category, 'Monthly Allowance');
  assert.equal(result.action, 'updated');
});

test('rejects invalid budget amount', async () => {
  const { service } = createService();

  await assert.rejects(
    () =>
      service.upsertBudget({
        userId: 'user-1',
        category: 'Food',
        amount: 0,
      }),
    BadRequestException,
  );
});

test('rejects missing parentCategory lookup', async () => {
  const { service } = createService([[]]);

  await assert.rejects(
    () =>
      service.upsertBudget({
        userId: 'user-1',
        category: 'Food',
        amount: 1000000,
        parentCategory: 'Missing Parent',
      }),
    NotFoundException,
  );
});
