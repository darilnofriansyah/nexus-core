import { Injectable } from '@nestjs/common';
import { QueryResultRow } from 'pg';
import { DatabaseService } from '../../database/database.service';
import {
  InstallmentPlan,
  InstallmentSchedule,
  InstallmentTerms,
  ScheduleRow,
} from './dto/installments.dto';

const MAX_AMOUNT = 9_999_999_999_999;

export interface InstallmentActiveUser {
  id: string;
  timezone: string;
}

export interface InstallmentOriginal {
  id: string;
  amount: string | number;
  merchant: string | null;
  category: string | null;
  pocketId: string | null;
  transactionType: string;
  source: string;
  status: string;
  creditCard: boolean;
  localDate: string;
  updatedAt: string;
}

export interface CreateInstallmentInput {
  userId: string;
  transactionId: string;
  expectedUpdatedAt: string;
  timezone: string;
  terms: InstallmentTerms;
  rateUnits: bigint;
  buildSchedule: (original: InstallmentOriginal) => InstallmentSchedule;
}

export type CreateInstallmentResult =
  | { kind: 'created'; plan: InstallmentPlan }
  | { kind: 'existing'; plan: InstallmentPlan }
  | { kind: 'not_found' }
  | { kind: 'invalid' }
  | { kind: 'conflict' };

export interface DueInterestResult {
  postedCount: number;
  hasMore: boolean;
}

interface ActiveUserRow extends QueryResultRow {
  id: string | number;
  timezone: string;
}

interface OriginalRow extends QueryResultRow {
  id: string | number;
  amount: string | number;
  merchant: string | null;
  category: string | null;
  pocket_id: string | number | null;
  transaction_type: string;
  source: string;
  status: string;
  credit_card: boolean;
  local_date: string;
  updated_at: string;
}

interface ExistingTermsRow extends QueryResultRow {
  id: string | number;
  tenor_months: string | number;
  monthly_rate_units: string | number;
  first_due_date: string;
}

interface InsertedPlanRow extends QueryResultRow {
  id: string | number;
}

interface InsertedScheduleRow extends QueryResultRow {
  sequence: string | number;
  due_date: string;
  principal: string | number;
  interest: string | number;
}

interface StoredPlanRow extends QueryResultRow {
  id: string | number;
  transaction_id: string | number;
  principal: string | number;
  tenor_months: string | number;
  monthly_rate_units: string | number;
  first_due_date: string;
  timezone: string;
  original_updated_at: string;
  total_interest: string | number;
  items: unknown;
}

interface DueInterestRow extends QueryResultRow {
  installment_id: string | number;
  interest: string | number;
  due_date: string;
  sequence: string | number;
  tenor_months: string | number;
  timezone: string;
  merchant: string;
  category: string;
  pocket_id: string | number | null;
  user_id: string | number;
}

interface DueInterestMoreRow extends QueryResultRow {
  has_more: boolean;
}

type QueryClient = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: T[] }>;
};

@Injectable()
export class InstallmentsRepository {
  constructor(private readonly database: DatabaseService) {}

  async findActiveUserByTelegramId(
    telegramUserId: string,
  ): Promise<InstallmentActiveUser | null> {
    const result = await this.database.query<ActiveUserRow>(
      `
        SELECT id, COALESCE(NULLIF(trim(timezone), ''), 'Asia/Jakarta') AS timezone
        FROM telegram_users
        WHERE telegram_id = $1::bigint
          AND is_active IS TRUE
        LIMIT 1
      `,
      [telegramUserId],
    );
    const row = result.rows[0];
    return row ? { id: String(row.id), timezone: row.timezone } : null;
  }

  async findOriginal(
    userId: string,
    transactionId: string,
    timezone: string,
  ): Promise<InstallmentOriginal | null> {
    return this.original(this.database, userId, transactionId, timezone, false);
  }

