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

interface BudgetOverviewRow extends QueryResultRow {
  budget_id: string | number;
  category: string;
  parent_budget_id: string | number | null;
  parent_category: string | null;
  amount: string | number | null;
  spent_amount: string | number | null;
  child_count: string | number;
}

interface AlertExistsRow extends QueryResultRow {
  exists: boolean;
}

type BudgetHandleIntent =
  | 'budget_status'
  | 'budget_overview'
  | 'set_budget'
  | 'set_sub_budget'
  | 'delete_budget'
  | 'delete_sub_budget'
  | 'reset'
  | 'unknown';

type BudgetHandleStateName = 'idle' | 'budget_conversation_state';

interface BudgetHandlePayload {
  intent?: BudgetHandleIntent;
  category?: string;
  parent_category?: string;
  amount?: number;
  missing_fields?: string[];
  pending?: boolean;
}

interface BudgetHandleStateStore {
  upsertState(request: {
    userId: string | number;
    stateName: BudgetHandleStateName;
    stateData?: unknown;
    expiresAt?: string | null;
  }): Promise<unknown>;
  resetState(request: { userId: string | number }): Promise<unknown>;
}

interface BudgetHandleTelegramMessage {
  text: string;
  parse_mode: 'HTML';
  disable_web_page_preview: true;
}

interface BudgetHandleStateResponse {
  nextState: BudgetHandleStateName;
  payload: BudgetHandlePayload | Record<string, never>;
}

interface BudgetOverviewItem {
  budget_id: string;
  category: string;
  parent_budget_id: string | null;
  parent_category: string | null;
  amount: number;
  spent_amount: number;
  child_count: number;
}

export interface BudgetHandleRequestDto {
  telegramUserId?: string;
  userId: string | number;
  text?: string;
  statePayload?: Record<string, unknown>;
  llmResult?: Record<string, unknown>;
}

export interface BudgetHandleResponseDto {
  ok: true;
  state: BudgetHandleStateResponse;
  message: BudgetHandleTelegramMessage;
  data: Record<string, unknown>;
}

