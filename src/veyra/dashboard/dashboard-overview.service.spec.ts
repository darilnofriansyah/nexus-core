import * as assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import {
  DashboardBudget,
  DashboardOverviewRepository,
  DashboardTransaction,
  DashboardUser,
} from './dashboard-overview.repository';
import { DashboardOverviewService } from './dashboard-overview.service';

class FakeDashboardRepository {
  user: DashboardUser | null = {
    id: '1',
    telegramUserId: '976684739',
    cycleStartDay: 1,
  };
  transactions: DashboardTransaction[] = [];
  budgets: DashboardBudget[] = [];
  findUserCalls: Array<{
    userId: string | null;
    telegramUserId: string | null;
  }> = [];
  transactionCalls: Array<{
    userId: string;
    start: string;
    end: string;
    timezone: string;
  }> = [];

  async findUser(userId: string | null, telegramUserId: string | null) {
    this.findUserCalls.push({ userId, telegramUserId });
    return this.user;
  }

  async findTransactions(
    userId: string,
    start: string,
    end: string,
    timezone: string,
  ) {
    this.transactionCalls.push({ userId, start, end, timezone });
    return this.transactions;
  }

  async findActiveBudgets() {
    return this.budgets;
  }
}

function createService() {
  const repository = new FakeDashboardRepository();
  const service = new DashboardOverviewService(
    repository as unknown as DashboardOverviewRepository,
  );

  return { repository, service };
}

function transaction(
  id: string,
  date: string,
  amount: number,
  type: 'income' | 'expense' = 'expense',
  category: string | null = 'Food',
  merchant: string | null = 'Merchant',
): DashboardTransaction {
  return {
    id,
    date,
    amount,
    type,
    category,
    merchant,
    timestamp: `${date}T03:00:00.000Z`,
  };
}

test('requires at least one valid identifier', async () => {
  const { service } = createService();

  await assert.rejects(() => service.getOverview({}), BadRequestException);
  await assert.rejects(
    () => service.getOverview({ userId: 'abc' }),
    BadRequestException,
  );
  await assert.rejects(
    () => service.getOverview({ telegramUserId: 0 }),
    BadRequestException,
  );
});

test('normalizes either identifier to strings before lookup', async () => {
  const { repository, service } = createService();

  await service.getOverview({
    telegramUserId: 976684739,
    asOfDate: '2026-07-25',
  });
  await service.getOverview({ userId: 1, asOfDate: '2026-07-25' });

  assert.deepEqual(repository.findUserCalls, [
    { userId: null, telegramUserId: '976684739' },
    { userId: '1', telegramUserId: null },
  ]);
});

test('returns not found when supplied identifiers do not resolve one user', async () => {
  const { repository, service } = createService();
  repository.user = null;

  await assert.rejects(
    () =>
      service.getOverview({
        userId: 1,
        telegramUserId: 999,
        asOfDate: '2026-07-25',
      }),
    NotFoundException,
  );
});

test('returns not found when Telegram user lookup is missing or inactive', async () => {
  const { repository, service } = createService();
  repository.user = null;

  await assert.rejects(
    () =>
      service.getOverview({
        telegramUserId: 976684739,
        asOfDate: '2026-07-25',
      }),
    NotFoundException,
  );
});

test('rejects invalid dates and timezones', async () => {
  const { service } = createService();

  await assert.rejects(
    () => service.getOverview({ userId: 1, asOfDate: '2026-02-30' }),
    BadRequestException,
  );
  await assert.rejects(
    () =>
      service.getOverview({
        userId: 1,
        asOfDate: '2026-07-25',
        timezone: 'Mars/Olympus',
      }),
    BadRequestException,
  );
});

test('defaults the date to today in Asia/Jakarta', async () => {
  mock.timers.enable({
    apis: ['Date'],
    now: new Date('2026-07-24T18:00:00.000Z'),
  });

  try {
    const { repository, service } = createService();
    repository.user = {
      id: '1',
      telegramUserId: '976684739',
      cycleStartDay: 25,
    };

    const result = await service.getOverview({ userId: 1 });

    assert.equal(result.current.period.start, '2026-07-25');
    assert.equal(repository.transactionCalls[0].end, '2026-07-26');
    assert.equal(repository.transactionCalls[0].timezone, 'Asia/Jakarta');
  } finally {
    mock.timers.reset();
  }
});