  async create(input: CreateInstallmentInput): Promise<CreateInstallmentResult> {
    return this.database.withTransaction(async (client) => {
      const original = await this.original(
        client,
        input.userId,
        input.transactionId,
        input.timezone,
        true,
      );
      if (!original) return { kind: 'not_found' };

      const existing = await this.existingTerms(client, input.transactionId);
      if (existing) {
        if (!this.sameTerms(existing, input)) return { kind: 'conflict' };
        return { kind: 'existing', plan: await this.plan(client, existing.id) };
      }

      if (original.updatedAt !== input.expectedUpdatedAt) {
        return { kind: 'conflict' };
      }
      if (!this.validOriginal(original, input.terms.firstDueDate)) {
        return { kind: 'invalid' };
      }
      const schedule = input.buildSchedule(original);
      if (
        original.pocketId !== null &&
        !(await this.ownedPocket(client, input.userId, original.pocketId))
      ) {
        return { kind: 'invalid' };
      }

      const inserted = await client.query<InsertedPlanRow>(
        `
          INSERT INTO credit_card_installment_plans (
            transaction_id, principal, tenor_months, monthly_rate_units,
            first_due_date, timezone, merchant, category, pocket_id,
            original_updated_at
          )
          VALUES ($1::bigint, $2::bigint, $3, $4, $5::date, $6, $7, $8, $9::bigint, $10::timestamptz)
          RETURNING id
        `,
        [
          input.transactionId,
          this.principal(original.amount),
          input.terms.tenorMonths,
          input.rateUnits.toString(),
          input.terms.firstDueDate,
          input.timezone,
          original.merchant,
          original.category,
          original.pocketId,
          original.updatedAt,
        ],
      );
      const planId = String(inserted.rows[0]?.id);
      const rows = await client.query<InsertedScheduleRow>(
        `
          INSERT INTO credit_card_installments (
            plan_id, sequence, due_date, principal, interest
          )
          SELECT $1::bigint, sequence, due_date, principal, interest
          FROM unnest($2::integer[], $3::date[], $4::bigint[], $5::bigint[])
            AS schedule(sequence, due_date, principal, interest)
          RETURNING sequence, due_date::text, principal, interest
        `,
        [
          planId,
          schedule.items.map((item) => item.sequence),
          schedule.items.map((item) => item.dueDate),
          schedule.items.map((item) => item.principal),
          schedule.items.map((item) => item.interest),
        ],
      );

      return {
        kind: 'created',
        plan: this.createdPlan(planId, original, input, rows.rows),
      };
    });
  }

  async postDueInterest(now: Date): Promise<DueInterestResult> {
    return this.database.withTransaction(async (client) => {
      const due = await client.query<DueInterestRow>(
        `
          SELECT
            installment.id AS installment_id,
            installment.interest,
            installment.due_date::text,
            installment.sequence,
            plan.tenor_months,
            plan.timezone,
            plan.merchant,
            plan.category,
            plan.pocket_id,
            original.user_id
          FROM credit_card_installments installment
          JOIN credit_card_installment_plans plan ON plan.id = installment.plan_id
          JOIN transactions original ON original.id = plan.transaction_id
          WHERE installment.interest > 0
            AND installment.interest_transaction_id IS NULL
            AND installment.due_date <= ($1::timestamptz AT TIME ZONE plan.timezone)::date
          ORDER BY installment.due_date, installment.id
          LIMIT 100
          FOR UPDATE OF installment SKIP LOCKED
        `,
        [now.toISOString()],
      );

      for (const row of due.rows) {
        const linked = await client.query(
          `
            WITH interest_transaction AS (
              INSERT INTO transactions (
                user_id, transaction_type, amount, merchant, category,
                transaction_date, source, notes, status, pocket_id
              )
              VALUES (
                $2::bigint, 'expense', $3::bigint, $4, $5,
                $8::date::timestamp AT TIME ZONE $9,
                'manual', $7, 'confirmed', $6::bigint
              )
              RETURNING id
            )
            UPDATE credit_card_installments installment
            SET interest_transaction_id = interest_transaction.id
            FROM interest_transaction
            WHERE installment.id = $1::bigint
              AND installment.interest_transaction_id IS NULL
            RETURNING installment.id
          `,
          [
            row.installment_id,
            row.user_id,
            row.interest,
            row.merchant,
            row.category,
            row.pocket_id,
            `Installment interest ${row.sequence}/${row.tenor_months}`,
            row.due_date,
            row.timezone,
          ],
        );
        if (linked.rows.length !== 1) {
          throw new Error('Installment interest could not be linked');
        }
      }

      const remaining = await client.query<DueInterestMoreRow>(
        `
          SELECT EXISTS (
            SELECT 1
            FROM credit_card_installments installment
            JOIN credit_card_installment_plans plan ON plan.id = installment.plan_id
            WHERE installment.interest > 0
              AND installment.interest_transaction_id IS NULL
              AND installment.due_date <= ($1::timestamptz AT TIME ZONE plan.timezone)::date
          ) AS has_more
        `,
        [now.toISOString()],
      );
      return {
        postedCount: due.rows.length,
        hasMore: remaining.rows[0]?.has_more ?? false,
      };
    });
  }

