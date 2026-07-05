import { Injectable } from '@nestjs/common';
import {
  BreakdownItem,
  BudgetItem,
  CashflowSummary,
  ConversationalRepository,
  ConversationalUser,
  DailyItem,
  TransactionItem,
} from './conversational.repository';
import {
  ConversationalHandleRequestDto,
  ConversationalHandleResponseDto,
  ConversationalInsightPayloadDto,
  ConversationalIntent,
  ConversationalPeriodDto,
  ConversationalPeriodLabel,
  ConversationalStatus,
} from './dto/conversational-handle.dto';

const SUPPORTED = new Set<ConversationalIntent>([
  'spending_summary',
  'category_spending',
  'merchant_spending',
  'top_merchants',
  'top_categories',
  'largest_transactions',
  'recent_transactions',
  'transaction_count',
  'spending_by_day',
  'daily_average_spending',
  'spending_trend',
  'cashflow_summary',
  'burn_rate_forecast',
]);

const OPTIONAL_INSIGHT = new Set<ConversationalIntent>([
  'spending_summary',
  'top_categories',
  'top_merchants',
  'largest_transactions',
  'spending_by_day',
]);

const ALWAYS_INSIGHT = new Set<ConversationalIntent>([
  'spending_trend',
  'cashflow_summary',
  'daily_average_spending',
]);

const NEVER_INSIGHT = new Set<ConversationalIntent>([
  'category_spending',
  'merchant_spending',
  'recent_transactions',
  'transaction_count',
  'burn_rate_forecast',
]);

const DEFAULT_PERIODS: Partial<
  Record<ConversationalIntent, ConversationalPeriodLabel>
> = {
  spending_summary: 'current_cycle',
  top_categories: 'current_cycle',
  top_merchants: 'current_cycle',
  transaction_count: 'current_cycle',
  cashflow_summary: 'current_cycle',
  recent_transactions: 'current_cycle',
  largest_transactions: 'current_cycle',
  spending_trend: 'current_cycle',
  burn_rate_forecast: 'current_cycle',
};

const INSIGHT_RULES = [
  'Use only these numbers.',
  'Do not invent transactions, merchants, or categories.',
  'Mention at most 3 insights.',
  'Tone: Veyra, strict and minimal.',
  'Return Telegram-safe HTML only.',
];

const PERIODS = new Set<ConversationalPeriodLabel>([
  'today',
  'yesterday',
  'this_week',
  'last_week',
  'this_month',
  'last_month',
  'current_cycle',
  'previous_cycle',
]);

interface PeriodParts {
  year: number;
  month: number;
  day: number;
}

interface IntentResult {
  data: Record<string, unknown>;
  facts: Record<string, unknown>;
  message: string;
  hasData: boolean;
  status?: ConversationalStatus;
  comparisonPeriod?: ConversationalPeriodDto | null;
}

@Injectable()
export class ConversationalService {
  constructor(private readonly repository: ConversationalRepository) {}

  async handle(
    request: ConversationalHandleRequestDto,
  ): Promise<ConversationalHandleResponseDto> {
    const telegramUserId = this.cleanString(request.telegramUserId);
    const requestUserId = this.cleanString(request.userId);
    const intent = this.cleanString(
      request.llmResult?.intent,
    ) as ConversationalIntent | null;

    if (!intent) {
      return this.response(
        false,
        'invalid_intent',
        'unknown',
        'Missing intent.',
        {},
      );
    }

    if (!SUPPORTED.has(intent)) {
      return this.response(
        false,
        'unsupported_intent',
        intent,
        'That analytics request is not supported yet.',
        {},
      );
    }

    const user = await this.repository.findUser(requestUserId, telegramUserId);

    if (!user) {
      return this.response(
        false,
        'user_not_found',
        intent,
        'User not found.',
        {},
      );
    }

    const now = new Date();
    const timezone = this.cleanString(request.timezone) ?? 'Asia/Jakarta';
    const defaultPeriod = DEFAULT_PERIODS[intent] ?? 'current_cycle';
    const periodLabel = this.normalizePeriod(
      request.llmResult?.period,
      defaultPeriod,
    );
    const period = this.resolvePeriod(
      intent === 'burn_rate_forecast' && periodLabel === 'this_month'
        ? 'current_cycle'
        : periodLabel,
      user.cycleStartDay,
      timezone,
      now,
    );

    const limit = clampLimit(request.llmResult?.limit);
    const result = await this.runIntent(
      intent,
      request,
      user,
      period,
      limit,
      timezone,
      now,
    );

    if (result.status) {
      return this.response(
        result.status === 'ok',
        result.status,
        intent,
        result.message,
        result.data,
      );
    }

    if (!result.hasData) {
      return this.response(
        true,
        'empty_result',
        intent,
        'No confirmed transactions found for this period.',
        result.data,
      );
    }

    const wantsInsight = request.llmResult?.needs_insight === true;
    const status = this.needsInsight(intent, wantsInsight)
      ? 'needs_insight'
      : 'ok';
    const insightPayload =
      status === 'needs_insight'
        ? this.buildInsightPayload(
            intent,
            request.text,
            period,
            result.comparisonPeriod ?? null,
            result.facts,
          )
        : null;

    return this.response(
      true,
      status,
      intent,
      result.message,
      result.data,
      insightPayload,
    );
  }