test('calculates current and previous boundaries for cycle start day 31', async () => {
  const { repository, service } = createService();
  repository.user = {
    id: '1',
    telegramUserId: '976684739',
    cycleStartDay: 31,
  };

  const result = await service.getOverview({
    userId: 1,
    asOfDate: '2026-03-30',
    timezone: 'Asia/Jakarta',
  });

  assert.deepEqual(result.current.period, {
    label: 'current_cycle',
    start: '2026-02-28',
    end: '2026-03-31',
  });
  assert.deepEqual(result.previous.period, {
    label: 'previous_cycle',
    start: '2026-01-31',
    end: '2026-02-28',
  });
  assert.deepEqual(repository.transactionCalls, [
    {
      userId: '1',
      start: '2025-12-31',
      end: '2026-03-31',
      timezone: 'Asia/Jakarta',
    },
  ]);
});

test('current comparison uses the same elapsed days from the previous cycle', async () => {
  const { repository, service } = createService();
  repository.user = {
    id: '1',
    telegramUserId: '976684739',
    cycleStartDay: 15,
  };
  repository.transactions = [
    transaction('1', '2026-07-20', 50),
    transaction('2', '2026-06-25', 100),
    transaction('3', '2026-06-30', 200),
    transaction('4', '2026-05-20', 400),
  ];

  const result = await service.getOverview({
    userId: 1,
    asOfDate: '2026-07-25',
  });

  assert.equal(result.current.totals.spent, 50);
  assert.equal(result.current.comparison.spent, 100);
  assert.equal(result.current.comparison.dailyAverage, 9);
  assert.equal(result.previous.totals.spent, 300);
  assert.equal(result.previous.comparison.spent, 400);
});

test('maps cashflow, daily spending, categories, recent transactions, and parent budgets', async () => {
  const { repository, service } = createService();
  repository.transactions = [
    transaction('4', '2026-07-24', 25000, 'expense', 'Food', 'TUKU'),
    transaction('3', '2026-07-15', 725000, 'expense', 'food', 'Market'),
    transaction('2', '2026-07-10', 1000000, 'expense', 'Transport', 'MRT'),
    transaction('1', '2026-07-05', 10000000, 'income', null, null),
  ];
  repository.budgets = [
    { id: '10', parentId: null, category: 'Living', amount: 9999999 },
    { id: '11', parentId: '10', category: 'Food', amount: 1500000 },
    { id: '12', parentId: '10', category: 'Transport', amount: 2000000 },
    { id: '20', parentId: null, category: 'Shopping', amount: 1000000 },
  ];

  const result = await service.getOverview({
    telegramUserId: '976684739',
    asOfDate: '2026-07-25',
  });

  assert.deepEqual(result.user, {
    id: '1',
    telegramUserId: '976684739',
  });
  assert.equal(result.current.hasTransactions, true);
  assert.deepEqual(result.current.totals, {
    income: 10000000,
    spent: 1750000,
    netCashflow: 8250000,
    dailyAverage: 70000,
  });
  assert.deepEqual(result.current.dailySpend, [
    { date: '2026-07-10', amount: 1000000 },
    { date: '2026-07-15', amount: 725000 },
    { date: '2026-07-24', amount: 25000 },
  ]);
  assert.deepEqual(result.current.categories, [
    {
      category: 'Transport',
      amount: 1000000,
      percent: 57,
      transactionCount: 1,
    },
    {
      category: 'Food',
      amount: 750000,
      percent: 43,
      transactionCount: 2,
    },
  ]);
  assert.deepEqual(result.current.budgets, [
    {
      category: 'Living',
      limit: 3500000,
      spent: 1750000,
      percent: 50,
      status: 'on-track',
    },
    {
      category: 'Shopping',
      limit: 1000000,
      spent: 0,
      percent: 0,
      status: 'on-track',
    },
  ]);
  assert.deepEqual(result.current.recentTransactions[0], {
    id: '4',
    date: '2026-07-24',
    merchant: 'TUKU',
    category: 'Food',
    amount: 25000,
    type: 'expense',
  });
  assert.deepEqual(result.current.recentTransactions[3], {
    id: '1',
    date: '2026-07-05',
    merchant: null,
    category: null,
    amount: 10000000,
    type: 'income',
  });
});

