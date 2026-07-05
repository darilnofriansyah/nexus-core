import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AmountCount,
  BreakdownItem,
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

  async categoryTotal() {
    return { total: 75000, count: 3 };
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
  assert.equal(result.data.average_per_day, 100000 / 9);
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
