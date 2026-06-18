import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { QueryResultRow } from 'pg';
import { DatabaseService } from '../../database/database.service';
import {
  BudgetPeriodType,
  BudgetUpsertRequestDto,
  BudgetUpsertResponseDto,
} from './dto/budget-upsert.dto';
import {
  BudgetCycle,
  BudgetStatusChildBreakdownDto,
  BudgetStatusRequestDto,
  BudgetStatusResponseDto,
} from './dto/budget-status.dto';
import {
  OverspendingAlertType,
  OverspendingCheckRequestDto,
  OverspendingCheckResponseDto,
} from './dto/overspending-check.dto';

interface BudgetStatusRow extends QueryResultRow {
  budget_id: string | number;
  category: string;
  parent_budget_id: string | number | null;
  budget_amount: string | number;
  spent_amount: string | number | null;
  child_breakdown?: unknown;
}

interface CycleStartRow extends QueryResultRow {
  cycle_start_day: number | string;
}

interface ParentBudgetRow extends QueryResultRow {
  id: string | number;
  category: string;
  inserted?: boolean;
}

interface BudgetUpsertRow extends QueryResultRow {
  budget_id: string | number;
  user_id: string | number;
  category: string;
  amount: string | number;
  parent_budget_id: string | number | null;
  parent_category: string | null;
  period_type: BudgetPeriodType;
  inserted: boolean;
}

interface AlertExistsRow extends QueryResultRow {
  exists: boolean;
}

@Injectable()
export class BudgetService {
  constructor(private readonly database: DatabaseService) {}

  placeholderStatus() {
    return {
      implemented: false,
      nextStep: 'Move budget intent parsing and validation here before database writes.',
    };
  }

  async getBudgetStatus(
    request: BudgetStatusRequestDto,
  ): Promise<BudgetStatusResponseDto> {
    const userId = this.cleanString(request.userId ?? request.telegramUserId);
    const category = this.cleanString(request.category);

    if (!userId) {
      throw new BadRequestException('userId or telegramUserId is required');
    }

    if (!category) {
      throw new BadRequestException('category is required');
    }

    const cycleStartDay = await this.getCycleStartDay(userId);
    const cycle = this.calculateCurrentCycle(
      this.parseReferenceDate(request.asOfDate),
      cycleStartDay,
    );

    const result = await this.database.query<BudgetStatusRow>(
      `
        WITH matched_user AS (
          SELECT id
          FROM telegram_users
          WHERE id::text = $1 OR telegram_id::text = $1
          LIMIT 1
        ),
        selected_budget AS (
          SELECT b.id, b.category, b.parent_budget_id, b.amount AS budget_amount
          FROM budgets b
          JOIN matched_user u ON u.id = b.user_id
          WHERE lower(b.category) = lower($2)
            AND COALESCE(b.is_active, true) = true
          LIMIT 1
        ),
        budget_scope AS (
          SELECT id, category
          FROM selected_budget
          UNION
          SELECT child.id, child.category
          FROM budgets child
          JOIN selected_budget parent ON child.parent_budget_id = parent.id
          WHERE COALESCE(child.is_active, true) = true
        ),
        spending AS (
          SELECT COALESCE(SUM(t.amount), 0) AS spent_amount
          FROM transactions t
          JOIN matched_user u ON u.id = t.user_id
          WHERE t.status = 'confirmed'
            AND t.transaction_type = 'expense'
            AND t.transaction_date >= $3::date
            AND t.transaction_date < $4::date
            AND lower(t.category) IN (
              SELECT lower(category)
              FROM budget_scope
            )
        ),
        child_spending AS (
          SELECT
            child.id AS budget_id,
            child.category,
            child.amount AS budget_amount,
            COALESCE(SUM(t.amount), 0) AS spent_amount
          FROM budgets child
          JOIN selected_budget parent ON child.parent_budget_id = parent.id
          LEFT JOIN matched_user u ON true
          LEFT JOIN transactions t ON t.user_id = u.id
            AND t.status = 'confirmed'
            AND t.transaction_type = 'expense'
            AND t.transaction_date >= $3::date
            AND t.transaction_date < $4::date
            AND lower(t.category) = lower(child.category)
          WHERE COALESCE(child.is_active, true) = true
          GROUP BY child.id, child.category, child.amount
        ),
        child_breakdown AS (
          SELECT COALESCE(
            json_agg(
              json_build_object(
                'budget_id', budget_id::text,
                'category', category,
                'budget_amount', budget_amount,
                'spent_amount', spent_amount
              )
              ORDER BY category
            ),
            '[]'::json
          ) AS child_breakdown
          FROM child_spending
        )
        SELECT
          sb.id AS budget_id,
          sb.category,
          sb.parent_budget_id,
          sb.budget_amount,
          spending.spent_amount,
          child_breakdown.child_breakdown
        FROM selected_budget sb
        CROSS JOIN spending
        CROSS JOIN child_breakdown
      `,
      [userId, category, cycle.cycle_start, cycle.cycle_end],
    );

    const row = result.rows[0];

    if (!row) {
      throw new NotFoundException('Budget not found for user and category');
    }

    return this.mapBudgetStatusRow(row, cycle);
  }