test('returns five categories plus an Others rollup', async () => {
  const { repository, service } = createService();
  repository.transactions = [
    transaction('1', '2026-07-01', 600, 'expense', 'A'),
    transaction('2', '2026-07-02', 500, 'expense', 'B'),
    transaction('3', '2026-07-03', 400, 'expense', 'C'),
    transaction('4', '2026-07-04', 300, 'expense', 'D'),
    transaction('5', '2026-07-05', 200, 'expense', 'E'),
    transaction('6', '2026-07-06', 100, 'expense', 'F'),
    transaction('7', '2026-07-07', 50, 'expense', 'G'),
  ];

  const result = await service.getOverview({
    userId: 1,
    asOfDate: '2026-07-25',
  });

  assert.equal(result.current.categories.length, 6);
  assert.deepEqual(result.current.categories[5], {
    category: 'Others',
    amount: 150,
    percent: 7,
    transactionCount: 2,
  });
});

test('returns only the five latest transactions', async () => {
  const { repository, service } = createService();
  repository.transactions = [
    transaction('6', '2026-07-06', 6),
    transaction('5', '2026-07-05', 5),
    transaction('4', '2026-07-04', 4),
    transaction('3', '2026-07-03', 3),
    transaction('2', '2026-07-02', 2),
    transaction('1', '2026-07-01', 1),
  ];

  const result = await service.getOverview({
    userId: 1,
    asOfDate: '2026-07-25',
  });

  assert.deepEqual(
    result.current.recentTransactions.map(({ id }) => id),
    ['6', '5', '4', '3', '2'],
  );
});

test('applies budget status thresholds and returns four highest priorities', async () => {
  const { repository, service } = createService();
  repository.budgets = [
    { id: '1', parentId: null, category: 'Below', amount: 100 },
    { id: '2', parentId: null, category: 'Eighty', amount: 100 },
    { id: '3', parentId: null, category: 'Hundred', amount: 100 },
    { id: '4', parentId: null, category: 'Over', amount: 100 },
    { id: '5', parentId: null, category: 'Unused', amount: 100 },
  ];
  repository.transactions = [
    transaction('1', '2026-07-01', 79, 'expense', 'Below'),
    transaction('2', '2026-07-02', 80, 'expense', 'Eighty'),
    transaction('3', '2026-07-03', 100, 'expense', 'Hundred'),
    transaction('4', '2026-07-04', 101, 'expense', 'Over'),
  ];

  const result = await service.getOverview({
    userId: 1,
    asOfDate: '2026-07-25',
  });

  assert.deepEqual(
    result.current.budgets.map(({ category, percent, status }) => ({
      category,
      percent,
      status,
    })),
    [
      { category: 'Over', percent: 101, status: 'over' },
      { category: 'Hundred', percent: 100, status: 'warning' },
      { category: 'Eighty', percent: 80, status: 'warning' },
      { category: 'Below', percent: 79, status: 'on-track' },
    ],
  );
});

test('returns complete zero and empty sections for a valid inactive user', async () => {
  const { service } = createService();

  const result = await service.getOverview({
    userId: 1,
    asOfDate: '2026-07-25',
  });

  assert.equal(result.current.hasTransactions, false);
  assert.deepEqual(result.current.totals, {
    income: 0,
    spent: 0,
    netCashflow: 0,
    dailyAverage: 0,
  });
  assert.deepEqual(result.current.comparison, result.current.totals);
  assert.deepEqual(result.current.dailySpend, []);
  assert.deepEqual(result.current.categories, []);
  assert.deepEqual(result.current.budgets, []);
  assert.deepEqual(result.current.recentTransactions, []);
  assert.equal(result.previous.hasTransactions, false);
});
