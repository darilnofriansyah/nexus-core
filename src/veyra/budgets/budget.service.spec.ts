import * as assert from 'node:assert/strict';
import { test } from 'node:test';
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
    child_breakdown: [],
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
  assert.match(calls[1].text, /b\.amount AS budget_amount/);
  assert.match(calls[1].text, /COALESCE\(b\.is_active, true\) = true/);
  assert.match(calls[1].text, /COALESCE\(child\.is_active, true\) = true/);
  assert.match(calls[1].text, /child_breakdown\.child_breakdown/);
  assert.doesNotMatch(calls[1].text, /budgets\.budget_amount|\sb\.budget_amount/);
  assert.deepEqual(status, {
    budget_id: 'budget-1',
    category: 'Food',
    parent_budget_id: 'parent-1',
    budget_amount: 1000000,
    spent_amount: 250000,
    remaining_amount: 750000,
    spent_percent: 25,
    child_breakdown: [],
    cycle_start: '2026-06-15',
    cycle_end: '2026-07-15',
  });
});

test('returns direct category status without child breakdown', async () => {
  const { service } = createService([
    [{ cycle_start_day: 1 }],
    [
      {
        budget_id: 'budget-food',
        category: 'Food',
        parent_budget_id: null,
        budget_amount: '2000000',
        spent_amount: '500000',
        child_breakdown: [],
      },
    ],
  ]);

  const status = await service.getBudgetStatus({
    userId: 'user-1',
    category: 'Food',
    asOfDate: '2026-06-17',
  });

  assert.deepEqual(status, {
    budget_id: 'budget-food',
    category: 'Food',
    parent_budget_id: null,
    budget_amount: 2000000,
    spent_amount: 500000,
    remaining_amount: 1500000,
    spent_percent: 25,
    child_breakdown: [],
    cycle_start: '2026-06-01',
    cycle_end: '2026-07-01',
  });
});

test('returns parent budget status with active child breakdown', async () => {
  const { service } = createService([
    [{ cycle_start_day: 1 }],
    [
      {
        budget_id: 'budget-living',
        category: 'Living',
        parent_budget_id: null,
        budget_amount: '5000000',
        spent_amount: '2250000',
        child_breakdown: [
          {
            budget_id: 'budget-food',
            category: 'Food',
            budget_amount: '2000000',
            spent_amount: '1250000',
          },
          {
            budget_id: 'budget-transport',
            category: 'Transport',
            budget_amount: '1000000',
            spent_amount: '250000',
          },
        ],
      },
    ],
  ]);

  const status = await service.getBudgetStatus({
    userId: 'user-1',
    category: 'Living',
    asOfDate: '2026-06-17',
  });

  assert.deepEqual(status, {
    budget_id: 'budget-living',
    category: 'Living',
    parent_budget_id: null,
    budget_amount: 5000000,
    spent_amount: 2250000,
    remaining_amount: 2750000,
    spent_percent: 45,
    child_breakdown: [
      {
        budget_id: 'budget-food',
        category: 'Food',
        budget_amount: 2000000,
        spent_amount: 1250000,
        remaining_amount: 750000,
        spent_percent: 62.5,
      },
      {
        budget_id: 'budget-transport',
        category: 'Transport',
        budget_amount: 1000000,
        spent_amount: 250000,
        remaining_amount: 750000,
        spent_percent: 25,
      },
    ],
    cycle_start: '2026-06-01',
    cycle_end: '2026-07-01',
  });
});

test('rejects missing budget status category', async () => {
  const { service } = createService();

  await assert.rejects(
    () =>
      service.getBudgetStatus({
        userId: 'user-1',
        category: ' ',
      }),
    BadRequestException,
  );
});

test('returns not found for inactive or missing category', async () => {
  const { service } = createService([[{ cycle_start_day: 1 }], []]);

  await assert.rejects(
    () =>
      service.getBudgetStatus({
        userId: 'user-1',
        category: 'Inactive Food',
        asOfDate: '2026-06-17',
      }),
    NotFoundException,
  );
});