  resolvePeriod(
    label: ConversationalPeriodLabel,
    cycleStartDay: number,
    timezone = 'Asia/Jakarta',
    now = new Date(),
  ): ConversationalPeriodDto {
    const today = this.localParts(now, timezone);

    if (label === 'today') {
      return this.period(label, today, this.addDays(today, 1));
    }
    if (label === 'yesterday') {
      const start = this.addDays(today, -1);
      return this.period(label, start, today);
    }
    if (label === 'this_week' || label === 'last_week') {
      const monday = this.addDays(today, -this.weekdayIndex(today));
      const start = label === 'this_week' ? monday : this.addDays(monday, -7);
      return this.period(label, start, this.addDays(start, 7));
    }
    if (label === 'this_month' || label === 'last_month') {
      const start =
        label === 'this_month'
          ? { ...today, day: 1 }
          : this.addMonths({ ...today, day: 1 }, -1);
      return this.period(label, start, this.addMonths(start, 1));
    }

    const currentStart =
      today.day >= cycleStartDay
        ? this.safeDate(today.year, today.month, cycleStartDay)
        : this.addMonths(
            this.safeDate(today.year, today.month, cycleStartDay),
            -1,
          );
    const start =
      label === 'current_cycle'
        ? currentStart
        : this.addMonths(currentStart, -1);
    return this.period(label, start, this.addMonths(start, 1));
  }

  formatRupiah(amount: number): string {
    return `Rp${Math.round(amount).toLocaleString('id-ID')}`;
  }

