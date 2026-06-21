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

function createStateStore() {
  const calls: Array<{ method: string; request: unknown }> = [];

  return {
    calls,
    store: {
      upsertState: async (request: unknown) => {
        calls.push({ method: 'upsertState', request });
        return {};
      },
      resetState: async (request: unknown) => {
        calls.push({ method: 'resetState', request });
        return {};
      },
    },
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
  assert.match(calls[1].text, /SUM\(child_spending\.budget_amount\)/);
  assert.match(calls[1].text, /SUM\(child_spending\.spent_amount\)/);
  assert.match(calls[1].text, /child_breakdown\.child_breakdown/);
  assert.doesNotMatch(calls[1].text, /budget_scope/);
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

test('returns parent budget status with child aggregate totals and breakdown', async () => {
  const { service } = createService([
    [{ cycle_start_day: 1 }],
    [
      {
        budget_id: 'budget-living',
        category: 'Living',
        parent_budget_id: null,
        budget_amount: '3000000',
        spent_amount: '1500000',
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
    budget_amount: 3000000,
    spent_amount: 1500000,
    remaining_amount: 1500000,
    spent_percent: 50,
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
  assert.doesNotMatch(calls[0].text, /ON CONFLICT/);
  assert.match(calls[0].text, /WITH existing_budget AS/);
  assert.match(calls[0].text, /SELECT \$1::bigint, \$2, \$3, \$4::bigint, \$5, true/);
  assert.match(calls[0].text, /\bamount,\s+parent_budget_id,/);
  assert.match(calls[0].text, /changed_budget\.amount/);
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
  assert.match(calls[1].text, /parent_budget_id::text = \$4/);
  assert.doesNotMatch(calls[1].text, /ON CONFLICT/);
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
  assert.match(calls[0].text, /SELECT \$1::bigint, \$2, NULL, NULL, \$3, true/);
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

test('updates amount using the production budget amount column', async () => {
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

  assert.match(calls[0].text, /UPDATE budgets/);
  assert.match(calls[0].text, /amount = \$3/);
  assert.doesNotMatch(calls[0].text, /updated_at/);
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
  assert.doesNotMatch(calls[0].text, /ON CONFLICT/);
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

test('budget handle complete status resets state and returns status message', async () => {
  const { service } = createService([
    [{ cycle_start_day: 15 }],
    [
      {
        budget_id: 'budget-food',
        category: 'Food',
        parent_budget_id: null,
        budget_amount: '1000000',
        spent_amount: '250000',
        child_breakdown: [
          {
            budget_id: 'budget-snacks',
            category: 'Snacks',
            budget_amount: '200000',
            spent_amount: '50000',
          },
        ],
      },
    ],
  ]);
  const state = createStateStore();

  const result = await service.handleBudgetRequest(
    {
      telegramUserId: '123456789',
      userId: 1,
      text: 'status Food',
      statePayload: {},
      llmResult: {
        intent: 'budget_status',
        category: 'Food',
      },
    },
    state.store,
  );

  assert.equal(result.state.nextState, 'idle');
  assert.deepEqual(result.state.payload, {});
  assert.equal(state.calls[0].method, 'resetState');
  assert.match(result.message.text, /Budget status\./);
  assert.match(result.message.text, /Category: Food/);
  assert.match(result.message.text, /Budget: Rp1\.000\.000/);
  assert.match(result.message.text, /Spent: Rp250\.000/);
  assert.doesNotMatch(result.message.text, /cycle_start|cycle_end|2026-06-15/);
  assert.deepEqual(result.data.intent, 'budget_status');
});

test('budget overview returns all active budgets with parent child grouping', async () => {
  const { calls, service } = createService([
    [{ cycle_start_day: 15 }],
    [
      {
        budget_id: 'parent-1',
        category: 'Monthly Allowance',
        parent_budget_id: null,
        parent_category: null,
        amount: null,
        spent_amount: '0',
        child_count: '2',
      },
      {
        budget_id: 'parent-2',
        category: 'Subscription',
        parent_budget_id: null,
        parent_category: null,
        amount: null,
        spent_amount: '0',
        child_count: '1',
      },
      {
        budget_id: 'top-1',
        category: 'Health',
        parent_budget_id: null,
        parent_category: null,
        amount: '500000',
        spent_amount: '125000',
        child_count: '0',
      },
      {
        budget_id: 'child-food',
        category: 'Food',
        parent_budget_id: 'parent-1',
        parent_category: 'Monthly Allowance',
        amount: '2000000',
        spent_amount: '1000000',
        child_count: '0',
      },
      {
        budget_id: 'child-transport',
        category: 'Transport',
        parent_budget_id: 'parent-1',
        parent_category: 'Monthly Allowance',
        amount: '2000000',
        spent_amount: '1000000',
        child_count: '0',
      },
      {
        budget_id: 'child-netflix',
        category: 'Netflix',
        parent_budget_id: 'parent-2',
        parent_category: 'Subscription',
        amount: '37200',
        spent_amount: '37200',
        child_count: '0',
      },
    ],
  ]);
  const state = createStateStore();

  const result = await service.handleBudgetRequest(
    {
      telegramUserId: '123456789',
      userId: 1,
      text: 'show all budgets',
      statePayload: {},
      llmResult: {
        intent: 'budget_overview',
      },
    },
    state.store,
  );

  assert.equal(calls.length, 2);
  assert.equal(calls[1].values[0], '1');
  assert.match(String(calls[1].values[1]), /^\d{4}-\d{2}-\d{2}$/);
  assert.match(String(calls[1].values[2]), /^\d{4}-\d{2}-\d{2}$/);
  assert.match(calls[1].text, /WHERE b\.is_active = true/);
  assert.match(calls[1].text, /ORDER BY/);
  assert.equal(state.calls[0].method, 'resetState');
  assert.equal(result.state.nextState, 'idle');
  assert.deepEqual(result.state.payload, {});
  assert.deepEqual(result.data.intent, 'budget_overview');
  assert.deepEqual(result.data.messages, [result.message.text]);
  assert.equal(result.data.message, result.message.text);
  assert.match(result.message.text, /📊 Budget Overview/);
  assert.match(result.message.text, /Monthly Allowance - Rp2\.000\.000 \/ Rp4\.000\.000/);
  assert.match(result.message.text, /├ Food — Rp1\.000\.000 \/ Rp2\.000\.000/);
  assert.match(result.message.text, /└ Transport — Rp1\.000\.000 \/ Rp2\.000\.000/);
  assert.match(result.message.text, /Subscription - Rp37\.200 \/ Rp37\.200/);
  assert.match(result.message.text, /└ Netflix — Rp37\.200 \/ Rp37\.200/);
  assert.match(result.message.text, /Health - Rp125\.000 \/ Rp500\.000/);
});

test('budget overview returns empty-state message when no active budgets exist', async () => {
  const { service } = createService([[{ cycle_start_day: 1 }], []]);
  const state = createStateStore();

  const result = await service.handleBudgetRequest(
    {
      userId: 1,
      statePayload: {},
      llmResult: {
        intent: 'budget_overview',
      },
    },
    state.store,
  );

  assert.equal(result.message.text, 'No active budgets yet. Set one when you are ready.');
  assert.deepEqual(result.data, {
    intent: 'budget_overview',
    messages: ['No active budgets yet. Set one when you are ready.'],
    message: 'No active budgets yet. Set one when you are ready.',
  });
  assert.equal(state.calls[0].method, 'resetState');
});

test('budget overview splits long output into multiple messages by budget group', async () => {
  const rows = Array.from({ length: 170 }, (_, index) => ({
    budget_id: `budget-${index}`,
    category: `Very Long Budget Category ${String(index).padStart(3, '0')}`,
    parent_budget_id: null,
    parent_category: null,
    amount: '1000000',
    spent_amount: '250000',
    child_count: '0',
  }));
  const { service } = createService([[{ cycle_start_day: 1 }], rows]);
  const state = createStateStore();

  const result = await service.handleBudgetRequest(
    {
      userId: 1,
      statePayload: {},
      llmResult: {
        intent: 'budget_overview',
      },
    },
    state.store,
  );

  const messages = result.data.messages as string[];

  assert.ok(messages.length > 1);
  messages.forEach((message) => {
    assert.ok(message.length <= 3500);
    assert.match(message, /📊 Budget Overview/);
  });
  assert.equal(result.message.text, messages[0]);
  assert.equal(result.data.message, messages[0]);
});

test('budget handle incomplete set budget saves pending state and asks amount', async () => {
  const { service } = createService();
  const state = createStateStore();

  const result = await service.handleBudgetRequest(
    {
      userId: 1,
      text: 'set Food budget',
      statePayload: {},
      llmResult: {
        intent: 'set_budget',
        category: 'Food',
        missing_fields: ['amount'],
      },
    },
    state.store,
  );

  assert.equal(result.state.nextState, 'budget_conversation_state');
  assert.deepEqual(result.state.payload, {
    intent: 'set_budget',
    category: 'Food',
    missing_fields: ['amount'],
    pending: true,
  });
  assert.deepEqual(state.calls, [
    {
      method: 'upsertState',
      request: {
        userId: 1,
        stateName: 'budget_conversation_state',
        stateData: result.state.payload,
      },
    },
  ]);
  assert.equal(result.message.text, 'How much for Food?');
});

test('budget handle follow-up amount merges pending state and calls upsert', async () => {
  const { calls, service } = createService([
    [
      {
        budget_id: 'budget-1',
        user_id: '1',
        category: 'Food',
        amount: '1000000',
        parent_budget_id: null,
        parent_category: null,
        period_type: 'monthly',
        inserted: false,
      },
    ],
  ]);
  const state = createStateStore();

  const result = await service.handleBudgetRequest(
    {
      userId: 1,
      text: '1 juta',
      statePayload: {
        intent: 'set_budget',
        category: 'Food',
        pending: true,
        missing_fields: ['amount'],
      },
      llmResult: {
        intent: 'unknown',
        amount: 1000000,
        missing_fields: [],
      },
    },
    state.store,
  );

  assert.deepEqual(calls[0].values, [
    '1',
    'Food',
    1000000,
    null,
    'monthly',
    false,
  ]);
  assert.equal(state.calls[0].method, 'resetState');
  assert.equal(result.state.nextState, 'idle');
  assert.match(result.message.text, /Budget updated\./);
  assert.match(result.message.text, /Amount: Rp1\.000\.000/);
  assert.equal(result.data.intent, 'set_budget');
});

test('budget handle set sub budget without parent asks parent question', async () => {
  const { service } = createService();
  const state = createStateStore();

  const result = await service.handleBudgetRequest(
    {
      userId: 1,
      text: 'set Transport under parent',
      statePayload: {},
      llmResult: {
        intent: 'set_sub_budget',
        category: 'Transport',
        amount: 500000,
      },
    },
    state.store,
  );

  assert.equal(result.state.nextState, 'budget_conversation_state');
  assert.equal(result.message.text, 'Under which parent budget should Transport sit?');
  assert.deepEqual(result.data, {
    intent: 'set_sub_budget',
    category: 'Transport',
    parent_category: null,
    missing_field: 'parent_category',
  });
  assert.equal(state.calls[0].method, 'upsertState');
});

test('budget handle complete set sub budget calls upsert with parent category', async () => {
  const { calls, service } = createService([
    [{ id: 'parent-1', category: 'Living', inserted: false }],
    [
      {
        budget_id: 'budget-transport',
        user_id: '1',
        category: 'Transport',
        amount: '500000',
        parent_budget_id: 'parent-1',
        parent_category: 'Living',
        period_type: 'monthly',
        inserted: true,
      },
    ],
  ]);
  const state = createStateStore();

  const result = await service.handleBudgetRequest(
    {
      userId: 1,
      statePayload: {},
      llmResult: {
        intent: 'set_sub_budget',
        category: 'Transport',
        parent_category: 'Living',
        amount: 500000,
      },
    },
    state.store,
  );

  assert.deepEqual(calls[0].values, ['1', 'Living', 'monthly']);
  assert.deepEqual(calls[1].values, [
    '1',
    'Transport',
    500000,
    'parent-1',
    'monthly',
    true,
  ]);
  assert.equal(result.state.nextState, 'idle');
  assert.match(result.message.text, /Parent: Living/);
  assert.equal(result.data.intent, 'set_sub_budget');
});

test('budget handle reset and cancel set idle', async () => {
  const { service } = createService();
  const resetState = createStateStore();
  const cancelState = createStateStore();

  const resetResult = await service.handleBudgetRequest(
    {
      userId: 1,
      statePayload: { intent: 'set_budget', category: 'Food', pending: true },
      llmResult: { intent: 'reset' },
    },
    resetState.store,
  );
  const cancelResult = await service.handleBudgetRequest(
    {
      userId: 1,
      text: 'batal',
      statePayload: { intent: 'set_budget', category: 'Food', pending: true },
      llmResult: { intent: 'unknown' },
    },
    cancelState.store,
  );

  assert.equal(resetResult.state.nextState, 'idle');
  assert.deepEqual(resetResult.state.payload, {});
  assert.equal(cancelResult.state.nextState, 'idle');
  assert.deepEqual(cancelResult.state.payload, {});
  assert.equal(resetState.calls[0].method, 'resetState');
  assert.equal(cancelState.calls[0].method, 'resetState');
  assert.equal(cancelResult.message.text, 'Budget action cancelled.');
});

test('budget handle delete intent returns not wired and sets idle', async () => {
  const { service } = createService();
  const state = createStateStore();

  const result = await service.handleBudgetRequest(
    {
      userId: 1,
      statePayload: {},
      llmResult: {
        intent: 'delete_budget',
        category: 'Food',
      },
    },
    state.store,
  );

  assert.equal(result.state.nextState, 'idle');
  assert.deepEqual(result.state.payload, {});
  assert.equal(state.calls[0].method, 'resetState');
  assert.equal(result.message.text, 'Delete not wired yet. Budget unchanged.');
  assert.deepEqual(result.data, {
    intent: 'delete_budget',
    category: 'Food',
    parent_category: null,
  });
});

test('budget handle unknown intent resets state with short clarification', async () => {
  const { service } = createService();
  const state = createStateStore();

  const result = await service.handleBudgetRequest(
    {
      userId: 1,
      text: 'wat',
      statePayload: {},
      llmResult: { intent: 'unknown' },
    },
    state.store,
  );

  assert.equal(result.state.nextState, 'idle');
  assert.deepEqual(result.state.payload, {});
  assert.equal(state.calls[0].method, 'resetState');
  assert.equal(result.message.text, 'What do you want to do: show or set a budget?');
  assert.deepEqual(result.data, { intent: 'unknown' });
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
