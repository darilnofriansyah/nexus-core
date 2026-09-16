import { Injectable } from '@nestjs/common';
import { QueryResultRow } from 'pg';
import { DatabaseService } from '../../database/database.service';

export interface ConversationalUser {
  id: string;
  telegramUserId: string | null;
  cycleStartDay: number;
}

export interface AmountCount {
  total: number;
  count: number;
}

export interface BreakdownItem {
  name: string;
  amount: number;
  count: number;
}

export interface TransactionItem {
  id: string;
  amount: number;
  merchant: string | null;
  category: string | null;
  transactionDate: string;
}

export interface DailyItem {
  date: string;
  amount: number;
  count: number;
}

export interface WeekpartItem {
  period: 'weekday' | 'weekend';
  amount: number;
  count: number;
}

export interface CashflowSummary {
  incomeTotal: number;
  expenseTotal: number;
  net: number;
  incomeCount: number;
  expenseCount: number;
}

export interface BudgetItem {
  id?: string;
  category: string;
  amount: number;
  categories: string[];
}

export interface RiskReviewPattern {
  name: string;
  count: number;
}

export interface RiskReviewSummary {
  flaggedCount: number;
  answeredCount: number;
  regretCount: number;
  regretAmount: number;
  topRegretCategory: RiskReviewPattern | null;
  topRegretMerchant: RiskReviewPattern | null;
}

interface UserRow extends QueryResultRow {
  id: string | number;
  telegram_id: string | number | null;
  cycle_start_day: string | number | null;
}

interface AmountCountRow extends QueryResultRow {
  total: string | number | null;
  count: string | number;
}

interface BreakdownRow extends QueryResultRow {
  name: string | null;
  amount: string | number | null;
  count: string | number;
}

interface TransactionRow extends QueryResultRow {
  id: string | number;
  amount: string | number;
  merchant: string | null;
  category: string | null;
  transaction_date: string | Date;
}

interface DailyRow extends QueryResultRow {
  day: string | Date;
  amount: string | number | null;
  count: string | number;
}

interface WeekpartRow extends QueryResultRow {
  period: 'weekday' | 'weekend';
  amount: string | number | null;
  count: string | number;
}

interface CashflowRow extends QueryResultRow {
  income_total: string | number | null;
  expense_total: string | number | null;
  income_count: string | number;
  expense_count: string | number;
}

interface BudgetRow extends QueryResultRow {
  id: string | number;
  category: string;
  amount: string | number;
  categories: string[] | string;
}

interface RiskReviewSummaryRow extends QueryResultRow {
  flagged_count: string | number;
  answered_count: string | number;
  regret_count: string | number;
  regret_amount: string | number | null;
  top_regret_category: string | null;
  top_regret_category_count: string | number | null;
  top_regret_merchant: string | null;
  top_regret_merchant_count: string | number | null;
}

@Injectable()
export class ConversationalRepository {
  constructor(private readonly database: DatabaseService) {}

  async findUser(
    userId: string | null,
    telegramUserId: string | null,
  ): Promise<ConversationalUser | null> {
    const result = await this.database.query<UserRow>(
      `
        SELECT id, telegram_id, cycle_start_day
        FROM telegram_users
        WHERE ($1::text IS NOT NULL AND id::text = $1::text)
          OR ($2::text IS NOT NULL AND telegram_id::text = $2::text)
        ORDER BY CASE WHEN id::text = $1::text THEN 0 ELSE 1 END
        LIMIT 1
      `,
      [userId, telegramUserId],
    );
    const row = result.rows[0];

    if (!row) {
      return null;
    }

    return {
      id: String(row.id),
      telegramUserId: row.telegram_id == null ? null : String(row.telegram_id),
      cycleStartDay: this.clampCycleStartDay(row.cycle_start_day),
    };
  }

  async expenseTotal(
    userId: string,
    start: string,
    end: string,
  ): Promise<AmountCount> {
    const result = await this.database.query<AmountCountRow>(
      `
        SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*) AS count
        FROM transactions
        WHERE user_id::text = $1
          AND status = 'confirmed'
          AND transaction_type = 'expense'
          AND transaction_date >= $2::date
          AND transaction_date < $3::date
      `,
      [userId, start, end],
    );

    return this.mapAmountCount(result.rows[0]);
  }