  private async runIntent(
    intent: ConversationalIntent,
    request: ConversationalHandleRequestDto,
    user: ConversationalUser,
    period: ConversationalPeriodDto,
    limit: number,
    timezone: string,
    now: Date,
  ): Promise<IntentResult> {
    if (intent === 'category_spending') {
      const category = this.cleanString(request.llmResult?.category);
      if (!category) {
        return {
          data: {},
          facts: {},
          hasData: false,
          message: 'Category is required.',
          status: 'missing_field',
        };
      }
      const total = await this.repository.categoryTotal(
        user.id,
        category,
        period.start,
        period.end,
      );
      return {
        data: { period, category, ...total },
        facts: { category, ...total },
        hasData: total.count > 0,
        message: `${this.escape(category)}: <b>${this.formatRupiah(total.total)}</b> from ${total.count} transactions.`,
      };
    }

    if (intent === 'merchant_spending') {
      const merchant = this.cleanString(request.llmResult?.merchant);
      if (!merchant) {
        return {
          data: {},
          facts: {},
          hasData: false,
          message: 'Merchant is required.',
          status: 'missing_field',
        };
      }
      const total = await this.repository.merchantTotal(
        user.id,
        merchant,
        period.start,
        period.end,
      );
      return {
        data: { period, merchant, ...total },
        facts: { merchant, ...total },
        hasData: total.count > 0,
        message: `${this.escape(merchant)}: <b>${this.formatRupiah(total.total)}</b> from ${total.count} transactions.`,
      };
    }

    if (intent === 'top_categories') {
      return this.breakdownResult(
        intent,
        period,
        await this.repository.topCategories(
          user.id,
          period.start,
          period.end,
          limit,
        ),
        limit,
      );
    }
    if (intent === 'top_merchants') {
      return this.breakdownResult(
        intent,
        period,
        await this.repository.topMerchants(
          user.id,
          period.start,
          period.end,
          limit,
        ),
        limit,
      );
    }
    if (intent === 'largest_transactions') {
      return this.transactionListResult(
        intent,
        period,
        await this.repository.largestTransactions(
          user.id,
          period.start,
          period.end,
          limit,
        ),
        limit,
      );
    }
    if (intent === 'recent_transactions') {
      return this.transactionListResult(
        intent,
        period,
        await this.repository.recentTransactions(
          user.id,
          period.start,
          period.end,
          limit,
        ),
        limit,
      );
    }
    if (intent === 'transaction_count') {
      const total = await this.repository.expenseTotal(
        user.id,
        period.start,
        period.end,
      );
      return {
        data: { period, ...total },
        facts: { total: total.total, count: total.count },
        hasData: total.count > 0,
        message: `${total.count} expense transactions, total <b>${this.formatRupiah(total.total)}</b>.`,
      };
    }
    if (intent === 'spending_by_day') {
      const days = await this.repository.spendingByDay(
        user.id,
        period.start,
        period.end,
      );
      return this.dailyResult(period, days);
    }
    if (intent === 'daily_average_spending') {
      const total = await this.repository.expenseTotal(
        user.id,
        period.start,
        period.end,
      );
      const daysElapsed = this.daysElapsed(period, timezone, now);
      const average = total.total / daysElapsed;
      return {
        data: {
          period,
          total: total.total,
          count: total.count,
          days_elapsed: daysElapsed,
          average_per_day: average,
        },
        facts: {
          total: total.total,
          count: total.count,
          days_elapsed: daysElapsed,
          average_per_day: average,
        },
        hasData: total.count > 0,
        message: `Daily average: <b>${this.formatRupiah(average)}</b> from ${this.formatRupiah(total.total)} over ${daysElapsed} days.`,
      };
    }
    if (intent === 'spending_trend') {
      return this.spendingTrend(request, user, period, timezone, now);
    }
    if (intent === 'cashflow_summary') {
      const cashflow = await this.repository.cashflowSummary(
        user.id,
        period.start,
        period.end,
      );
      return this.cashflowResult(period, cashflow);
    }
    if (intent === 'burn_rate_forecast') {
      return this.burnRateForecast(
        user,
        period,
        timezone,
        now,
        this.cleanString(request.llmResult?.category),
      );
    }

    const summary = await this.repository.expenseTotal(
      user.id,
      period.start,
      period.end,
    );
    const topCategories = await this.repository.topCategories(
      user.id,
      period.start,
      period.end,
      3,
    );
    const topMerchants = await this.repository.topMerchants(
      user.id,
      period.start,
      period.end,
      3,
    );

    return {
      data: {
        period,
        total: summary.total,
        count: summary.count,
        top_categories: topCategories,
        top_merchants: topMerchants,
      },
      facts: {
        total: summary.total,
        count: summary.count,
        top_categories: topCategories,
        top_merchants: topMerchants,
      },
      hasData: summary.count > 0,
      message: `Spending: <b>${this.formatRupiah(summary.total)}</b> from ${summary.count} transactions.`,
    };
  }

  private async spendingTrend(
    request: ConversationalHandleRequestDto,
    user: ConversationalUser,
    period: ConversationalPeriodDto,
    timezone: string,
    now: Date,
  ): Promise<IntentResult> {
    const comparisonLabel =
      this.normalizePeriod(
        request.llmResult?.comparisonPeriod,
        'previous_cycle',
      );
    const comparisonPeriod = this.resolvePeriod(
      comparisonLabel,
      user.cycleStartDay,
      timezone,
      now,
    );
    const current = await this.repository.expenseTotal(
      user.id,
      period.start,
      period.end,
    );
    const previous = await this.repository.expenseTotal(
      user.id,
      comparisonPeriod.start,
      comparisonPeriod.end,
    );
    const changeAmount = current.total - previous.total;
    const changePercent =
      previous.total === 0
        ? null
        : Math.round((changeAmount / previous.total) * 1000) / 10;
    const direction =
      changeAmount > 0 ? 'up' : changeAmount < 0 ? 'down' : 'stable';
    const topCategories = this.withShare(
      await this.repository.topCategories(user.id, period.start, period.end, 3),
      current.total,
    );
    const topMerchants = this.withShare(
      await this.repository.topMerchants(user.id, period.start, period.end, 3),
      current.total,
    );
    const facts = {
      current_total: current.total,
      previous_total: previous.total,
      change_amount: changeAmount,
      change_percent: changePercent,
      direction,
      top_categories: topCategories.map((item) => ({
        category: item.name,
        amount: item.amount,
        share_percent: item.share_percent,
      })),
      top_merchants: topMerchants.map((item) => ({
        merchant: item.name,
        amount: item.amount,
        share_percent: item.share_percent,
      })),
    };

    return {
      data: { period, comparison_period: comparisonPeriod, ...facts },
      facts,
      hasData: current.count > 0 || previous.count > 0,
      message: `Current spending is <b>${this.formatRupiah(current.total)}</b>, ${direction} ${this.formatRupiah(Math.abs(changeAmount))} vs comparison.`,
      comparisonPeriod,
    };
  }

