import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  DashboardBudgetDto,
  DashboardBudgetStatus,
  DashboardCategoryDto,
  DashboardCreditCardDto,
  DashboardOverviewRequestDto,
  DashboardOverviewResponseDto,
  DashboardPeriodDto,
  DashboardPeriodOverviewDto,
  DashboardTotalsDto,
} from './dto/dashboard-overview.dto';
import {
  DashboardBudget,
  DashboardCreditCardSummary,
  DashboardOverviewRepository,
  DashboardTransaction,
} from './dashboard-overview.repository';

interface Month {
  year: number;
  month: number;
}

interface CycleSet {
  current: DashboardPeriodDto;
  previous: DashboardPeriodDto;
  beforePrevious: DashboardPeriodDto;
}

@Injectable()
export class DashboardOverviewService {
  constructor(private readonly repository: DashboardOverviewRepository) {}

  async getOverview(
    request: DashboardOverviewRequestDto,
  ): Promise<DashboardOverviewResponseDto> {
    const userId = this.identifier(request.userId, 'userId');
    const telegramUserId = this.identifier(
      request.telegramUserId,
      'telegramUserId',
    );

    if (!userId && !telegramUserId) {
      throw new BadRequestException('telegramUserId or userId is required');
    }

    const timezone = this.timezone(request.timezone);
    const asOfDate = this.asOfDate(request.asOfDate, timezone);
    const user = await this.repository.findUser(userId, telegramUserId);

    if (!user) {
      throw new NotFoundException('Telegram user not found');
    }

    const cycles = this.cycles(asOfDate, user.cycleStartDay);
    const currentEnd = this.addDays(asOfDate, 1);
    const [transactions, budgets, creditCardSummaries] = await Promise.all([
      this.repository.findTransactions(
        user.id,
        cycles.beforePrevious.start,
        currentEnd,
        timezone,
      ),
      this.repository.findActiveBudgets(user.id),
      this.repository.findCreditCardSummaries(user.id, [
        cycles.current.start,
        cycles.previous.start,
      ]),
    ]);

    return {
      user: { id: user.id, telegramUserId: user.telegramUserId },
      current: this.currentOverview(
        cycles,
        currentEnd,
        transactions,
        budgets,
        creditCardSummaries,
      ),
      previous: this.previousOverview(
        cycles,
        transactions,
        budgets,
        creditCardSummaries,
      ),
    };
  }

  private currentOverview(
    cycles: CycleSet,
    currentEnd: string,
    transactions: DashboardTransaction[],
    budgets: DashboardBudget[],
    creditCardSummaries: DashboardCreditCardSummary[],
  ): DashboardPeriodOverviewDto {
    const elapsedDays = this.daysBetween(cycles.current.start, currentEnd);
    const comparisonEnd = this.earlier(
      this.addDays(cycles.previous.start, elapsedDays),
      cycles.previous.end,
    );

    return this.overview(
      cycles.current,
      this.inPeriod(transactions, cycles.current.start, currentEnd),
      this.inPeriod(transactions, cycles.previous.start, comparisonEnd),
      elapsedDays,
      this.daysBetween(cycles.previous.start, comparisonEnd),
      budgets,
      this.creditCard(creditCardSummaries, cycles.current.start),
    );
  }

  private previousOverview(
    cycles: CycleSet,
    transactions: DashboardTransaction[],
    budgets: DashboardBudget[],
    creditCardSummaries: DashboardCreditCardSummary[],
  ): DashboardPeriodOverviewDto {
    return this.overview(
      cycles.previous,
      this.inPeriod(transactions, cycles.previous.start, cycles.previous.end),
      this.inPeriod(
        transactions,
        cycles.beforePrevious.start,
        cycles.beforePrevious.end,
      ),
      this.daysBetween(cycles.previous.start, cycles.previous.end),
      this.daysBetween(cycles.beforePrevious.start, cycles.beforePrevious.end),
      budgets,
      this.creditCard(creditCardSummaries, cycles.previous.start),
    );
  }