  private async original(
    client: QueryClient,
    userId: string,
    transactionId: string,
    timezone: string,
    lock: boolean,
  ): Promise<InstallmentOriginal | null> {
    const result = await client.query<OriginalRow>(
      `
        SELECT
          id, amount, merchant, category, pocket_id, transaction_type, source, status,
          source = 'email'
            AND lower(trim(COALESCE(raw_payload -> 'parsed' ->> 'paymentType', ''))) = 'credit card'
            AS credit_card,
          to_char(transaction_date AT TIME ZONE $3, 'YYYY-MM-DD') AS local_date,
          to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at
        FROM transactions
        WHERE id = $1::bigint
          AND user_id = $2::bigint
        ${lock ? 'FOR UPDATE' : ''}
      `,
      [transactionId, userId, timezone],
    );
    const row = result.rows[0];
    return row
      ? {
          id: String(row.id),
          amount: row.amount,
          merchant: row.merchant,
          category: row.category,
          pocketId: row.pocket_id === null ? null : String(row.pocket_id),
          transactionType: row.transaction_type,
          source: row.source,
          status: row.status,
          creditCard: row.credit_card,
          localDate: row.local_date,
          updatedAt: row.updated_at,
        }
      : null;
  }

  private async existingTerms(
    client: QueryClient,
    transactionId: string,
  ): Promise<ExistingTermsRow | null> {
    const result = await client.query<ExistingTermsRow>(
      `
        SELECT id, tenor_months, monthly_rate_units, first_due_date::text
        FROM credit_card_installment_plans
        WHERE transaction_id = $1::bigint
        LIMIT 1
      `,
      [transactionId],
    );
    return result.rows[0] ?? null;
  }

  private async ownedPocket(
    client: QueryClient,
    userId: string,
    pocketId: string,
  ): Promise<boolean> {
    const result = await client.query(
      `
        SELECT id
        FROM budgets
        WHERE id = $1::bigint
          AND user_id = $2::bigint
        LIMIT 1
      `,
      [pocketId, userId],
    );
    return result.rows.length > 0;
  }

  private async plan(client: QueryClient, planId: string | number): Promise<InstallmentPlan> {
    const result = await client.query<StoredPlanRow>(
      `
        SELECT
          plan.id, plan.transaction_id, plan.principal, plan.tenor_months,
          plan.monthly_rate_units, plan.first_due_date::text, plan.timezone,
          to_char(plan.original_updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS original_updated_at,
          COALESCE(SUM(installment.interest), 0) AS total_interest,
          COALESCE(
            json_agg(
              json_build_object(
                'sequence', installment.sequence,
                'dueDate', installment.due_date::text,
                'principal', installment.principal,
                'interest', installment.interest
              ) ORDER BY installment.sequence
            ) FILTER (WHERE installment.id IS NOT NULL),
            '[]'::json
          ) AS items
        FROM credit_card_installment_plans plan
        LEFT JOIN credit_card_installments installment ON installment.plan_id = plan.id
        WHERE plan.id = $1::bigint
        GROUP BY plan.id
      `,
      [String(planId)],
    );
    const row = result.rows[0];
    if (!row) throw new Error('Installment plan was not persisted');
    const items = this.scheduleItems(row.items);
    const principal = this.number(row.principal);
    const totalInterest = this.number(row.total_interest);
    return {
      planId: String(row.id),
      originalTransactionId: String(row.transaction_id),
      originalUpdatedAt: row.original_updated_at,
      principal,
      totalInterest,
      totalPayable: principal + totalInterest,
      timezone: row.timezone,
      terms: {
        tenorMonths: this.number(row.tenor_months),
        monthlyRatePercent: this.rate(BigInt(row.monthly_rate_units)),
        firstDueDate: row.first_due_date,
      },
      items,
    };
  }