  private cashflowResult(
    period: ConversationalPeriodDto,
    cashflow: CashflowSummary,
  ): IntentResult {
    return {
      data: { period, ...cashflow },
      facts: { ...cashflow },
      hasData: cashflow.incomeCount > 0 || cashflow.expenseCount > 0,
      message: `Income ${this.formatRupiah(cashflow.incomeTotal)}, spending ${this.formatRupiah(cashflow.expenseTotal)}, net <b>${this.formatRupiah(cashflow.net)}</b>.`,
    };
  }

  private async burnRateForecast(
    user: ConversationalUser,
    period: ConversationalPeriodDto,
    timezone: string,
    now: Date,
    category: string | null,
  ): Promise<IntentResult> {
    const total = category
      ? await this.repository.categoryTotal(
          user.id,
          category,
          period.start,
          period.end,
        )
      : await this.repository.expenseTotal(user.id, period.start, period.end);
    const budget =
      (await this.repository.activeBudgets(user.id, category))[0] ?? null;
    const forecast = this.buildBurnRateForecast(
      period,
      timezone,
      now,
      category,
      total.total,
      budget,
    );
    const perBudgetForecasts = category
      ? []
      : await Promise.all(
          (await this.repository.activeBudgets(user.id)).map(async (item) => {
            const budgetTotal = await this.repository.categoryTotal(
              user.id,
              item.category,
              period.start,
              period.end,
            );
            return this.buildBurnRateForecast(
              period,
              timezone,
              now,
              item.category,
              budgetTotal.total,
              item,
            );
          }),
        );

    return {
      data: {
        ...forecast,
        ...(perBudgetForecasts.length ? { perBudgetForecasts } : {}),
      },
      facts: forecast,
      hasData: true,
      message: this.burnRateMessage(forecast),
      status: 'ok',
    };
  }

  private buildBurnRateForecast(
    period: ConversationalPeriodDto,
    timezone: string,
    now: Date,
    category: string | null,
    spentSoFar: number,
    budget: BudgetItem | null,
  ) {
    const today = this.formatParts(this.localParts(now, timezone));
    const elapsedDays = this.daysElapsed(period, timezone, now);
    const totalCycleDays =
      this.toDateNumber(this.parseDate(period.end)) -
      this.toDateNumber(this.parseDate(period.start));
    const daysLeft = Math.max(totalCycleDays - elapsedDays, 0);
    const averageDailySpend = spentSoFar / elapsedDays;
    const projectedCycleSpend = averageDailySpend * totalCycleDays;
    const budgetLimit = budget?.amount ?? null;
    const remainingBudget =
      budgetLimit === null ? null : budgetLimit - spentSoFar;
    const safeDailySpend =
      remainingBudget === null ? null : remainingBudget / Math.max(daysLeft, 1);
    const projectedOverrun =
      budgetLimit === null
        ? null
        : Math.max(projectedCycleSpend - budgetLimit, 0);
    const projectedRemaining =
      budgetLimit === null
        ? null
        : Math.max(budgetLimit - projectedCycleSpend, 0);
    const exhaustionDate =
      budgetLimit === null || spentSoFar <= 0 || averageDailySpend <= 0
        ? null
        : this.formatParts(
            this.addDays(
              this.parseDate(period.start),
              Math.ceil(budgetLimit / averageDailySpend),
            ),
          );

    return {
      cycleStart: period.start,
      cycleEnd: period.end,
      today,
      elapsedDays,
      daysLeft,
      totalCycleDays,
      category,
      spentSoFar,
      averageDailySpend,
      projectedCycleSpend,
      budgetLimit,
      remainingBudget,
      safeDailySpend,
      projectedOverrun,
      projectedRemaining,
      exhaustionDate,
      status: this.burnRateStatus(
        spentSoFar,
        budgetLimit,
        projectedCycleSpend,
        safeDailySpend,
        averageDailySpend,
      ),
    };
  }