  private overview(
    period: DashboardPeriodDto,
    transactions: DashboardTransaction[],
    comparisonTransactions: DashboardTransaction[],
    days: number,
    comparisonDays: number,
    budgets: DashboardBudget[],
    creditCard: DashboardCreditCardDto,
  ): DashboardPeriodOverviewDto {
    return {
      period,
      hasTransactions: transactions.length > 0,
      totals: this.totals(transactions, days),
      comparison: this.totals(comparisonTransactions, comparisonDays),
      dailySpend: this.dailySpend(transactions),
      categories: this.categories(transactions),
      budgets: this.budgets(budgets, transactions),
      recentTransactions: transactions.slice(0, 5).map((transaction) => ({
        id: transaction.id,
        date: transaction.date,
        merchant: transaction.merchant,
        category: transaction.category,
        amount: transaction.amount,
        type: transaction.type,
      })),
      creditCard,
    };
  }

  private totals(
    transactions: DashboardTransaction[],
    days: number,
  ): DashboardTotalsDto {
    const income = this.sum(transactions, 'income');
    const spent = this.sum(transactions, 'expense');

    return {
      income,
      spent,
      netCashflow: income - spent,
      dailyAverage: spent === 0 ? 0 : Math.round(spent / Math.max(days, 1)),
    };
  }

  private creditCard(
    summaries: DashboardCreditCardSummary[],
    cycleStart: string,
  ): DashboardCreditCardDto {
    const summary = summaries.find((item) => item.cycleStart === cycleStart);

    if (
      !summary ||
      ![summary.limit, summary.used, summary.statementBalance].every(
        (amount) => Number.isSafeInteger(amount) && amount >= 0,
      )
    ) {
      return { limit: 0, used: 0, statementBalance: 0 };
    }

    return {
      limit: summary.limit,
      used: summary.used,
      statementBalance: summary.statementBalance,
    };
  }