  async categoryTotal(
    userId: string,
    category: string,
    start: string,
    end: string,
  ): Promise<AmountCount> {
    const result = await this.database.query<AmountCountRow>(
      `
        SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*) AS count
        FROM transactions
        WHERE user_id::text = $1
          AND status = 'confirmed'
          AND transaction_type = 'expense'
          AND transaction_date >= $2::date
          AND transaction_date < $3::date
          AND lower(category) = lower($4)
      `,
      [userId, start, end, category],
    );

    return this.mapAmountCount(result.rows[0]);
  }

  async merchantTotal(
    userId: string,
    merchant: string,
    start: string,
    end: string,
  ): Promise<AmountCount> {
    const result = await this.database.query<AmountCountRow>(
      `
        SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*) AS count
        FROM transactions
        WHERE user_id::text = $1
          AND status = 'confirmed'
          AND transaction_type = 'expense'
          AND transaction_date >= $2::date
          AND transaction_date < $3::date
          AND (
            merchant_normalized ILIKE '%' || $4 || '%'
            OR merchant ILIKE '%' || $4 || '%'
          )
      `,
      [userId, start, end, merchant],
    );

    return this.mapAmountCount(result.rows[0]);
  }

  async topCategories(
    userId: string,
    start: string,
    end: string,
    limit: number,
  ): Promise<BreakdownItem[]> {
    const result = await this.database.query<BreakdownRow>(
      `
        SELECT category AS name, COALESCE(SUM(amount), 0) AS amount, COUNT(*) AS count
        FROM transactions
        WHERE user_id::text = $1
          AND status = 'confirmed'
          AND transaction_type = 'expense'
          AND transaction_date >= $2::date
          AND transaction_date < $3::date
          AND category IS NOT NULL
        GROUP BY category
        ORDER BY amount DESC
        LIMIT $4
      `,
      [userId, start, end, limit],
    );

    return this.mapBreakdown(result.rows);
  }

  async topMerchants(
    userId: string,
    start: string,
    end: string,
    limit: number,
  ): Promise<BreakdownItem[]> {
    const result = await this.database.query<BreakdownRow>(
      `
        SELECT COALESCE(merchant_normalized, merchant) AS name, COALESCE(SUM(amount), 0) AS amount, COUNT(*) AS count
        FROM transactions
        WHERE user_id::text = $1
          AND status = 'confirmed'
          AND transaction_type = 'expense'
          AND transaction_date >= $2::date
          AND transaction_date < $3::date
          AND COALESCE(merchant_normalized, merchant) IS NOT NULL
        GROUP BY COALESCE(merchant_normalized, merchant)
        ORDER BY amount DESC
        LIMIT $4
      `,
      [userId, start, end, limit],
    );

    return this.mapBreakdown(result.rows);
  }

  async largestTransactions(
    userId: string,
    start: string,
    end: string,
    limit: number,
  ): Promise<TransactionItem[]> {
    const result = await this.database.query<TransactionRow>(
      `
        SELECT id, amount, merchant, category, transaction_date
        FROM transactions
        WHERE user_id::text = $1
          AND status = 'confirmed'
          AND transaction_type = 'expense'
          AND transaction_date >= $2::date
          AND transaction_date < $3::date
        ORDER BY amount DESC, transaction_date DESC
        LIMIT $4
      `,
      [userId, start, end, limit],
    );

    return result.rows.map((row) => this.mapTransaction(row));
  }

  async recentTransactions(
    userId: string,
    start: string,
    end: string,
    limit: number,
  ): Promise<TransactionItem[]> {
    const result = await this.database.query<TransactionRow>(
      `
        SELECT id, amount, merchant, category, transaction_date
        FROM transactions
        WHERE user_id::text = $1
          AND status = 'confirmed'
          AND transaction_date >= $2::date
          AND transaction_date < $3::date
        ORDER BY transaction_date DESC, id DESC
        LIMIT $4
      `,
      [userId, start, end, limit],
    );

    return result.rows.map((row) => this.mapTransaction(row));
  }

  async spendingByDay(
    userId: string,
    start: string,
    end: string,
  ): Promise<DailyItem[]> {
    const result = await this.database.query<DailyRow>(
      `
        SELECT transaction_date::date AS day, COALESCE(SUM(amount), 0) AS amount, COUNT(*) AS count
        FROM transactions
        WHERE user_id::text = $1
          AND status = 'confirmed'
          AND transaction_type = 'expense'
          AND transaction_date >= $2::date
          AND transaction_date < $3::date
        GROUP BY transaction_date::date
        ORDER BY transaction_date::date
      `,
      [userId, start, end],
    );

    return result.rows.map((row) => ({
      date: this.formatDate(row.day),
      amount: Number(row.amount ?? 0),
      count: Number(row.count),
    }));
  }

