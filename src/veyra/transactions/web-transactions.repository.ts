import { Injectable } from '@nestjs/common';
import { QueryResultRow } from 'pg';
import { DatabaseService } from '../../database/database.service';
import {
  WebTransactionRow,
  WebTransactionsFilter,
  WebTransactionsUser,
} from './dto/web-transactions.dto';

interface UserRow extends QueryResultRow {
  id: string | number;
  telegram_id: string | number;
  cycle_start_day: string | number | null;
}

interface TransactionRow extends QueryResultRow {
  id: string | number;
  amount: string | number;
  merchant: string | null;
  category: string | null;
  transaction_type: WebTransactionRow['transactionType'];
  source: WebTransactionRow['source'];
  transaction_date: string;
  updated_at: string;
  credit_card: boolean;
}

interface CategoryRow extends QueryResultRow {
  category: string;
}

type CategoryFilter = Omit<
  WebTransactionsFilter,
  'category' | 'cursor' | 'direction' | 'limit'
>;

interface QueryParts {
  predicates: string[];
  values: unknown[];
}

@Injectable()
export class WebTransactionsRepository {
  constructor(private readonly database: DatabaseService) {}

  async findActiveUserByTelegramId(
    telegramUserId: string,
  ): Promise<WebTransactionsUser | null> {
    const result = await this.database.query<UserRow>(
      `
        SELECT id, telegram_id, cycle_start_day
        FROM telegram_users
        WHERE telegram_id = $1::bigint
          AND is_active IS TRUE
        LIMIT 1
      `,
      [telegramUserId],
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
    filter: WebTransactionsFilter,
  ): Promise<WebTransactionRow[]> {
    const query = this.filteredQuery(userId, filter);
    this.addCursor(query, filter);
    query.values.push(filter.limit + 1);
    const order = filter.direction === 'previous' ? 'ASC' : 'DESC';
    const result = await this.database.query<TransactionRow>(
      `
        SELECT
          id,
          amount,
          merchant,
          category,
          transaction_type,
          source,
          to_char(transaction_date AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS transaction_date,
          to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at,
          source = 'email'
            AND lower(trim(COALESCE(raw_payload -> 'parsed' ->> 'paymentType', ''))) = 'credit card'
            AND transaction_type = 'expense' AS credit_card
        FROM transactions
        WHERE ${query.predicates.join('\n          AND ')}
        ORDER BY transaction_date ${order}, id ${order}
        LIMIT $${query.values.length}
      `,
      query.values,
    );
    const rows =
      filter.direction === 'previous' ? result.rows.reverse() : result.rows;

    return rows.map((row) => this.transaction(row));
  }

  async findCategories(
    userId: string,
    filter: CategoryFilter,
  ): Promise<string[]> {
    const query = this.filteredQuery(userId, filter);
    const result = await this.database.query<CategoryRow>(
      `
        SELECT category
        FROM transactions
        WHERE ${query.predicates.join('\n          AND ')}
          AND category IS NOT NULL
          AND btrim(category) <> ''
        GROUP BY category
        ORDER BY category
      `,
      query.values,
    );

    return result.rows.map((row) => row.category);
  }

  private filteredQuery(
    userId: string,
    filter: CategoryFilter | WebTransactionsFilter,
  ): QueryParts {
    const query: QueryParts = {
      predicates: [
        'user_id = $1',
        "status = 'confirmed'",
        "transaction_type IN ('income', 'expense')",
      ],
      values: [userId],
    };

    this.addValuePredicate(query, filter.type, 'transaction_type');
    if ('category' in filter) {
      this.addValuePredicate(query, filter.category, 'category');
    }
    this.addMerchantPredicate(query, filter.merchantQuery);
    this.addDatePredicates(query, filter);
    return query;
  }

  private addValuePredicate(
    query: QueryParts,
    value: string | null | undefined,
    column: 'transaction_type' | 'category',
  ): void {
    if (value === null || value === undefined) {
      return;
    }
    query.values.push(value);
    query.predicates.push(`${column} = $${query.values.length}`);
  }

  private addMerchantPredicate(
    query: QueryParts,
    merchantQuery: string | null,
  ): void {
    if (merchantQuery === null) {
      return;
    }
    query.values.push(merchantQuery);
    query.predicates.push(
      `COALESCE(merchant_normalized, merchant, '') ILIKE '%' || $${query.values.length} || '%'`,
    );
  }

  private addDatePredicates(
    query: QueryParts,
    filter: CategoryFilter | WebTransactionsFilter,
  ): void {
    if (filter.startDate !== null) {
      query.values.push(filter.startDate, filter.timezone);
      query.predicates.push(
        `transaction_date >= ($${query.values.length - 1}::date AT TIME ZONE $${query.values.length})`,
      );
    }
    if (filter.endDate !== null) {
      query.values.push(filter.endDate, filter.timezone);
      query.predicates.push(
        `transaction_date < ($${query.values.length - 1}::date AT TIME ZONE $${query.values.length})`,
      );
    }
  }

  private addCursor(query: QueryParts, filter: WebTransactionsFilter): void {
    if (filter.cursor === null) {
      return;
    }
    query.values.push(filter.cursor.transactionDate, filter.cursor.id);
    const comparison = filter.direction === 'previous' ? '>' : '<';
    query.predicates.push(
      `(transaction_date, id) ${comparison} ($${query.values.length - 1}::timestamptz, $${query.values.length}::bigint)`,
    );
  }

  private transaction(row: TransactionRow): WebTransactionRow {
    return {
      id: String(row.id),
      amount: Number(row.amount),
      merchant: row.merchant,
      category: row.category,
      transactionType: row.transaction_type,
      source: row.source,
      transactionDate: row.transaction_date,
      updatedAt: row.updated_at,
      creditCard: row.credit_card,
    };
  }

  private cycleStartDay(value: string | number | null): number {
    const day = Number(value ?? 1);
    return Number.isFinite(day)
      ? Math.min(Math.max(Math.trunc(day), 1), 31)
      : 1;
  }
}
