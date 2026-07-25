export interface DashboardOverviewRequestDto {
  telegramUserId?: string | number | null;
  userId?: string | number | null;
  asOfDate?: string | null;
  timezone?: string | null;
}

export interface DashboardOverviewUserDto {
  id: string;
  telegramUserId: string;
}

export interface DashboardPeriodDto {
  label: 'current_cycle' | 'previous_cycle';
  start: string;
  end: string;
}

export interface DashboardTotalsDto {
  income: number;
  spent: number;
  netCashflow: number;
  dailyAverage: number;
}

export interface DashboardDailySpendDto {
  date: string;
  amount: number;
}

export interface DashboardCategoryDto {
  category: string;
  amount: number;
  percent: number;
  transactionCount: number;
}

export type DashboardBudgetStatus = 'on-track' | 'warning' | 'over';

export interface DashboardBudgetDto {
  category: string;
  limit: number;
  spent: number;
  percent: number;
  status: DashboardBudgetStatus;
}

export interface DashboardRecentTransactionDto {
  id: string;
  date: string;
  merchant: string | null;
  category: string | null;
  amount: number;
  type: 'income' | 'expense';
}

export interface DashboardPeriodOverviewDto {
  period: DashboardPeriodDto;
  hasTransactions: boolean;
  totals: DashboardTotalsDto;
  comparison: DashboardTotalsDto;
  dailySpend: DashboardDailySpendDto[];
  categories: DashboardCategoryDto[];
  budgets: DashboardBudgetDto[];
  recentTransactions: DashboardRecentTransactionDto[];
}

export interface DashboardOverviewResponseDto {
  user: DashboardOverviewUserDto;
  current: DashboardPeriodOverviewDto;
  previous: DashboardPeriodOverviewDto;
}