  async upsertBudget(
    request: BudgetUpsertRequestDto,
  ): Promise<BudgetUpsertResponseDto> {
    const userId = this.cleanString(request.userId);
    const category = this.cleanString(request.category);
    const amount = this.toNumber(request.amount);
    const parentCategory = this.cleanString(request.parentCategory);
    const periodType = request.periodType ?? 'monthly';

    if (!userId) {
      throw new BadRequestException('userId is required');
    }

    if (!category) {
      throw new BadRequestException('category is required');
    }

    if (amount <= 0) {
      throw new BadRequestException('amount must be positive');
    }

    if (periodType !== 'monthly') {
      throw new BadRequestException('periodType must be monthly');
    }

    const parentBudget = parentCategory
      ? await this.findOrCreateParentBudget(userId, parentCategory, periodType)
      : null;
    const parentBudgetId = parentBudget ? String(parentBudget.id) : null;

    const result = await this.database.query<BudgetUpsertRow>(
      `
        INSERT INTO budgets (
          user_id,
          category,
          amount,
          parent_budget_id,
          period_type,
          is_active
        )
        VALUES ($1, $2, $3, $4, $5, true)
        ON CONFLICT (user_id, category)
        DO UPDATE SET
          amount = EXCLUDED.amount,
          period_type = EXCLUDED.period_type,
          parent_budget_id = CASE
            WHEN $6::boolean THEN EXCLUDED.parent_budget_id
            ELSE budgets.parent_budget_id
          END,
          updated_at = now()
        RETURNING
          budgets.id AS budget_id,
          budgets.user_id,
          budgets.category,
          budgets.amount AS amount,
          budgets.parent_budget_id,
          (
            SELECT parent.category
            FROM budgets parent
            WHERE parent.id = budgets.parent_budget_id
          ) AS parent_category,
          budgets.period_type,
          (xmax = 0) AS inserted
      `,
      [
        userId,
        category,
        amount,
        parentBudgetId,
        periodType,
        Boolean(parentCategory),
      ],
    );

    const row = result.rows[0];

    if (!row) {
      throw new Error('Budget upsert did not return a row');
    }

    return this.mapBudgetUpsertRow(row);
  }

