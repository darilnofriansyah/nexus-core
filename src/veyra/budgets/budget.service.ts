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
  BudgetStatusRequestDto,
  BudgetStatusResponseDto,
} from './dto/budget-status.dto';

interface BudgetStatusRow extends QueryResultRow {
  budget_id: string | number;
  category: string;
  parent_budget_id: string | number | null;
  budget_amount: string | number;
  spent_amount: string | number | null;
}

interface CycleStartRow extends QueryResultRow {
  cycle_start_day: number | string;
}

interface ParentBudgetRow extends QueryResultRow {
  id: string | number;
  category: string;
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
          SELECT b.id, b.category, b.parent_budget_id, b.budget_amount
          FROM budgets b
          JOIN matched_user u ON u.id = b.user_id
          WHERE lower(b.category) = lower($2)
          LIMIT 1
        ),
        budget_scope AS (
          SELECT id, category
          FROM selected_budget
          UNION
          SELECT child.id, child.category
          FROM budgets child
          JOIN selected_budget parent ON child.parent_budget_id = parent.id
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
        )
        SELECT
          sb.id AS budget_id,
          sb.category,
          sb.parent_budget_id,
          sb.budget_amount,
          spending.spent_amount
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
      ? await this.findParentBudget(userId, parentCategory)
      : null;
    const parentBudgetId = parentBudget ? String(parentBudget.id) : null;

    const result = await this.database.query<BudgetUpsertRow>(
      `
        INSERT INTO budgets (
          user_id,
          category,
          budget_amount,
          parent_budget_id,
          period_type
        )
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (user_id, category)
        DO UPDATE SET
          budget_amount = EXCLUDED.budget_amount,
          period_type = EXCLUDED.period_type,
          parent_budget_id = CASE
            WHEN $6::boolean THEN EXCLUDED.parent_budget_id
            ELSE budgets.parent_budget_id
          END
        RETURNING
          budgets.id AS budget_id,
          budgets.user_id,
          budgets.category,
          budgets.budget_amount AS amount,
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
    const spentPercent =
      budgetAmount > 0
        ? Math.round((spentAmount / budgetAmount) * 10000) / 100
        : 0;

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

  private async findParentBudget(
    userId: string,
    parentCategory: string,
  ): Promise<ParentBudgetRow> {
    const result = await this.database.query<ParentBudgetRow>(
      `
        SELECT id, category
        FROM budgets
        WHERE user_id::text = $1
          AND lower(category) = lower($2)
        LIMIT 1
      `,
      [userId, parentCategory],
    );

    const parentBudget = result.rows[0];

    if (!parentBudget) {
      throw new NotFoundException('Parent budget not found');
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

  private toNumber(value: string | number | null | undefined): number {
    if (value === null || value === undefined) {
      return 0;
    }

    const numberValue = Number(value);
    return Number.isFinite(numberValue) ? numberValue : 0;
  }

  private cleanString(value: string | undefined): string | undefined {
    const cleaned = value?.trim();
    return cleaned ? cleaned : undefined;
  }
}
