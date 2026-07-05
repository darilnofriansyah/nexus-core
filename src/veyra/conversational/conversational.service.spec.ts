import * as assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import {
  AmountCount,
  BreakdownItem,
  BudgetItem,
  CashflowSummary,
  ConversationalRepository,
  ConversationalUser,
  DailyItem,
  TransactionItem,
} from './conversational.repository';
import { clampLimit, ConversationalService } from './conversational.service';

class FakeRepository {
  user: ConversationalUser | null = {
    id: '1',
    telegramUserId: '976684739',
    cycleStartDay: 25,
  };
  lastFindUser: {
    userId: string | null;
    telegramUserId: string | null;
  } | null = null;
  expenseTotals: AmountCount[] = [{ total: 100000, count: 2 }];
  categories: BreakdownItem[] = [{ name: 'Food', amount: 60000, count: 1 }];
  merchants: BreakdownItem[] = [{ name: 'GoPay', amount: 40000, count: 1 }];
  transactions: TransactionItem[] = [
    {
      id: '10',
      amount: 50000,
      merchant: 'GoPay',
      category: 'Food',
      transactionDate: '2026-07-01',
    },
  ];
  days: DailyItem[] = [{ date: '2026-07-01', amount: 50000, count: 1 }];
  budgets: BudgetItem[] = [];
  categoryTotals = new Map<string, AmountCount>([
    ['food', { total: 400000, count: 10 }],
  ]);
  cashflow: CashflowSummary = {
    incomeTotal: 200000,
    expenseTotal: 50000,
    net: 150000,
    incomeCount: 1,
    expenseCount: 1,
  };

  async findUser(userId: string | null, telegramUserId: string | null) {
    this.lastFindUser = { userId, telegramUserId };
    return this.user;
  }

  async expenseTotal() {
    return this.expenseTotals.shift() ?? { total: 0, count: 0 };
  }

  async categoryTotal(
    _userId?: string,
    category?: string,
  ): Promise<AmountCount> {
    return (
      this.categoryTotals.get(String(category).toLowerCase()) ?? {
        total: 75000,
        count: 3,
      }
    );
  }

  async merchantTotal() {
    return { total: 65000, count: 2 };
  }

  async topCategories() {
    return this.categories;
  }

  async topMerchants() {
    return this.merchants;
  }

  async largestTransactions() {
    return this.transactions;
  }

  async recentTransactions() {
    return this.transactions;
  }

  async spendingByDay() {
    return this.days;
  }

  async cashflowSummary() {
    return this.cashflow;
  }

  async activeBudgets(
    _userId?: string,
    category?: string | null,
  ): Promise<BudgetItem[]> {
    return category
      ? this.budgets.filter(
          (budget) => budget.category.toLowerCase() === category.toLowerCase(),
        )
      : this.budgets;
  }
}

function createService(repo = new FakeRepository()) {
  return {
    repo,
    service: new ConversationalService(
      repo as unknown as ConversationalRepository,
    ),
  };
}

test('resolves current_cycle and previous_cycle from cycle_start_day', () => {
  const { service } = createService();
  const now = new Date('2026-07-03T05:00:00.000Z');

  assert.deepEqual(
    service.resolvePeriod('current_cycle', 25, 'Asia/Jakarta', now),
    {
      label: 'current_cycle',
      start: '2026-06-25',
      end: '2026-07-25',
    },
  );
  assert.deepEqual(
    service.resolvePeriod('previous_cycle', 25, 'Asia/Jakarta', now),
    {
      label: 'previous_cycle',
      start: '2026-05-25',
      end: '2026-06-25',
    },
  );
});

test('burn_rate_forecast calculates current cycle from cycle_start_day', async () => {
  mock.timers.enable({
    apis: ['Date'],
    now: new Date('2026-07-05T02:00:00.000Z'),
  });
  try {
    const { repo, service } = createService();
    repo.expenseTotals = [{ total: 2500000, count: 10 }];

    const result = await service.handle({
      userId: 1,
      timezone: 'Asia/Jakarta',
      llmResult: { intent: 'burn_rate_forecast', period: 'this_month' },
    });

    assert.equal(result.status, 'ok');
    assert.equal(result.data.cycleStart, '2026-06-25');
    assert.equal(result.data.cycleEnd, '2026-07-25');
    assert.equal(result.data.elapsedDays, 11);
    assert.equal(result.data.status, 'safe');
    assert.match(result.message.text, /No budget limit found/);
  } finally {
    mock.timers.reset();
  }
});