  private createdPlan(
    planId: string,
    original: InstallmentOriginal,
    input: CreateInstallmentInput,
    rows: InsertedScheduleRow[],
  ): InstallmentPlan {
    const items = rows.map((row) => {
      const principal = this.number(row.principal);
      const interest = this.number(row.interest);
      return {
        sequence: this.number(row.sequence),
        dueDate: row.due_date,
        principal,
        interest,
        total: principal + interest,
      };
    });
    return {
      planId,
      originalTransactionId: original.id,
      originalUpdatedAt: original.updatedAt,
      principal: this.principal(original.amount),
      totalInterest: items.reduce((total, item) => total + item.interest, 0),
      totalPayable: items.reduce((total, item) => total + item.total, 0),
      timezone: input.timezone,
      terms: input.terms,
      items,
    };
  }

  private sameTerms(row: ExistingTermsRow, input: CreateInstallmentInput): boolean {
    return (
      this.number(row.tenor_months) === input.terms.tenorMonths &&
      BigInt(row.monthly_rate_units) === input.rateUnits &&
      row.first_due_date === input.terms.firstDueDate
    );
  }

  private validOriginal(original: InstallmentOriginal, firstDueDate: string): boolean {
    return (
      original.status === 'confirmed' &&
      original.transactionType === 'expense' &&
      original.source === 'email' &&
      original.creditCard &&
      this.validPrincipal(original.amount) !== null &&
      this.validText(original.merchant) &&
      this.validText(original.category) &&
      firstDueDate >= original.localDate
    );
  }

  private principal(value: string | number): number {
    const principal = this.validPrincipal(value);
    if (principal === null) throw new Error('Installment principal is invalid');
    return principal;
  }

  private validPrincipal(value: string | number): number | null {
    const source = String(value);
    const match = /^([1-9]\d*)(?:\.0+)?$/.exec(source);
    if (!match) return null;
    const amount = Number(match[1]);
    return Number.isSafeInteger(amount) && amount <= MAX_AMOUNT ? amount : null;
  }

  private validText(value: string | null): value is string {
    return typeof value === 'string' && value.trim().length > 0;
  }

  private scheduleItems(value: unknown): ScheduleRow[] {
    if (!Array.isArray(value)) throw new Error('Installment schedule is invalid');
    return value.map((item) => {
      if (typeof item !== 'object' || item === null) {
        throw new Error('Installment schedule is invalid');
      }
      const row = item as Record<string, unknown>;
      const principal = this.number(row.principal);
      const interest = this.number(row.interest);
      if (typeof row.dueDate !== 'string') throw new Error('Installment schedule is invalid');
      return {
        sequence: this.number(row.sequence),
        dueDate: row.dueDate,
        principal,
        interest,
        total: principal + interest,
      };
    });
  }

  private number(value: string | number | unknown): number {
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < 0 || number > MAX_AMOUNT) {
      throw new Error('Installment data is invalid');
    }
    return number;
  }

  private rate(units: bigint): string {
    const whole = units / 10_000n;
    const fraction = (units % 10_000n).toString().padStart(4, '0').replace(/0+$/, '');
    return fraction ? `${whole}.${fraction}` : whole.toString();
  }
}
