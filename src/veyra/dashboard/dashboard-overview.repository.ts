import { Injectable } from '@nestjs/common';
import { QueryResultRow } from 'pg';
import { DatabaseService } from '../../database/database.service';

export interface DashboardUser {
  id: string;
  telegramUserId: string;
  cycleStartDay: number;
}

export type DashboardTransactionType = 'income' | 'expense';

export interface DashboardTransaction {
  id: string;
  type: DashboardTransactionType;
  amount: number;
  merchant: string | null;
  category: string | null;
  date: string;
  timestamp: string;
}

export interface DashboardBudget {
  id: string;
  parentId: string | null;
  category: string;
  amount: number;
}

interface UserRow extends QueryResultRow {
  id: string | number;
  telegram_id: string | number;
  cycle_start_day: string | number | null;
}

interface TransactionRow extends QueryResultRow {
  id: string | number;
  transaction_type: DashboardTransactionType;
  amount: string | number;
  merchant: string | null;
  category: string | null;
  transaction_day: string;
  transaction_date: string | Date;
}

interface BudgetRow extends QueryResultRow {
  id: string | number;
  parent_budget_id: string | number | null;
  category: string;
  amount: string | number | null;
}

@Injectable()
export class DashboardOverviewRepository {
  constructor(private readonly database: DatabaseService) {}

  async findUser(
    userId: string | null,
    telegramUserId: string | null,
  ): Promise<DashboardUser | null> {
    const result = await this.database.query<UserRow>(
      `
        SELECT id, telegram_id, cycle_start_day
        FROM telegram_users
        WHERE ($1::text IS NULL OR id::text = $1)
          AND ($2::text IS NULL OR telegram_id::text = $2)
        LIMIT 1
      `,
      [userId, telegramUserId],
    );
    const row = result.rows[0];

    return row
      ? {
          id: String(row.id),
          telegramUserId: String(row.telegram_id),
          cycleStartDay: this.cycleStartDay(row.cycle_start_day),
        }
      : null;
  }

  async findTransactions(
    userId: string,
    start: string,
    end: string,
    timezone: string,
  ): Promise<DashboardTransaction[]> {
    const result = await this.database.query<TransactionRow>(
      `
        SELECT
          id,
          transaction_type,
          amount,
          COALESCE(merchant_normalized, merchant) AS merchant,
          category,
          to_char(transaction_date AT TIME ZONE $4, 'YYYY-MM-DD') AS transaction_day,
          transaction_date
        FROM transactions
        WHERE user_id::text = $1
          AND status = 'confirmed'
          AND transaction_type IN ('income', 'expense')
          AND transaction_date >= ($2::date AT TIME ZONE $4)
          AND transaction_date < ($3::date AT TIME ZONE $4)
        ORDER BY transaction_date DESC, id DESC
      `,
      [userId, start, end, timezone],
    );

    return result.rows.map((row) => ({
      id: String(row.id),
      type: row.transaction_type,
      amount: Math.round(Number(row.amount)),
      merchant: row.merchant,
      category: row.category,
      date: row.transaction_day,
      timestamp:
        row.transaction_date instanceof Date
          ? row.transaction_date.toISOString()
          : row.transaction_date,
    }));
  }

  async findActiveBudgets(userId: string): Promise<DashboardBudget[]> {
    const result = await this.database.query<BudgetRow>(
      `
        SELECT b.id, b.parent_budget_id, b.category, b.amount
        FROM budgets b
        LEFT JOIN budgets parent ON parent.id = b.parent_budget_id
        WHERE b.user_id::text = $1
          AND b.is_active = true
          AND (b.parent_budget_id IS NULL OR parent.is_active = true)
        ORDER BY b.parent_budget_id NULLS FIRST, b.id
      `,
      [userId],
    );

    return result.rows.map((row) => ({
      id: String(row.id),
      parentId:
        row.parent_budget_id === null ? null : String(row.parent_budget_id),
      category: row.category,
      amount: Math.round(Number(row.amount ?? 0)),
    }));
  }

  private cycleStartDay(value: string | number | null): number {
    const day = Number(value ?? 1);
    return Number.isFinite(day)
      ? Math.min(Math.max(Math.trunc(day), 1), 31)
      : 1;
  }
}
