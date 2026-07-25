import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { DashboardOverviewController } from './dashboard-overview.controller';
import { DashboardOverviewService } from './dashboard-overview.service';
import {
  DashboardOverviewRequestDto,
  DashboardOverviewResponseDto,
} from './dto/dashboard-overview.dto';

test('overview delegates the request and returns the service response', async () => {
  const request: DashboardOverviewRequestDto = {
    telegramUserId: '976684739',
    userId: 1,
    asOfDate: '2026-07-25',
    timezone: 'Asia/Jakarta',
  };
  const response = {
    user: { id: '1', telegramUserId: '976684739' },
    current: {
      period: {
        label: 'current_cycle',
        start: '2026-07-01',
        end: '2026-08-01',
      },
      hasTransactions: false,
      totals: { income: 0, spent: 0, netCashflow: 0, dailyAverage: 0 },
      comparison: { income: 0, spent: 0, netCashflow: 0, dailyAverage: 0 },
      dailySpend: [],
      categories: [],
      budgets: [],
      recentTransactions: [],
    },
    previous: {
      period: {
        label: 'previous_cycle',
        start: '2026-06-01',
        end: '2026-07-01',
      },
      hasTransactions: false,
      totals: { income: 0, spent: 0, netCashflow: 0, dailyAverage: 0 },
      comparison: { income: 0, spent: 0, netCashflow: 0, dailyAverage: 0 },
      dailySpend: [],
      categories: [],
      budgets: [],
      recentTransactions: [],
    },
  } satisfies DashboardOverviewResponseDto;
  const calls: DashboardOverviewRequestDto[] = [];
  const service = {
    getOverview: async (body: DashboardOverviewRequestDto) => {
      calls.push(body);
      return response;
    },
  };
  const controller = new DashboardOverviewController(
    service as unknown as DashboardOverviewService,
  );

  const result = await controller.overview(request);

  assert.equal(result, response);
  assert.deepEqual(calls, [request]);
});