test('burn_rate_forecast returns no_data without transactions', async () => {
  mock.timers.enable({
    apis: ['Date'],
    now: new Date('2026-07-05T02:00:00.000Z'),
  });
  try {
    const { repo, service } = createService();
    repo.expenseTotals = [{ total: 0, count: 0 }];

    const result = await service.handle({
      userId: 1,
      llmResult: { intent: 'burn_rate_forecast' },
    });

    assert.equal(result.status, 'ok');
    assert.equal(result.data.status, 'no_data');
    assert.equal(result.data.spentSoFar, 0);
    assert.match(result.message.text, /No confirmed spending/);
  } finally {
    mock.timers.reset();
  }
});

test('burn_rate_forecast does not use a category budget for overall forecast', async () => {
  mock.timers.enable({
    apis: ['Date'],
    now: new Date('2026-07-05T02:00:00.000Z'),
  });
  try {
    const { repo, service } = createService();
    repo.expenseTotals = [{ total: 2500000, count: 10 }];
    repo.budgets = [{ category: 'Food', amount: 500000 }];
    repo.categoryTotals.set('food', { total: 200000, count: 2 });

    const result = await service.handle({
      userId: 1,
      timezone: 'Asia/Jakarta',
      llmResult: { intent: 'burn_rate_forecast', category: null },
    });

    assert.equal(result.data.category, null);
    assert.equal(result.data.budgetLimit, null);
    assert.match(result.message.text, /No budget limit found/);
    assert.deepEqual(result.data.perBudgetForecasts, [
      {
        cycleStart: '2026-06-25',
        cycleEnd: '2026-07-25',
        today: '2026-07-05',
        elapsedDays: 11,
        daysLeft: 19,
        totalCycleDays: 30,
        category: 'Food',
        spentSoFar: 200000,
        averageDailySpend: 18181.81818181818,
        projectedCycleSpend: 545454.5454545454,
        budgetLimit: 500000,
        remainingBudget: 300000,
        safeDailySpend: 15789.473684210527,
        projectedOverrun: 45454.54545454541,
        projectedRemaining: 0,
        exhaustionDate: '2026-07-23',
        status: 'projected_overrun',
      },
    ]);
  } finally {
    mock.timers.reset();
  }
});

test('burn_rate_forecast reports safe category budget', async () => {
  mock.timers.enable({
    apis: ['Date'],
    now: new Date('2026-07-04T18:00:00.000Z'),
  });
  try {
    const { repo, service } = createService();
    repo.budgets = [{ category: 'Food', amount: 1200000 }];
    repo.categoryTotals.set('food', { total: 400000, count: 10 });

    const result = await service.handle({
      userId: 1,
      timezone: 'Asia/Jakarta',
      llmResult: { intent: 'burn_rate_forecast', category: 'Food' },
    });

    assert.equal(result.data.status, 'safe');
    assert.equal(result.data.budgetLimit, 1200000);
    assert.equal(result.data.category, 'Food');
    assert.match(result.message.text, /Food burn-rate forecast/);
  } finally {
    mock.timers.reset();
  }
});

test('burn_rate_forecast reports projected overrun', async () => {
  mock.timers.enable({
    apis: ['Date'],
    now: new Date('2026-07-04T18:00:00.000Z'),
  });
  try {
    const { repo, service } = createService();
    repo.budgets = [{ category: 'Food', amount: 1000000 }];
    repo.categoryTotals.set('food', { total: 800000, count: 10 });

    const result = await service.handle({
      userId: 1,
      timezone: 'Asia/Jakarta',
      llmResult: { intent: 'burn_rate_forecast', category: 'Food' },
    });

    assert.equal(result.data.status, 'projected_overrun');
    assert.equal(result.data.projectedOverrun, 1181818.1818181816);
    assert.match(result.message.text, /Slow down/);
  } finally {
    mock.timers.reset();
  }
});

test('burn_rate_forecast reports already exceeded budget', async () => {
  mock.timers.enable({
    apis: ['Date'],
    now: new Date('2026-07-04T18:00:00.000Z'),
  });
  try {
    const { repo, service } = createService();
    repo.budgets = [{ category: 'Food', amount: 1000000 }];
    repo.categoryTotals.set('food', { total: 1200000, count: 10 });

    const result = await service.handle({
      userId: 1,
      timezone: 'Asia/Jakarta',
      llmResult: { intent: 'burn_rate_forecast', category: 'Food' },
    });

    assert.equal(result.data.status, 'already_over_budget');
    assert.equal(result.data.remainingBudget, -200000);
    assert.match(result.message.text, /already over budget/);
  } finally {
    mock.timers.reset();
  }
});

