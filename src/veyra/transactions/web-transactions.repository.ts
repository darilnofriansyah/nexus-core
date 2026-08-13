import { Injectable } from '@nestjs/common';
import { PoolClient, QueryResultRow } from 'pg';
import { DatabaseService } from '../../database/database.service';
import { applyCreditCardCycleUsageDelta } from './credit-card-cycle-usage';
import {
  WebTransactionChanges,
  WebTransactionRow,
  WebTransactionUpdateResult,
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

interface LockedTransactionRow extends QueryResultRow {
  id: string | number;
  user_id: string | number;
  transaction_type: WebTransactionRow['transactionType'];
  amount: string | number;
  merchant: string | null;
  category: string | null;
  transaction_date: string | Date;
  source: WebTransactionRow['source'];
  status: string;
  updated_at: string;
  version_matches: boolean;
  raw_payload: unknown;
}

export interface UpdateWebTransactionInput {
  userId: string;
  transactionId: string;
  expectedUpdatedAt: string;
  changes: WebTransactionChanges;
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

  async updateTransaction({
    userId,
    transactionId,
    expectedUpdatedAt,
    changes,
  }: UpdateWebTransactionInput): Promise<WebTransactionUpdateResult> {
    return this.database.withTransaction(async (client) => {
      const lockedResult = await client.query<LockedTransactionRow>(
        `
          SELECT id, user_id, transaction_type, amount, merchant, category,
                 transaction_date, source, status,
                 to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at,
                 updated_at = $3::timestamptz AS version_matches,
                 raw_payload
          FROM transactions
          WHERE id = $1 AND user_id = $2
            AND status = 'confirmed'
            AND transaction_type IN ('income', 'expense')
          FOR UPDATE
        `,
        [transactionId, userId, expectedUpdatedAt],
      );
      const locked = lockedResult.rows[0];

      if (!locked) {
        return { kind: 'not_found' };
      }
      if (!locked.version_matches) {
        return { kind: 'conflict' };
      }

      const finalState = this.composeFinalState(locked, changes);
      if (
        locked.transaction_type === 'expense' &&
        (!this.hasText(finalState.merchant) || !this.hasText(finalState.category))
      ) {
        return {
          kind: 'invalid',
          message: 'expense merchant and category are required',
        };
      }
      if (!this.hasChanges(locked, changes)) {
        return { kind: 'no_change' };
      }

      const updated = await this.updateLockedTransaction(
        client,
        userId,
        transactionId,
        changes,
      );
      const oldAmount = Number(locked.amount);
      if (
        changes.amount !== undefined &&
        changes.amount !== oldAmount &&
        this.isEligibleCreditCardExpense(locked)
      ) {
        await applyCreditCardCycleUsageDelta({
          userId,
          transactionDate: locked.transaction_date,
          delta: changes.amount - oldAmount,
          query: client.query.bind(client),
        });
      }

      return { kind: 'updated', transaction: this.transaction(updated) };
    });
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

  private composeFinalState(
    locked: LockedTransactionRow,
    changes: WebTransactionChanges,
  ): { merchant: string | null; category: string | null } {
    return {
      merchant: this.supplied(changes, 'merchant')
        ? (changes.merchant ?? null)
        : locked.merchant,
      category: this.supplied(changes, 'category')
        ? (changes.category ?? null)
        : locked.category,
    };
  }

  private hasChanges(
    locked: LockedTransactionRow,
    changes: WebTransactionChanges,
  ): boolean {
    return (
      (this.supplied(changes, 'amount') &&
        changes.amount !== Number(locked.amount)) ||
      (this.supplied(changes, 'merchant') &&
        changes.merchant !== locked.merchant) ||
      (this.supplied(changes, 'category') &&
        changes.category !== locked.category)
    );
  }

  private async updateLockedTransaction(
    client: Pick<PoolClient, 'query'>,
    userId: string,
    transactionId: string,
    changes: WebTransactionChanges,
  ): Promise<TransactionRow> {
    const assignments: string[] = [];
    const values: unknown[] = [];
    this.addAssignment(assignments, values, changes, 'amount');
    this.addAssignment(assignments, values, changes, 'merchant');
    this.addAssignment(assignments, values, changes, 'category');
    values.push(transactionId, userId);
    const transactionIdParameter = values.length - 1;
    const userIdParameter = values.length;
    const result = await client.query<TransactionRow>(
      `
        UPDATE transactions
        SET ${assignments.join(', ')}, updated_at = now()
        WHERE id = $${transactionIdParameter}::bigint
          AND user_id = $${userIdParameter}::bigint
        RETURNING
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
      `,
      values,
    );
    const updated = result.rows[0];

    if (!updated) {
      throw new Error('locked transaction update returned no row');
    }
    return updated;
  }

  private addAssignment(
    assignments: string[],
    values: unknown[],
    changes: WebTransactionChanges,
    column: keyof WebTransactionChanges,
  ): void {
    if (!this.supplied(changes, column)) {
      return;
    }
    values.push(changes[column]);
    assignments.push(`${column} = $${values.length}`);
  }

  private supplied(
    changes: WebTransactionChanges,
    field: keyof WebTransactionChanges,
  ): boolean {
    return Object.prototype.hasOwnProperty.call(changes, field);
  }

  private hasText(value: string | null): value is string {
    return typeof value === 'string' && value.trim().length > 0;
  }

  private isEligibleCreditCardExpense(row: LockedTransactionRow): boolean {
    return (
      row.transaction_type === 'expense' &&
      row.source === 'email' &&
      this.paymentType(row.raw_payload) === 'credit card'
    );
  }

  private paymentType(rawPayload: unknown): string {
    if (!this.isRecord(rawPayload) || !this.isRecord(rawPayload.parsed)) {
      return '';
    }
    const paymentType = rawPayload.parsed.paymentType;
    return typeof paymentType === 'string'
      ? paymentType.trim().toLowerCase()
      : '';
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  private cycleStartDay(value: string | number | null): number {
    const day = Number(value ?? 1);
    return Number.isFinite(day)
      ? Math.min(Math.max(Math.trunc(day), 1), 31)
      : 1;
  }
}