  async checkOverspending(
    request: OverspendingCheckRequestDto,
  ): Promise<OverspendingCheckResponseDto> {
    const userId = this.cleanString(request.userId);
    const category = this.cleanString(request.category);

    if (!userId) {
      throw new BadRequestException('userId is required');
    }

    if (!category) {
      throw new BadRequestException('category is required');
    }

    const status = await this.getDirectBudgetStatus(userId, category);
    const alertType = this.resolveOverspendingAlertType(status.spent_percent);
    const periodKey = this.periodKeyFromCycleStart(status.cycle_start);
    const alreadyAlerted = alertType
      ? await this.hasBudgetAlert({
          userId,
          budgetId: status.budget_id,
          alertType,
          periodKey,
        })
      : false;

    return {
      shouldAlert: Boolean(alertType) && !alreadyAlerted,
      alreadyAlerted,
      alertType,
      telegramHtml:
        alertType && !alreadyAlerted
          ? this.buildOverspendingTelegramHtml({
              alertType,
              category: status.category,
              spentPercent: status.spent_percent,
              spentAmount: status.spent_amount,
              budgetAmount: status.budget_amount,
              remainingAmount: status.remaining_amount,
            })
          : null,
      alertRecord: alertType
        ? {
            budgetId: status.budget_id,
            alertType,
            periodKey,
          }
        : null,
      budgetId: status.budget_id,
      userId,
      category: status.category,
      spentPercent: status.spent_percent,
      spentAmount: status.spent_amount,
      budgetAmount: status.budget_amount,
      remainingAmount: status.remaining_amount,
      cycleStart: status.cycle_start,
      cycleEnd: status.cycle_end,
      periodKey,
    };
  }

  calculateCurrentCycle(
    referenceDate: Date,
    cycleStartDay: number | string | null | undefined,
  ): BudgetCycle {
    const normalizedCycleStartDay = this.normalizeCycleStartDay(cycleStartDay);
    const referenceYear = referenceDate.getUTCFullYear();
    const referenceMonth = referenceDate.getUTCMonth();
    const cycleStartThisMonth = this.utcCycleDate(
      referenceYear,
      referenceMonth,
      normalizedCycleStartDay,
    );
    const cycleStart =
      referenceDate.getTime() >= cycleStartThisMonth.getTime()
        ? cycleStartThisMonth
        : this.utcCycleDate(
            referenceYear,
            referenceMonth - 1,
            normalizedCycleStartDay,
          );
    const cycleEnd = this.utcCycleDate(
      cycleStart.getUTCFullYear(),
      cycleStart.getUTCMonth() + 1,
      normalizedCycleStartDay,
    );

    return {
      cycle_start: this.toDateString(cycleStart),
      cycle_end: this.toDateString(cycleEnd),
    };
  }

  mapBudgetStatusRow(
    row: BudgetStatusRow,
    cycle: BudgetCycle,
  ): BudgetStatusResponseDto {
    const budgetAmount = this.toNumber(row.budget_amount);
    const spentAmount = this.toNumber(row.spent_amount);
    const spentPercent = this.calculateSpentPercent(spentAmount, budgetAmount);

    return {
      budget_id: String(row.budget_id),
      category: row.category,
      parent_budget_id:
        row.parent_budget_id === null || row.parent_budget_id === undefined
          ? null
          : String(row.parent_budget_id),
      budget_amount: budgetAmount,
      spent_amount: spentAmount,
      remaining_amount: budgetAmount - spentAmount,
      spent_percent: spentPercent,
      child_breakdown: this.mapChildBreakdown(row.child_breakdown),
      cycle_start: cycle.cycle_start,
      cycle_end: cycle.cycle_end,
    };
  }

  mapBudgetUpsertRow(row: BudgetUpsertRow): BudgetUpsertResponseDto {
    return {
      budget_id: String(row.budget_id),
      user_id: String(row.user_id),
      category: row.category,
      amount: this.toNumber(row.amount),
      parent_budget_id:
        row.parent_budget_id === null || row.parent_budget_id === undefined
          ? null
          : String(row.parent_budget_id),
      parent_category: row.parent_category ?? null,
      period_type: row.period_type,
      action: row.inserted ? 'created' : 'updated',
    };
  }

  resolveOverspendingAlertType(
    spentPercent: number,
  ): OverspendingAlertType | null {
    if (spentPercent >= 120) {
      return 'overspend_120';
    }

    if (spentPercent >= 100) {
      return 'overspend_100';
    }

    if (spentPercent >= 80) {
      return 'overspend_80';
    }

    return null;
  }