  async spendingByWeekpart(
    userId: string,
    start: string,
    end: string,
    timezone: string,
  ): Promise<WeekpartItem[]> {
    const result = await this.database.query<WeekpartRow>(
      `
        SELECT
          CASE
            WHEN EXTRACT(ISODOW FROM transaction_date AT TIME ZONE $4) IN (6, 7)
              THEN 'weekend'
            ELSE 'weekday'
          END AS period,
          COALESCE(SUM(amount), 0) AS amount,
          COUNT(*) AS count
        FROM transactions
        WHERE user_id::text = $1
          AND status = 'confirmed'
          AND transaction_type = 'expense'
          AND transaction_date >= $2::date
          AND transaction_date < $3::date
        GROUP BY period
        ORDER BY period
      `,
      [userId, start, end, timezone],
    );

    return result.rows.map((row) => ({
      period: row.period,
      amount: Number(row.amount ?? 0),
      count: Number(row.count),
    }));
  }

  async cashflowSummary(
    userId: string,
    start: string,
    end: string,
  ): Promise<CashflowSummary> {
    const result = await this.database.query<CashflowRow>(
      `
        SELECT
          COALESCE(SUM(amount) FILTER (WHERE transaction_type = 'income'), 0) AS income_total,
          COALESCE(SUM(amount) FILTER (WHERE transaction_type = 'expense'), 0) AS expense_total,
          COUNT(*) FILTER (WHERE transaction_type = 'income') AS income_count,
          COUNT(*) FILTER (WHERE transaction_type = 'expense') AS expense_count
        FROM transactions
        WHERE user_id::text = $1
          AND status = 'confirmed'
          AND transaction_type IN ('income', 'expense')
          AND transaction_date >= $2::date
          AND transaction_date < $3::date
      `,
      [userId, start, end],
    );
    const row = result.rows[0];
    const incomeTotal = Number(row?.income_total ?? 0);
    const expenseTotal = Number(row?.expense_total ?? 0);

    return {
      incomeTotal,
      expenseTotal,
      net: incomeTotal - expenseTotal,
      incomeCount: Number(row?.income_count ?? 0),
      expenseCount: Number(row?.expense_count ?? 0),
    };
  }

  async riskReviewSummary(
    userId: string,
    start: string,
    end: string,
  ): Promise<RiskReviewSummary> {
    const result = await this.database.query<RiskReviewSummaryRow>(
      `
        WITH reviewed AS (
          SELECT
            r.user_response,
            t.amount,
            t.category,
            COALESCE(t.merchant_normalized, t.merchant) AS merchant
          FROM transaction_risk_reviews r
          JOIN transactions t
            ON t.id = r.transaction_id
            AND t.user_id = r.user_id
          WHERE r.user_id::text = $1
            AND r.risk_type = 'large_transaction'
            AND r.risk_level IN ('high', 'critical')
            AND t.status = 'confirmed'
            AND t.transaction_type = 'expense'
            AND t.transaction_date >= $2::date
            AND t.transaction_date < $3::date
        ),
        summary AS (
          SELECT
            COUNT(*) AS flagged_count,
            COUNT(*) FILTER (WHERE user_response IS NOT NULL) AS answered_count,
            COUNT(*) FILTER (WHERE user_response = 'regret') AS regret_count,
            COALESCE(SUM(amount) FILTER (WHERE user_response = 'regret'), 0) AS regret_amount
          FROM reviewed
        ),
        top_category AS (
          SELECT category AS name, COUNT(*) AS count
          FROM reviewed
          WHERE user_response = 'regret'
            AND category IS NOT NULL
          GROUP BY category
          HAVING COUNT(*) >= 2
          ORDER BY count DESC, category
          LIMIT 1
        ),
        top_merchant AS (
          SELECT merchant AS name, COUNT(*) AS count
          FROM reviewed
          WHERE user_response = 'regret'
            AND merchant IS NOT NULL
          GROUP BY merchant
          HAVING COUNT(*) >= 2
          ORDER BY count DESC, merchant
          LIMIT 1
        )
        SELECT
          s.flagged_count,
          s.answered_count,
          s.regret_count,
          s.regret_amount,
          tc.name AS top_regret_category,
          tc.count AS top_regret_category_count,
          tm.name AS top_regret_merchant,
          tm.count AS top_regret_merchant_count
        FROM summary s
        LEFT JOIN top_category tc ON true
        LEFT JOIN top_merchant tm ON true
      `,
      [userId, start, end],
    );
    const row = result.rows[0];

    return {
      flaggedCount: Number(row?.flagged_count ?? 0),
      answeredCount: Number(row?.answered_count ?? 0),
      regretCount: Number(row?.regret_count ?? 0),
      regretAmount: Number(row?.regret_amount ?? 0),
      topRegretCategory: this.mapRiskReviewPattern(
        row?.top_regret_category,
        row?.top_regret_category_count,
      ),
      topRegretMerchant: this.mapRiskReviewPattern(
        row?.top_regret_merchant,
        row?.top_regret_merchant_count,
      ),
    };
  }