test('uses custom cycle day for budget status lookup', async () => {
  const { calls, service } = createService([
    [{ cycle_start_day: 20 }],
    [
      {
        budget_id: 'budget-food',
        category: 'Food',
        parent_budget_id: null,
        budget_amount: '1000000',
        spent_amount: '100000',
        child_breakdown: '[]',
      },
    ],
  ]);

  const status = await service.getBudgetStatus({
    userId: 'user-1',
    category: 'Food',
    asOfDate: '2026-06-17',
  });

  assert.deepEqual(calls[1].values, [
    'user-1',
    'Food',
    '2026-05-20',
    '2026-06-20',
  ]);
  assert.equal(status.cycle_start, '2026-05-20');
  assert.equal(status.cycle_end, '2026-06-20');
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
  assert.match(calls[0].text, /\bamount,\s+parent_budget_id,/);
  assert.match(calls[0].text, /\bis_active\s+\)\s+VALUES \(\$1, \$2, \$3, \$4, \$5, true\)/);
  assert.match(calls[0].text, /budgets\.amount AS amount/);
  assert.doesNotMatch(calls[0].text, /budget_amount/);
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
    [{ id: 'parent-1', category: 'Monthly Allowance', inserted: false }],
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
  assert.deepEqual(calls[0].values, [
    'user-1',
    'Monthly Allowance',
    'monthly',
  ]);
  assert.match(calls[0].text, /AND category = \$2/);
  assert.match(
    calls[0].text,
    /WHERE NOT EXISTS \(SELECT 1 FROM existing_parent\)/,
  );
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

test('creates a missing parent budget before child budget upsert', async () => {
  const { calls, service } = createService([
    [{ id: 'parent-new', category: 'Monthly Allowance', inserted: true }],
    [
      {
        budget_id: 'budget-child',
        user_id: 'user-1',
        category: 'Food',
        amount: '1000000',
        parent_budget_id: 'parent-new',
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
  assert.deepEqual(calls[0].values, [
    'user-1',
    'Monthly Allowance',
    'monthly',
  ]);
  assert.match(calls[0].text, /INSERT INTO budgets/);
  assert.match(calls[0].text, /SELECT \$1, \$2, NULL, NULL, \$3, true/);
  assert.deepEqual(calls[1].values, [
    'user-1',
    'Food',
    1000000,
    'parent-new',
    'monthly',
    true,
  ]);
  assert.equal(result.parent_budget_id, 'parent-new');
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

test('updates amount and updated_at using the production budget amount column', async () => {
  const { calls, service } = createService([
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

  assert.match(calls[0].text, /amount = EXCLUDED\.amount/);
  assert.match(calls[0].text, /updated_at = now\(\)/);
  assert.doesNotMatch(calls[0].text, /budget_amount/);
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

test('uses case-sensitive parent category matching', async () => {
  const { calls, service } = createService([
    [{ id: 'parent-new', category: 'monthly allowance', inserted: true }],
    [
      {
        budget_id: 'budget-child',
        user_id: 'user-1',
        category: 'Food',
        amount: '1000000',
        parent_budget_id: 'parent-new',
        parent_category: 'monthly allowance',
        period_type: 'monthly',
        inserted: true,
      },
    ],
  ]);

  const result = await service.upsertBudget({
    userId: 'user-1',
    category: 'Food',
    amount: 1000000,
    parentCategory: 'monthly allowance',
  });

  assert.match(calls[0].text, /AND category = \$2/);
  assert.doesNotMatch(calls[0].text, /lower\(category\) = lower\(\$2\)/);
  assert.equal(result.parent_category, 'monthly allowance');
});

test('does not alert below 80 percent spending', async () => {
  const { calls, service } = createService([
    [{ cycle_start_day: 15 }],
    [
      {
        budget_id: 'budget-1',
        category: 'Food',
        parent_budget_id: null,
        budget_amount: '1000000',
        spent_amount: '790000',
      },
    ],
  ]);

  const result = await service.checkOverspending({
    userId: 'user-1',
    category: 'Food',
  });
  const cycle = service.calculateCurrentCycle(new Date(), 15);

  assert.equal(calls.length, 2);
  assert.equal(result.shouldAlert, false);
  assert.equal(result.alreadyAlerted, false);
  assert.equal(result.alertType, null);
  assert.equal(result.telegramHtml, null);
  assert.equal(result.alertRecord, null);
  assert.equal(result.spentPercent, 79);
  assert.equal(result.periodKey, service.periodKeyFromCycleStart(cycle.cycle_start));
});

test('does not alert at 79.9 percent spending', async () => {
  const { service } = createService([
    [{ cycle_start_day: 15 }],
    [
      {
        budget_id: 'budget-1',
        category: 'Food',
        parent_budget_id: null,
        budget_amount: '1000000',
        spent_amount: '799000',
      },
    ],
  ]);

  const result = await service.checkOverspending({
    userId: 'user-1',
    category: 'Food',
  });

  assert.equal(result.shouldAlert, false);
  assert.equal(result.alertType, null);
  assert.equal(result.spentPercent, 79.9);
});

test('alerts at 80 percent spending', async () => {
  const { calls, service } = createService([
    [{ cycle_start_day: 15 }],
    [
      {
        budget_id: 'budget-1',
        category: 'Food',
        parent_budget_id: null,
        budget_amount: '1000000',
        spent_amount: '800000',
      },
    ],
    [{ exists: false }],
  ]);

  const result = await service.checkOverspending({
    userId: 'user-1',
    category: 'Food',
  });
  const cycle = service.calculateCurrentCycle(new Date(), 15);
  const periodKey = service.periodKeyFromCycleStart(cycle.cycle_start);

  assert.equal(calls.length, 3);
  assert.doesNotMatch(calls[1].text, /budget_scope/);
  assert.match(calls[1].text, /JOIN selected_budget b ON lower\(t\.category\) = lower\(b\.category\)/);
  assert.deepEqual(calls[2].values, [
    'user-1',
    'budget-1',
    'overspend_80',
    periodKey,
  ]);
  assert.equal(result.shouldAlert, true);
  assert.equal(result.alreadyAlerted, false);
  assert.equal(result.alertType, 'overspend_80');
  assert.deepEqual(result.alertRecord, {
    budgetId: 'budget-1',
    alertType: 'overspend_80',
    periodKey,
  });
  assert.match(result.telegramHtml ?? '', /<b>Budget warning<\/b>/);
  assert.match(result.telegramHtml ?? '', /Category: <b>Food<\/b>/);
});

test('alerts at 100 percent spending', async () => {
  const { service } = createService([
    [{ cycle_start_day: 15 }],
    [
      {
        budget_id: 'budget-1',
        category: 'Food',
        parent_budget_id: null,
        budget_amount: '1000000',
        spent_amount: '1000000',
      },
    ],
    [{ exists: false }],
  ]);

  const result = await service.checkOverspending({
    userId: 'user-1',
    category: 'Food',
  });

  assert.equal(result.shouldAlert, true);
  assert.equal(result.alertType, 'overspend_100');
  assert.equal(result.spentPercent, 100);
});

test('alerts at 120 percent spending', async () => {
  const { service } = createService([
    [{ cycle_start_day: 15 }],
    [
      {
        budget_id: 'budget-1',
        category: 'Food',
        parent_budget_id: null,
        budget_amount: '1000000',
        spent_amount: '1200000',
      },
    ],
    [{ exists: false }],
  ]);

  const result = await service.checkOverspending({
    userId: 'user-1',
    category: 'Food',
  });

  assert.equal(result.shouldAlert, true);
  assert.equal(result.alertType, 'overspend_120');
  assert.equal(result.remainingAmount, -200000);
});

test('uses full cycle start date as overspending period key', async () => {
  const { service } = createService([
    [{ cycle_start_day: 15 }],
    [
      {
        budget_id: 'budget-1',
        category: 'Food',
        parent_budget_id: null,
        budget_amount: '1000000',
        spent_amount: '800000',
      },
    ],
    [{ exists: false }],
  ]);

  const result = await service.checkOverspending({
    userId: 'user-1',
    category: 'Food',
  });

  assert.match(result.periodKey, /^\d{4}-\d{2}-\d{2}$/);
});

test('does not alert again when duplicate budget alert exists', async () => {
  const { service } = createService([
    [{ cycle_start_day: 15 }],
    [
      {
        budget_id: 'budget-1',
        category: 'Food',
        parent_budget_id: null,
        budget_amount: '1000000',
        spent_amount: '854000',
      },
    ],
    [{ exists: true }],
  ]);

  const result = await service.checkOverspending({
    userId: 'user-1',
    category: 'Food',
  });
  const cycle = service.calculateCurrentCycle(new Date(), 15);
  const periodKey = service.periodKeyFromCycleStart(cycle.cycle_start);

  assert.deepEqual(result, {
    shouldAlert: false,
    alreadyAlerted: true,
    alertType: 'overspend_80',
    telegramHtml: null,
    alertRecord: {
      budgetId: 'budget-1',
      alertType: 'overspend_80',
      periodKey,
    },
    budgetId: 'budget-1',
    userId: 'user-1',
    category: 'Food',
    spentPercent: 85.4,
    spentAmount: 854000,
    budgetAmount: 1000000,
    remainingAmount: 146000,
    cycleStart: cycle.cycle_start,
    cycleEnd: cycle.cycle_end,
    periodKey,
  });
});

test('propagates missing budget errors during overspending check', async () => {
  const { service } = createService([[{ cycle_start_day: 15 }], []]);

  await assert.rejects(
    () =>
      service.checkOverspending({
        userId: 'user-1',
        category: 'Missing',
      }),
    NotFoundException,
  );
});