  periodKeyFromCycleStart(cycleStart: string): string {
    return cycleStart;
  }

  private async getDirectBudgetStatus(
    userId: string,
    category: string,
  ): Promise<BudgetStatusResponseDto> {
    const cycleStartDay = await this.getCycleStartDay(userId);
    const cycle = this.calculateCurrentCycle(new Date(), cycleStartDay);
    const result = await this.database.query<BudgetStatusRow>(
      `
        WITH matched_user AS (
          SELECT id
          FROM telegram_users
          WHERE id::text = $1 OR telegram_id::text = $1
          LIMIT 1
        ),
        selected_budget AS (
          SELECT b.id, b.category, b.parent_budget_id, b.amount AS budget_amount
          FROM budgets b
          JOIN matched_user u ON u.id = b.user_id
          WHERE lower(b.category) = lower($2)
            AND COALESCE(b.is_active, true) = true
          LIMIT 1
        ),
        spending AS (
          SELECT COALESCE(SUM(t.amount), 0) AS spent_amount
          FROM transactions t
          JOIN matched_user u ON u.id = t.user_id
          JOIN selected_budget b ON lower(t.category) = lower(b.category)
          WHERE t.status = 'confirmed'
            AND t.transaction_type = 'expense'
            AND t.transaction_date >= $3::date
            AND t.transaction_date < $4::date
        )
        SELECT
          sb.id AS budget_id,
          sb.category,
          sb.parent_budget_id,
          sb.budget_amount,
          spending.spent_amount,
          '[]'::json AS child_breakdown
        FROM selected_budget sb
        CROSS JOIN spending
      `,
      [userId, category, cycle.cycle_start, cycle.cycle_end],
    );
    const row = result.rows[0];

    if (!row) {
      throw new NotFoundException('Budget not found for user and category');
    }

    return this.mapBudgetStatusRow(row, cycle);
  }

  private buildOverspendingTelegramHtml(input: {
    alertType: OverspendingAlertType;
    category: string;
    spentPercent: number;
    spentAmount: number;
    budgetAmount: number;
    remainingAmount: number;
  }): string {
    const severity = {
      overspend_80: 'Budget warning',
      overspend_100: 'Budget reached',
      overspend_120: 'Budget exceeded',
    }[input.alertType];

    return [
      `<b>${severity}</b>`,
      '',
      `Category: <b>${this.escapeTelegramHtml(input.category)}</b>`,
      `Spent: ${this.formatCurrency(input.spentAmount)} (${input.spentPercent}%)`,
      `Budget: ${this.formatCurrency(input.budgetAmount)}`,
      `Remaining: ${this.formatCurrency(input.remainingAmount)}`,
    ].join('\n');
  }

  private async hasBudgetAlert(input: {
    userId: string;
    budgetId: string;
    alertType: OverspendingAlertType;
    periodKey: string;
  }): Promise<boolean> {
    const result = await this.database.query<AlertExistsRow>(
      `
        SELECT EXISTS (
          SELECT 1
          FROM budget_alerts
          WHERE user_id::text = $1
            AND budget_id::text = $2
            AND alert_type = $3
            AND period_key = $4
        ) AS exists
      `,
      [input.userId, input.budgetId, input.alertType, input.periodKey],
    );

    return Boolean(result.rows[0]?.exists);
  }

  private formatCurrency(amount: number): string {
    return new Intl.NumberFormat('id-ID', {
      maximumFractionDigits: 0,
      style: 'currency',
      currency: 'IDR',
    }).format(amount);
  }

  private escapeTelegramHtml(value: string): string {
    return value
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;');
  }