test('burn_rate_forecast respects timezone and elapsedDays never hits zero', async () => {
  mock.timers.enable({
    apis: ['Date'],
    now: new Date('2026-06-24T18:00:00.000Z'),
  });
  try {
    const { repo, service } = createService();
    repo.expenseTotals = [{ total: 50000, count: 1 }];

    const result = await service.handle({
      userId: 1,
      timezone: 'Asia/Jakarta',
      llmResult: { intent: 'burn_rate_forecast' },
    });

    assert.equal(result.data.today, '2026-06-25');
    assert.equal(result.data.cycleStart, '2026-06-25');
    assert.equal(result.data.elapsedDays, 1);
  } finally {
    mock.timers.reset();
  }
});

test('formats Indonesian Rupiah and clamps limit', () => {
  const { service } = createService();

  assert.equal(service.formatRupiah(1250000), 'Rp1.250.000');
  assert.equal(clampLimit(0), 1);
  assert.equal(clampLimit(20), 10);
  assert.equal(clampLimit('bad'), 5);
});

test('spending_trend always returns needs_insight when data exists', async () => {
  const { repo, service } = createService();
  repo.expenseTotals = [
    { total: 100000, count: 2 },
    { total: 0, count: 0 },
  ];

  const result = await service.handle({
    telegramUserId: '976684739',
    text: 'trend?',
    llmResult: { intent: 'spending_trend' },
  });

  assert.equal(result.status, 'needs_insight');
  assert.equal(result.insight_payload?.facts.change_percent, null);
});

test('cashflow_summary always returns needs_insight when data exists', async () => {
  const { service } = createService();

  const result = await service.handle({
    userId: 1,
    llmResult: { intent: 'cashflow_summary' },
  });

  assert.equal(result.status, 'needs_insight');
  assert.equal(result.data.net, 150000);
});

test('daily_average_spending always returns needs_insight when data exists', async () => {
  const { service } = createService();

  const result = await service.handle({
    userId: 1,
    llmResult: { intent: 'daily_average_spending' },
  });

  assert.equal(result.status, 'needs_insight');
  assert.equal(
    result.data.average_per_day,
    100000 / Number(result.data.days_elapsed),
  );
});

test('spending_summary returns needs_insight only when requested', async () => {
  const directService = createService().service;
  const insightService = createService().service;

  const direct = await directService.handle({
    userId: 1,
    llmResult: { intent: 'spending_summary', needs_insight: false },
  });
  const insight = await insightService.handle({
    userId: 1,
    llmResult: { intent: 'spending_summary', needs_insight: true },
  });

  assert.equal(direct.status, 'ok');
  assert.equal(insight.status, 'needs_insight');
});

test('top_categories returns ok when needs_insight is false', async () => {
  const { service } = createService();

  const result = await service.handle({
    userId: 1,
    llmResult: { intent: 'top_categories', needs_insight: false },
  });

  assert.equal(result.status, 'ok');
});

test('category_spending ignores needs_insight and returns direct response', async () => {
  const { service } = createService();

  const result = await service.handle({
    userId: 1,
    llmResult: {
      intent: 'category_spending',
      category: 'Food & Drinks',
      needs_insight: true,
    },
  });

  assert.equal(result.status, 'ok');
  assert.match(result.message.text, /Food &amp; Drinks/);
});

test('recent_transactions ignores needs_insight and returns direct response', async () => {
  const { service } = createService();

  const result = await service.handle({
    userId: 1,
    llmResult: { intent: 'recent_transactions', needs_insight: true },
  });

  assert.equal(result.status, 'ok');
  assert.equal(result.insight_payload, null);
});

test('missing category returns missing_field', async () => {
  const { service } = createService();

  const result = await service.handle({
    userId: 1,
    llmResult: { intent: 'category_spending' },
  });

  assert.equal(result.status, 'missing_field');
});

test('unsupported intent returns unsupported_intent', async () => {
  const { service } = createService();

  const result = await service.handle({
    userId: 1,
    llmResult: { intent: 'subscription_summary' },
  });

  assert.equal(result.status, 'unsupported_intent');
});

test('resolves user by normalized telegramUserId', async () => {
  const { repo, service } = createService();

  const result = await service.handle({
    telegramUserId: 976684739,
    llmResult: { intent: 'transaction_count' },
  });

  assert.equal(result.status, 'ok');
  assert.deepEqual(repo.lastFindUser, {
    userId: null,
    telegramUserId: '976684739',
  });
});