@Injectable()
export class BudgetService {
  private readonly budgetOverviewMaxMessageLength = 3500;

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
        direct_spending AS (
          SELECT COALESCE(SUM(t.amount), 0) AS spent_amount
          FROM transactions t
          JOIN matched_user u ON u.id = t.user_id
          JOIN selected_budget b ON lower(t.category) = lower(b.category)
          WHERE t.status = 'confirmed'
            AND t.transaction_type = 'expense'
            AND t.transaction_date >= $3::date
            AND t.transaction_date < $4::date
        ),
        totals AS (
          SELECT
            CASE
              WHEN EXISTS (SELECT 1 FROM child_spending)
              THEN COALESCE(SUM(child_spending.budget_amount), 0)
              ELSE (SELECT budget_amount FROM selected_budget)
            END AS budget_amount,
            CASE
              WHEN EXISTS (SELECT 1 FROM child_spending)
              THEN COALESCE(SUM(child_spending.spent_amount), 0)
              ELSE (SELECT spent_amount FROM direct_spending)
            END AS spent_amount
          FROM child_spending
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
          totals.budget_amount,
          totals.spent_amount,
          child_breakdown.child_breakdown
        FROM selected_budget sb
        CROSS JOIN totals
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
        WITH existing_budget AS (
          SELECT id
          FROM budgets
          WHERE user_id::text = $1
            AND category = $2
            AND (
              $6::boolean = false
              OR parent_budget_id::text = $4
            )
          ORDER BY parent_budget_id NULLS FIRST, id
          LIMIT 1
        ),
        updated_budget AS (
          UPDATE budgets
          SET
            amount = $3,
            period_type = $5,
            parent_budget_id = CASE
              WHEN $6::boolean THEN $4::bigint
              ELSE budgets.parent_budget_id
            END
          WHERE id = (SELECT id FROM existing_budget)
          RETURNING
            id AS budget_id,
            user_id,
            category,
            amount,
            parent_budget_id,
            period_type,
            false AS inserted
        ),
        inserted_budget AS (
          INSERT INTO budgets (
            user_id,
            category,
            amount,
            parent_budget_id,
            period_type,
            is_active
          )
          SELECT $1::bigint, $2, $3, $4::bigint, $5, true
          WHERE NOT EXISTS (SELECT 1 FROM updated_budget)
          RETURNING
            id AS budget_id,
            user_id,
            category,
            amount,
            parent_budget_id,
            period_type,
            true AS inserted
        ),
        changed_budget AS (
          SELECT * FROM updated_budget
          UNION ALL
          SELECT * FROM inserted_budget
        )
        SELECT
          changed_budget.budget_id,
          changed_budget.user_id,
          changed_budget.category,
          changed_budget.amount,
          changed_budget.parent_budget_id,
          parent.category AS parent_category,
          changed_budget.period_type,
          changed_budget.inserted
        FROM changed_budget
        LEFT JOIN budgets parent
          ON parent.id = changed_budget.parent_budget_id
        LIMIT 1
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

  async handleBudgetRequest(
    request: BudgetHandleRequestDto,
    stateStore: BudgetHandleStateStore,
  ): Promise<BudgetHandleResponseDto> {
    const userId = request.userId;

    if (this.isResetText(request.text)) {
      await stateStore.resetState({ userId });
      return this.buildHandleResponse({
        nextState: 'idle',
        payload: {},
        text: 'Budget action cancelled.',
        data: { intent: 'reset' },
      });
    }

    const payload = this.mergeBudgetHandlePayload(
      request.statePayload,
      request.llmResult,
    );
    const intent = this.resolveBudgetHandleIntent(payload, request.text);

    if (intent === 'reset') {
      await stateStore.resetState({ userId });
      return this.buildHandleResponse({
        nextState: 'idle',
        payload: {},
        text: 'Budget action cancelled.',
        data: { intent },
      });
    }

    if (intent === 'unknown') {
      await stateStore.resetState({ userId });
      return this.buildHandleResponse({
        nextState: 'idle',
        payload: {},
        text: 'What do you want to do: show or set a budget?',
        data: { intent },
      });
    }

    if (intent === 'delete_budget' || intent === 'delete_sub_budget') {
      await stateStore.resetState({ userId });
      return this.buildHandleResponse({
        nextState: 'idle',
        payload: {},
        text: 'Delete not wired yet. Budget unchanged.',
        data: {
          intent,
          category: payload.category ?? null,
          parent_category: payload.parent_category ?? null,
        },
      });
    }

    const missingField = this.firstMissingBudgetHandleField(intent, payload);

    if (missingField) {
      const pendingPayload = this.buildPendingBudgetPayload(
        intent,
        payload,
        missingField,
      );
      await stateStore.upsertState({
        userId,
        stateName: 'budget_conversation_state',
        stateData: pendingPayload,
      });

      return this.buildHandleResponse({
        nextState: 'budget_conversation_state',
        payload: pendingPayload,
        text: this.buildBudgetFollowUpQuestion(missingField, pendingPayload),
        data: {
          intent,
          category: pendingPayload.category ?? null,
          parent_category: pendingPayload.parent_category ?? null,
          missing_field: missingField,
        },
      });
    }

    if (intent === 'budget_overview') {
      const messages = await this.getBudgetOverviewMessages(String(userId));
      await stateStore.resetState({ userId });

      return this.buildHandleResponse({
        nextState: 'idle',
        payload: {},
        text: messages[0] ?? '',
        data: {
          intent,
          messages,
          message: messages[0] ?? '',
        },
      });
    }

    if (intent === 'budget_status') {
      const status = await this.getBudgetStatus({
        userId: String(userId),
        telegramUserId: request.telegramUserId,
        category: payload.category as string,
      });
      await stateStore.resetState({ userId });

      return this.buildHandleResponse({
        nextState: 'idle',
        payload: {},
        text: this.buildBudgetStatusTelegramHtml(status),
        data: {
          intent,
          category: status.category,
          budget_id: status.budget_id,
        },
      });
    }

    const upsert = await this.upsertBudget({
      userId: String(userId),
      category: payload.category as string,
      amount: payload.amount as number,
      parentCategory:
        intent === 'set_sub_budget' ? payload.parent_category : undefined,
      periodType: 'monthly',
    });
    await stateStore.resetState({ userId });

    return this.buildHandleResponse({
      nextState: 'idle',
      payload: {},
      text: this.buildBudgetUpsertTelegramHtml(upsert),
      data: {
        intent,
        category: upsert.category,
        parent_category: upsert.parent_category,
        action: upsert.action,
        budget_id: upsert.budget_id,
      },
    });
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

  private mergeBudgetHandlePayload(
    statePayload: Record<string, unknown> | undefined,
    llmResult: Record<string, unknown> | undefined,
  ): BudgetHandlePayload {
    const previous = this.normalizeBudgetHandlePayload(statePayload);
    const next = this.normalizeBudgetHandlePayload(llmResult);
    const merged: BudgetHandlePayload = {
      ...previous,
      ...this.withoutUndefinedBudgetFields(next),
    };

    if (
      previous.pending &&
      next.intent === 'unknown' &&
      previous.intent &&
      previous.intent !== 'unknown' &&
      this.hasBudgetHandleProgress(next)
    ) {
      merged.intent = previous.intent;
    }

    return merged;
  }

  private normalizeBudgetHandlePayload(
    value: Record<string, unknown> | undefined,
  ): BudgetHandlePayload {
    if (!value) {
      return {};
    }

    return {
      intent: this.normalizeBudgetHandleIntent(value.intent),
      category: this.cleanStringValue(value.category),
      parent_category:
        this.cleanStringValue(value.parent_category) ??
        this.cleanStringValue(value.parentCategory),
      amount: this.normalizePositiveAmount(value.amount),
      missing_fields: Array.isArray(value.missing_fields)
        ? value.missing_fields
            .map((field) => this.cleanStringValue(field))
            .filter((field): field is string => Boolean(field))
        : undefined,
      pending: value.pending === true,
    };
  }

  private withoutUndefinedBudgetFields(
    payload: BudgetHandlePayload,
  ): BudgetHandlePayload {
    return Object.fromEntries(
      Object.entries(payload).filter(([, value]) => value !== undefined),
    ) as BudgetHandlePayload;
  }

  private resolveBudgetHandleIntent(
    payload: BudgetHandlePayload,
    text?: string,
  ): BudgetHandleIntent {
    const intent = payload.intent ?? 'unknown';

    if (
      intent === 'set_budget' &&
      (payload.parent_category || this.hasParentRelationshipText(text))
    ) {
      return 'set_sub_budget';
    }

    return intent;
  }

  private hasBudgetHandleProgress(payload: BudgetHandlePayload): boolean {
    return Boolean(payload.category || payload.parent_category || payload.amount);
  }

  private hasParentRelationshipText(value: string | undefined): boolean {
    const text = value?.trim().toLowerCase();
    return Boolean(
      text && /\b(parent|sub[-\s]?budget|under|inside)\b/.test(text),
    );
  }

  private normalizeBudgetHandleIntent(value: unknown): BudgetHandleIntent | undefined {
    const intent = this.cleanStringValue(value) as BudgetHandleIntent | undefined;
    const supported: BudgetHandleIntent[] = [
      'budget_status',
      'budget_overview',
      'set_budget',
      'set_sub_budget',
      'delete_budget',
      'delete_sub_budget',
      'reset',
      'unknown',
    ];

    return intent && supported.includes(intent) ? intent : undefined;
  }

  private firstMissingBudgetHandleField(
    intent: BudgetHandleIntent,
    payload: BudgetHandlePayload,
  ): 'category' | 'parent_category' | 'amount' | null {
    if (intent === 'budget_overview') {
      return null;
    }

    if (intent === 'budget_status') {
      return payload.category ? null : 'category';
    }

    if (intent === 'set_budget' || intent === 'set_sub_budget') {
      if (!payload.category) {
        return 'category';
      }

      if (intent === 'set_sub_budget' && !payload.parent_category) {
        return 'parent_category';
      }

      if (!payload.amount || payload.amount <= 0) {
        return 'amount';
      }
    }

    return null;
  }

  private async getBudgetOverviewMessages(userId: string): Promise<string[]> {
    if (!this.cleanString(userId)) {
      throw new BadRequestException('userId is required');
    }

    const cycleStartDay = await this.getCycleStartDay(userId);
    const cycle = this.calculateCurrentCycle(new Date(), cycleStartDay);
    const result = await this.database.query<BudgetOverviewRow>(
      `
        WITH matched_user AS (
          SELECT id
          FROM telegram_users
          WHERE id::text = $1 OR telegram_id::text = $1
          LIMIT 1
        ),
        active_budgets AS (
          SELECT
            b.id,
            b.category,
            b.parent_budget_id,
            b.amount,
            parent.category AS parent_category,
            COUNT(child.id) AS child_count
          FROM budgets b
          JOIN matched_user u ON u.id = b.user_id
          LEFT JOIN budgets parent ON parent.id = b.parent_budget_id
          LEFT JOIN budgets child
            ON child.parent_budget_id = b.id
            AND child.is_active = true
          WHERE b.is_active = true
          GROUP BY b.id, b.category, b.parent_budget_id, b.amount, parent.category
        ),
        spending AS (
          SELECT
            b.id AS budget_id,
            COALESCE(SUM(t.amount), 0) AS spent_amount
          FROM active_budgets b
          CROSS JOIN matched_user u
          LEFT JOIN transactions t ON t.user_id = u.id
            AND t.status = 'confirmed'
            AND t.transaction_type = 'expense'
            AND t.transaction_date >= $2::date
            AND t.transaction_date < $3::date
            AND lower(t.category) = lower(b.category)
          GROUP BY b.id
        )
        SELECT
          b.id AS budget_id,
          b.category,
          b.parent_budget_id,
          b.parent_category,
          b.amount,
          spending.spent_amount,
          b.child_count
        FROM active_budgets b
        JOIN spending ON spending.budget_id = b.id
        ORDER BY
          CASE WHEN b.parent_budget_id IS NULL THEN 0 ELSE 1 END,
          lower(COALESCE(b.parent_category, b.category)),
          lower(b.category)
      `,
      [userId, cycle.cycle_start, cycle.cycle_end],
    );

    const budgets = result.rows.map((row) => this.mapBudgetOverviewRow(row));

    if (budgets.length === 0) {
      return ['No active budgets yet. Set one when you are ready.'];
    }

    return this.chunkBudgetOverviewGroups(
      this.buildBudgetOverviewGroups(budgets),
    );
  }

  private mapBudgetOverviewRow(row: BudgetOverviewRow): BudgetOverviewItem {
    const amount = this.toNumber(row.amount);
    const spentAmount = this.toNumber(row.spent_amount);

    return {
      budget_id: String(row.budget_id),
      category: row.category,
      parent_budget_id:
        row.parent_budget_id === null || row.parent_budget_id === undefined
          ? null
          : String(row.parent_budget_id),
      parent_category: row.parent_category ?? null,
      amount,
      spent_amount: spentAmount,
      child_count: this.toNumber(row.child_count),
    };
  }

  private buildBudgetOverviewGroups(budgets: BudgetOverviewItem[]): string[] {
    const childBudgetsByParentId = new Map<string, BudgetOverviewItem[]>();
    const parentBudgetIds = new Set(
      budgets
        .filter((budget) => budget.parent_budget_id === null)
        .map((budget) => budget.budget_id),
    );
    const parentBudgets = budgets.filter(
      (budget) =>
        budget.parent_budget_id === null ||
        !parentBudgetIds.has(budget.parent_budget_id),
    );

    budgets
      .filter(
        (budget) =>
          budget.parent_budget_id !== null &&
          parentBudgetIds.has(budget.parent_budget_id),
      )
      .forEach((budget) => {
        const parentId = budget.parent_budget_id as string;
        const children = childBudgetsByParentId.get(parentId) ?? [];
        children.push(budget);
        childBudgetsByParentId.set(parentId, children);
      });

    return parentBudgets.map((budget) => {
      const children = childBudgetsByParentId
        .get(budget.budget_id)
        ?.sort((left, right) => left.category.localeCompare(right.category));

      if (!children || children.length === 0) {
        return this.formatBudgetOverviewLine(budget);
      }

      const childBudgetAmount = children.reduce(
        (total, child) => total + child.amount,
        0,
      );
      const childSpentAmount = children.reduce(
        (total, child) => total + child.spent_amount,
        0,
      );
      const parentLine = this.formatBudgetOverviewLine({
        category: budget.category,
        amount: childBudgetAmount || budget.amount,
        spent_amount: childSpentAmount,
      });
      const childLines = children.map((child, index) => {
        const prefix = index === children.length - 1 ? '└' : '├';
        return `${prefix} ${this.formatBudgetOverviewLine(child, '—')}`;
      });

      return [parentLine, ...childLines].join('\n');
    });
  }

  private formatBudgetOverviewLine(
    budget: Pick<
      BudgetOverviewItem,
      'category' | 'amount' | 'spent_amount'
    >,
    separator = '-',
  ): string {
    return `${this.escapeTelegramHtml(budget.category)} ${separator} ${this.formatTelegramCurrency(
      budget.spent_amount,
    )} / ${this.formatTelegramCurrency(budget.amount)}`;
  }

  private chunkBudgetOverviewGroups(groups: string[]): string[] {
    const header = '📊 Budget Overview';
    const messages: string[] = [];
    let current = header;

    for (const group of groups) {
      const candidate = `${current}\n\n${group}`;

      if (candidate.length <= this.budgetOverviewMaxMessageLength) {
        current = candidate;
        continue;
      }

      messages.push(current);

      if (group.length + header.length + 2 <= this.budgetOverviewMaxMessageLength) {
        current = `${header}\n\n${group}`;
        continue;
      }

      const splitGroupMessages = this.chunkLongBudgetOverviewGroup(header, group);
      messages.push(...splitGroupMessages.slice(0, -1));
      current = splitGroupMessages[splitGroupMessages.length - 1] ?? header;
    }

    messages.push(current);

    return messages;
  }

  private chunkLongBudgetOverviewGroup(header: string, group: string): string[] {
    const messages: string[] = [];
    let current = header;

    for (const line of group.split('\n')) {
      const candidate = `${current}\n${line}`;

      if (candidate.length <= this.budgetOverviewMaxMessageLength) {
        current = candidate;
        continue;
      }

      messages.push(current);
      current = `${header}\n\n${line}`;
    }

    messages.push(current);

    return messages;
  }

  private buildPendingBudgetPayload(
    intent: BudgetHandleIntent,
    payload: BudgetHandlePayload,
    missingField: string,
  ): BudgetHandlePayload {
    return this.withoutUndefinedBudgetFields({
      intent,
      category: payload.category,
      parent_category: payload.parent_category,
      amount: payload.amount,
      missing_fields: [missingField],
      pending: true,
    });
  }

  private buildBudgetFollowUpQuestion(
    missingField: string,
    payload: BudgetHandlePayload,
  ): string {
    if (missingField === 'amount' && payload.category) {
      return `How much for ${this.escapeTelegramHtml(payload.category)}?`;
    }

    if (missingField === 'parent_category' && payload.category) {
      return `Under which parent budget should ${this.escapeTelegramHtml(payload.category)} sit?`;
    }

    return 'Which budget category?';
  }

  private buildBudgetStatusTelegramHtml(
    status: BudgetStatusResponseDto,
  ): string {
    const lines = [
      'Budget status.',
      '',
      `Category: ${this.escapeTelegramHtml(status.category)}`,
      `Budget: ${this.formatTelegramCurrency(status.budget_amount)}`,
      `Spent: ${this.formatTelegramCurrency(status.spent_amount)}`,
      `Remaining: ${this.formatTelegramCurrency(status.remaining_amount)}`,
      `Used: ${status.spent_percent}%`,
    ];

    if (status.child_breakdown.length > 0) {
      lines.push('', 'Children:');
      status.child_breakdown.forEach((child) => {
        lines.push(
          `- ${this.escapeTelegramHtml(child.category)}: ${this.formatTelegramCurrency(
            child.spent_amount,
          )}/${this.formatTelegramCurrency(child.budget_amount)} (${child.spent_percent}%)`,
        );
      });
    }

    return lines.join('\n');
  }

  private buildBudgetUpsertTelegramHtml(
    upsert: BudgetUpsertResponseDto,
  ): string {
    const lines = [
      'Budget updated.',
      '',
      `Category: ${this.escapeTelegramHtml(upsert.category)}`,
      `Amount: ${this.formatTelegramCurrency(upsert.amount)}`,
    ];

    if (upsert.parent_category) {
      lines.push(`Parent: ${this.escapeTelegramHtml(upsert.parent_category)}`);
    }

    return lines.join('\n');
  }

  private buildHandleResponse(input: {
    nextState: BudgetHandleStateName;
    payload: BudgetHandlePayload | Record<string, never>;
    text: string;
    data: Record<string, unknown>;
  }): BudgetHandleResponseDto {
    return {
      ok: true,
      state: {
        nextState: input.nextState,
        payload: input.payload,
      },
      message: {
        text: input.text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      },
      data: input.data,
    };
  }

  private isResetText(value: string | undefined): boolean {
    const text = value?.trim().toLowerCase();
    return Boolean(
      text && ['reset', 'cancel', 'exit', 'stop', 'batal', 'keluar'].includes(text),
    );
  }

  private normalizePositiveAmount(value: unknown): number | undefined {
    const amount = this.toNumber(value);
    return amount > 0 ? amount : undefined;
  }

  private cleanStringValue(value: unknown): string | undefined {
    if (typeof value !== 'string') {
      return undefined;
    }

    return this.cleanString(value);
  }

  private formatTelegramCurrency(amount: number): string {
    return `Rp${new Intl.NumberFormat('id-ID', {
      maximumFractionDigits: 0,
    }).format(amount)}`;
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
          SELECT $1::bigint, $2, NULL, NULL, $3, true
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