  private burnRateStatus(
    spentSoFar: number,
    budgetLimit: number | null,
    projectedCycleSpend: number,
    safeDailySpend: number | null,
    averageDailySpend: number,
  ): string {
    if (spentSoFar <= 0) return 'no_data';
    if (budgetLimit !== null && spentSoFar >= budgetLimit) {
      return 'already_over_budget';
    }
    if (budgetLimit !== null && projectedCycleSpend > budgetLimit) {
      return 'projected_overrun';
    }
    if (safeDailySpend !== null && safeDailySpend < averageDailySpend) {
      return 'warning';
    }
    return 'safe';
  }

  private burnRateMessage(
    forecast: ReturnType<ConversationalService['buildBurnRateForecast']>,
  ): string {
    const title = forecast.category
      ? `${this.escape(forecast.category)} burn-rate forecast`
      : 'Burn-rate forecast';
    const spent = this.formatRupiah(forecast.spentSoFar);
    const burnRate = this.formatRupiah(forecast.averageDailySpend);
    const projected = this.formatRupiah(forecast.projectedCycleSpend);

    if (forecast.status === 'no_data') {
      return `<b>${title}</b>\n• No confirmed spending found in this cycle.\n• Burn rate cannot be judged yet. Convenient, but not impressive.`;
    }
    if (forecast.budgetLimit === null) {
      return `<b>${title}</b>\n• You spent ${spent} in ${forecast.elapsedDays} days.\n• Current burn rate: ${burnRate}/day.\n• Projected cycle spend: ${projected}. No budget limit found, so I cannot judge the damage properly.`;
    }
    if (forecast.status === 'already_over_budget') {
      return `<b>${title}</b>\n• Spent: ${spent} of ${this.formatRupiah(forecast.budgetLimit)}.\n• You are already over budget by ${this.formatRupiah(Math.abs(forecast.remainingBudget ?? 0))}.\n• Burn rate: ${burnRate}/day. Damage control now, not later.`;
    }
    if (forecast.status === 'projected_overrun') {
      return `<b>${title}</b>\n• Spent: ${spent} of ${this.formatRupiah(forecast.budgetLimit)}.\n• Burn rate: ${burnRate}/day. Safe daily spend left: ${this.formatRupiah(forecast.safeDailySpend ?? 0)}/day.\n• Projected spend: ${projected}. You are on track to exceed by ${this.formatRupiah(forecast.projectedOverrun ?? 0)}. Slow down.`;
    }

    return `<b>${title}</b>\n• Spent: ${spent} of ${this.formatRupiah(forecast.budgetLimit)}.\n• Burn rate: ${burnRate}/day. Safe daily spend left: ${this.formatRupiah(forecast.safeDailySpend ?? 0)}/day.\n• Projected spend: ${projected}. Still under budget. Barely acceptable.`;
  }

  private breakdownResult(
    intent: ConversationalIntent,
    period: ConversationalPeriodDto,
    items: BreakdownItem[],
    limit: number,
  ): IntentResult {
    const key = intent === 'top_categories' ? 'categories' : 'merchants';
    const lines = items
      .slice(0, 5)
      .map(
        (item, index) =>
          `${index + 1}. ${this.escape(item.name)}: ${this.formatRupiah(item.amount)}`,
      );

    return {
      data: { period, limit, [key]: items },
      facts: { [key]: items },
      hasData: items.length > 0,
      message: lines.length ? lines.join('\n') : 'No confirmed spending found.',
    };
  }

  private transactionListResult(
    intent: ConversationalIntent,
    period: ConversationalPeriodDto,
    items: TransactionItem[],
    limit: number,
  ): IntentResult {
    const lines = items.map((item) => {
      const merchant = this.escape(item.merchant ?? 'Unknown merchant');
      return `${item.transactionDate} ${merchant}: ${this.formatRupiah(item.amount)}`;
    });

    return {
      data: { period, limit, transactions: items },
      facts: { transactions: items },
      hasData: items.length > 0,
      message: lines.length ? lines.join('\n') : `No ${intent} found.`,
    };
  }

  private dailyResult(
    period: ConversationalPeriodDto,
    days: DailyItem[],
  ): IntentResult {
    const lines = days
      .slice(0, 10)
      .map((day) => `${day.date}: ${this.formatRupiah(day.amount)}`);

    return {
      data: { period, days },
      facts: { days },
      hasData: days.length > 0,
      message: lines.join('\n'),
    };
  }

