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

  async activeBudgets(
    userId: string,
    category: string | null = null,
  ): Promise<BudgetItem[]> {
    const result = await this.database.query<BudgetRow>(
      `
        SELECT
          b.id,
          b.category,
          CASE
            WHEN COUNT(child.id) > 0 THEN COALESCE(SUM(child.amount), 0)
            ELSE b.amount
          END AS amount,
          CASE
            WHEN COUNT(child.id) > 0 THEN ARRAY_AGG(child.category ORDER BY child.category)
            ELSE ARRAY[b.category]
          END AS categories
        FROM budgets b
        LEFT JOIN budgets child
          ON child.parent_budget_id = b.id
          AND child.is_active = true
          AND child.amount IS NOT NULL
        WHERE b.user_id::text = $1
          AND b.is_active = true
          AND (($2::text IS NULL AND b.parent_budget_id IS NULL) OR lower(b.category) = lower($2))
        GROUP BY b.id, b.category, b.amount
        HAVING b.amount IS NOT NULL OR COUNT(child.id) > 0
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