  async activeBudgets(
    userId: string,
    category: string | null = null,
  ): Promise<BudgetItem[]> {
    const result = await this.database.query<BudgetRow>(
      `
        SELECT
          b.id,
          b.category,
          COALESCE(b.amount, 0) AS amount,
          ARRAY[b.category] || COALESCE(
            ARRAY_AGG(child.category ORDER BY child.category)
              FILTER (WHERE child.id IS NOT NULL),
            ARRAY[]::text[]
          ) AS categories
        FROM budgets b
        LEFT JOIN budgets child
          ON child.parent_budget_id = b.id
          AND child.is_active = true
        WHERE b.user_id::text = $1
          AND b.is_active = true
          AND b.parent_budget_id IS NULL
          AND ($2::text IS NULL OR lower(b.category) = lower($2))
        GROUP BY b.id, b.category, b.amount
        HAVING b.amount IS NOT NULL
        ORDER BY b.category
      `,
      [userId, category],
    );

    return result.rows.map((row) => ({
      id: String(row.id),
      category: row.category,
      amount: Number(row.amount),
      categories: Array.isArray(row.categories)
        ? row.categories
        : String(row.categories)
            .replace(/[{}]/g, '')
            .split(',')
            .filter(Boolean),
    }));
  }

  async pocketTotal(userId: string, pocketId: string, categories: string[], start: string, end: string): Promise<AmountCount> {
    const result = await this.database.query<AmountCountRow>(
      `SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*) AS count FROM transactions t
       WHERE t.user_id::text = $1 AND t.status = 'confirmed' AND t.transaction_type = 'expense'
         AND t.transaction_date >= $2::date AND t.transaction_date < $3::date
         AND (t.pocket_id::text = $4 OR (t.pocket_id IS NULL AND lower(t.category) = ANY(SELECT lower(value) FROM unnest($5::text[]) value)))`,
      [userId, start, end, pocketId, categories],
    );
    return this.mapAmountCount(result.rows[0]);
  }

  private mapBreakdown(rows: BreakdownRow[]): BreakdownItem[] {
    return rows.map((row) => ({
      name: row.name ?? 'Uncategorized',
      amount: Number(row.amount ?? 0),
      count: Number(row.count),
    }));
  }

  private mapAmountCount(row: AmountCountRow | undefined): AmountCount {
    return {
      total: Number(row?.total ?? 0),
      count: Number(row?.count ?? 0),
    };
  }

  private mapRiskReviewPattern(
    name: string | null | undefined,
    count: string | number | null | undefined,
  ): RiskReviewPattern | null {
    return name && count ? { name, count: Number(count) } : null;
  }

  private mapTransaction(row: TransactionRow): TransactionItem {
    return {
      id: String(row.id),
      amount: Number(row.amount),
      merchant: row.merchant,
      category: row.category,
      transactionDate: this.formatDate(row.transaction_date),
    };
  }

  private formatDate(value: Date | string): string {
    return value instanceof Date
      ? value.toISOString().slice(0, 10)
      : value.slice(0, 10);
  }

  private clampCycleStartDay(value: string | number | null): number {
    const day = Number(value ?? 1);
    return Number.isFinite(day)
      ? Math.min(Math.max(Math.trunc(day), 1), 31)
      : 1;
  }
}