  private dailySpend(transactions: DashboardTransaction[]) {
    const totals = new Map<string, number>();

    for (const transaction of transactions) {
      if (transaction.type === 'expense') {
        totals.set(
          transaction.date,
          (totals.get(transaction.date) ?? 0) + transaction.amount,
        );
      }
    }

    return [...totals]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([date, amount]) => ({ date, amount }));
  }

  private categories(
    transactions: DashboardTransaction[],
  ): DashboardCategoryDto[] {
    const expenses = transactions.filter(({ type }) => type === 'expense');
    const totals = new Map<
      string,
      { category: string; amount: number; transactionCount: number }
    >();

    for (const transaction of expenses) {
      const category = transaction.category?.trim() || 'Uncategorized';
      const key = category.toLocaleLowerCase();
      const current = totals.get(key) ?? {
        category,
        amount: 0,
        transactionCount: 0,
      };
      current.amount += transaction.amount;
      current.transactionCount += 1;
      totals.set(key, current);
    }

    const spent = expenses.reduce((sum, item) => sum + item.amount, 0);
    const sorted = [...totals.values()].sort(
      (left, right) =>
        right.amount - left.amount ||
        left.category.localeCompare(right.category),
    );
    const visible = sorted.slice(0, 5);
    const remaining = sorted.slice(5);

    if (remaining.length) {
      visible.push({
        category: 'Others',
        amount: remaining.reduce((sum, item) => sum + item.amount, 0),
        transactionCount: remaining.reduce(
          (sum, item) => sum + item.transactionCount,
          0,
        ),
      });
    }

    return visible.map((item) => ({
      ...item,
      percent: spent === 0 ? 0 : Math.round((item.amount / spent) * 100),
    }));
  }

  private budgets(
    budgets: DashboardBudget[],
    transactions: DashboardTransaction[],
  ): DashboardBudgetDto[] {
    const expenses = transactions.filter(({ type }) => type === 'expense');

    return budgets
      .filter(({ parentId }) => parentId === null)
      .map((budget) => this.budget(budget, budgets, expenses))
      .sort(
        (left, right) =>
          right.spent - left.spent || right.percent - left.percent,
      )
      .slice(0, 4);
  }

  private budget(
    budget: DashboardBudget,
    budgets: DashboardBudget[],
    expenses: DashboardTransaction[],
  ): DashboardBudgetDto {
    const children = budgets.filter(({ parentId }) => parentId === budget.id);
    const scope = children.length ? children : [budget];
    const categories = new Set(
      scope.map(({ category }) => category.toLocaleLowerCase()),
    );
    const limit = scope.reduce((sum, item) => sum + item.amount, 0);
    const spent = expenses
      .filter(
        ({ category }) =>
          category !== null &&
          categories.has(category.trim().toLocaleLowerCase()),
      )
      .reduce((sum, item) => sum + item.amount, 0);
    const percent = limit === 0 ? 0 : Math.round((spent / limit) * 10000) / 100;

    return {
      category: budget.category,
      limit,
      spent,
      percent,
      status: this.budgetStatus(percent),
    };
  }

  private budgetStatus(percent: number): DashboardBudgetStatus {
    if (percent > 100) {
      return 'over';
    }
    return percent >= 80 ? 'warning' : 'on-track';
  }

  private cycles(asOfDate: string, cycleStartDay: number): CycleSet {
    const [year, month] = asOfDate.split('-').map(Number);
    const thisMonth = { year, month };
    const currentMonth =
      asOfDate >= this.monthBoundary(thisMonth, cycleStartDay)
        ? thisMonth
        : this.shiftMonth(thisMonth, -1);
    const previousMonth = this.shiftMonth(currentMonth, -1);
    const beforePreviousMonth = this.shiftMonth(currentMonth, -2);

    return {
      current: this.period('current_cycle', currentMonth, cycleStartDay),
      previous: this.period('previous_cycle', previousMonth, cycleStartDay),
      beforePrevious: this.period(
        'previous_cycle',
        beforePreviousMonth,
        cycleStartDay,
      ),
    };
  }

  private period(
    label: DashboardPeriodDto['label'],
    month: Month,
    cycleStartDay: number,
  ): DashboardPeriodDto {
    return {
      label,
      start: this.monthBoundary(month, cycleStartDay),
      end: this.monthBoundary(this.shiftMonth(month, 1), cycleStartDay),
    };
  }

  private monthBoundary(month: Month, cycleStartDay: number): string {
    const lastDay = new Date(Date.UTC(month.year, month.month, 0)).getUTCDate();
    return this.formatDate(
      new Date(
        Date.UTC(month.year, month.month - 1, Math.min(cycleStartDay, lastDay)),
      ),
    );
  }

  private shiftMonth(month: Month, offset: number): Month {
    const date = new Date(Date.UTC(month.year, month.month - 1 + offset, 1));
    return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1 };
  }

  private inPeriod(
    transactions: DashboardTransaction[],
    start: string,
    end: string,
  ): DashboardTransaction[] {
    return transactions.filter(({ date }) => date >= start && date < end);
  }

  private sum(
    transactions: DashboardTransaction[],
    type: DashboardTransaction['type'],
  ): number {
    return transactions
      .filter((transaction) => transaction.type === type)
      .reduce((sum, transaction) => sum + transaction.amount, 0);
  }

  private identifier(value: unknown, name: string): string | null {
    if (value === null || value === undefined) {
      return null;
    }

    const identifier = String(value).trim();
    if (!/^[1-9]\d*$/.test(identifier)) {
      throw new BadRequestException(`${name} must be a positive integer`);
    }
    return identifier;
  }

  private timezone(value: unknown): string {
    const timezone =
      value === null || value === undefined
        ? 'Asia/Jakarta'
        : String(value).trim();

    if (!timezone) {
      throw new BadRequestException('timezone must be valid');
    }

    try {
      new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format();
      return timezone;
    } catch {
      throw new BadRequestException('timezone must be valid');
    }
  }

  private asOfDate(value: unknown, timezone: string): string {
    if (value === null || value === undefined) {
      return this.localDate(new Date(), timezone);
    }

    const date = String(value).trim();
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
    if (!match) {
      throw new BadRequestException('asOfDate must be YYYY-MM-DD');
    }

    const parsed = new Date(
      Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])),
    );
    if (this.formatDate(parsed) !== date) {
      throw new BadRequestException('asOfDate must be a valid date');
    }
    return date;
  }

  private localDate(date: Date, timezone: string): string {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(date);
    const part = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find((item) => item.type === type)?.value ?? '';

    return `${part('year')}-${part('month')}-${part('day')}`;
  }

  private addDays(date: string, days: number): string {
    const [year, month, day] = date.split('-').map(Number);
    return this.formatDate(new Date(Date.UTC(year, month - 1, day + days)));
  }

  private daysBetween(start: string, end: string): number {
    return Math.max(
      1,
      (Date.parse(`${end}T00:00:00.000Z`) -
        Date.parse(`${start}T00:00:00.000Z`)) /
        86400000,
    );
  }

  private earlier(left: string, right: string): string {
    return left < right ? left : right;
  }

  private formatDate(date: Date): string {
    return date.toISOString().slice(0, 10);
  }
}