  private needsInsight(
    intent: ConversationalIntent,
    requested: boolean,
  ): boolean {
    if (NEVER_INSIGHT.has(intent)) {
      return false;
    }
    if (ALWAYS_INSIGHT.has(intent)) {
      return true;
    }
    return OPTIONAL_INSIGHT.has(intent) && requested;
  }

  private buildInsightPayload(
    intent: string,
    userText: string | null | undefined,
    period: ConversationalPeriodDto,
    comparisonPeriod: ConversationalPeriodDto | null,
    facts: Record<string, unknown>,
  ): ConversationalInsightPayloadDto {
    return {
      intent,
      user_text: this.cleanString(userText) ?? '',
      period,
      comparison_period: comparisonPeriod,
      facts,
      rules: INSIGHT_RULES,
    };
  }

  private response(
    ok: boolean,
    status: ConversationalStatus,
    intent: string,
    text: string,
    data: Record<string, unknown>,
    insightPayload: ConversationalInsightPayloadDto | null = null,
  ): ConversationalHandleResponseDto {
    return {
      ok,
      status,
      intent,
      message: {
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: null,
      },
      data,
      insight_payload: insightPayload,
    };
  }

  private daysElapsed(
    period: ConversationalPeriodDto,
    timezone: string,
    now: Date,
  ): number {
    const today = this.toDateNumber(this.localParts(now, timezone));
    const start = this.toDateNumber(this.parseDate(period.start));
    const end = this.toDateNumber(this.parseDate(period.end));
    const elapsedEnd = today >= start && today < end ? today + 1 : end;

    return Math.max(1, elapsedEnd - start);
  }

  private withShare(items: BreakdownItem[], total: number) {
    return items.map((item) => ({
      ...item,
      share_percent:
        total === 0 ? 0 : Math.round((item.amount / total) * 1000) / 10,
    }));
  }

  private localParts(date: Date, timezone: string): PeriodParts {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(date);

    return {
      year: Number(parts.find((part) => part.type === 'year')?.value),
      month: Number(parts.find((part) => part.type === 'month')?.value),
      day: Number(parts.find((part) => part.type === 'day')?.value),
    };
  }

  private period(
    label: ConversationalPeriodLabel,
    start: PeriodParts,
    end: PeriodParts,
  ): ConversationalPeriodDto {
    return {
      label,
      start: this.formatParts(start),
      end: this.formatParts(end),
    };
  }

  private parseDate(value: string): PeriodParts {
    const [year, month, day] = value.split('-').map(Number);
    return { year, month, day };
  }

  private addDays(parts: PeriodParts, days: number): PeriodParts {
    const date = new Date(
      Date.UTC(parts.year, parts.month - 1, parts.day + days),
    );
    return {
      year: date.getUTCFullYear(),
      month: date.getUTCMonth() + 1,
      day: date.getUTCDate(),
    };
  }

  private addMonths(parts: PeriodParts, months: number): PeriodParts {
    return this.safeDate(parts.year, parts.month + months, parts.day);
  }

  private safeDate(year: number, month: number, day: number): PeriodParts {
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const date = new Date(Date.UTC(year, month - 1, Math.min(day, lastDay)));
    return {
      year: date.getUTCFullYear(),
      month: date.getUTCMonth() + 1,
      day: date.getUTCDate(),
    };
  }

  private weekdayIndex(parts: PeriodParts): number {
    const day = new Date(
      Date.UTC(parts.year, parts.month - 1, parts.day),
    ).getUTCDay();
    return day === 0 ? 6 : day - 1;
  }

  private toDateNumber(parts: PeriodParts): number {
    return Math.floor(
      Date.UTC(parts.year, parts.month - 1, parts.day) / 86400000,
    );
  }

  private formatParts(parts: PeriodParts): string {
    return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
  }

  private cleanString(value: unknown): string | null {
    if (value === null || value === undefined) {
      return null;
    }
    const cleaned = String(value).trim();
    return cleaned.length > 0 ? cleaned : null;
  }

  private normalizePeriod(
    value: unknown,
    fallback: ConversationalPeriodLabel,
  ): ConversationalPeriodLabel {
    const period = this.cleanString(value) as ConversationalPeriodLabel | null;
    return period && PERIODS.has(period) ? period : fallback;
  }

  private escape(value: string): string {
    return value
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;');
  }
}

export function clampLimit(value: unknown): number {
  const numberValue = Number(value ?? 5);
  if (!Number.isFinite(numberValue)) {
    return 5;
  }
  return Math.min(Math.max(Math.trunc(numberValue), 1), 10);
}