  private async findOrCreateParentBudget(
    userId: string,
    parentCategory: string,
    periodType: BudgetPeriodType,
  ): Promise<ParentBudgetRow> {
    const result = await this.database.query<ParentBudgetRow>(
      `
        WITH existing_parent AS (
          SELECT id, category, false AS inserted
          FROM budgets
          WHERE user_id::text = $1
            AND category = $2
          LIMIT 1
        ),
        inserted_parent AS (
          INSERT INTO budgets (
            user_id,
            category,
            amount,
            parent_budget_id,
            period_type,
            is_active
          )
          SELECT $1, $2, NULL, NULL, $3, true
          WHERE NOT EXISTS (SELECT 1 FROM existing_parent)
          RETURNING id, category, true AS inserted
        )
        SELECT id, category, inserted FROM existing_parent
        UNION ALL
        SELECT id, category, inserted FROM inserted_parent
        LIMIT 1
      `,
      [userId, parentCategory, periodType],
    );

    const parentBudget = result.rows[0];

    if (!parentBudget) {
      throw new Error('Parent budget upsert did not return a row');
    }

    return parentBudget;
  }

  private async getCycleStartDay(userId: string): Promise<number> {
    const result = await this.database.query<CycleStartRow>(
      `
        SELECT cycle_start_day
        FROM telegram_users
        WHERE id::text = $1 OR telegram_id::text = $1
        LIMIT 1
      `,
      [userId],
    );

    const cycleStartDay = result.rows[0]?.cycle_start_day;

    if (cycleStartDay === undefined) {
      throw new NotFoundException('Telegram user not found');
    }

    return this.normalizeCycleStartDay(cycleStartDay);
  }

  private normalizeCycleStartDay(value: number | string | null | undefined): number {
    const day = Number(value ?? 1);

    if (!Number.isFinite(day)) {
      return 1;
    }

    return Math.min(Math.max(Math.trunc(day), 1), 31);
  }

  private parseReferenceDate(asOfDate?: string): Date {
    if (!asOfDate) {
      return new Date();
    }

    const date = /^\d{4}-\d{2}-\d{2}$/.test(asOfDate)
      ? new Date(`${asOfDate}T00:00:00.000Z`)
      : new Date(asOfDate);

    if (Number.isNaN(date.getTime())) {
      throw new BadRequestException('asOfDate must be a valid date');
    }

    return date;
  }

  private utcCycleDate(year: number, month: number, cycleStartDay: number): Date {
    const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    const day = Math.min(cycleStartDay, daysInMonth);

    return new Date(Date.UTC(year, month, day));
  }

  private toDateString(date: Date): string {
    return date.toISOString().slice(0, 10);
  }

  private toNumber(value: unknown): number {
    if (value === null || value === undefined) {
      return 0;
    }

    const numberValue = Number(value);
    return Number.isFinite(numberValue) ? numberValue : 0;
  }

  private calculateSpentPercent(spentAmount: number, budgetAmount: number): number {
    return budgetAmount > 0
      ? Math.round((spentAmount / budgetAmount) * 10000) / 100
      : 0;
  }

  private mapChildBreakdown(value: unknown): BudgetStatusChildBreakdownDto[] {
    const items = this.parseChildBreakdown(value);

    return items.map((item) => {
      const budgetAmount = this.toNumber(item.budget_amount);
      const spentAmount = this.toNumber(item.spent_amount);

      return {
        budget_id: String(item.budget_id),
        category: String(item.category),
        budget_amount: budgetAmount,
        spent_amount: spentAmount,
        remaining_amount: budgetAmount - spentAmount,
        spent_percent: this.calculateSpentPercent(spentAmount, budgetAmount),
      };
    });
  }

  private parseChildBreakdown(value: unknown): Array<Record<string, unknown>> {
    if (Array.isArray(value)) {
      return value.filter(this.isRecord);
    }

    if (typeof value !== 'string') {
      return [];
    }

    try {
      const parsed: unknown = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.filter(this.isRecord) : [];
    } catch {
      return [];
    }
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  private cleanString(value: string | undefined): string | undefined {
    const cleaned = value?.trim();
    return cleaned ? cleaned : undefined;
  }
}
