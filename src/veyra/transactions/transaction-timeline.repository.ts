import { Injectable, InternalServerErrorException } from "@nestjs/common";
import { QueryResultRow } from "pg";
import { DatabaseService } from "../../database/database.service";
import {
  TimelineCategoryFilter,
  TimelineEntry,
  TimelineFilter,
  TimelineRow,
} from "./dto/transaction-timeline.dto";
import {
  WEB_TRANSACTION_MAX_TEXT_LENGTH,
  WebTransactionRow,
} from "./dto/web-transactions.dto";
import {
  isPositivePostgresBigint,
  isValidMicrosecondUtcTimestamp,
  toPublicIdrAmount,
  toPublicWebTransaction,
} from "./web-transaction-public-contract";

interface EntryRecord extends QueryResultRow {
  row_id: string;
  kind_rank: 0 | 1;
  sort_at_text: string;
  amount: string;
  merchant: string | null;
  category: string | null;
  pocket_id: string | null;
  pocket_name: string | null;
  transaction_type: WebTransactionRow["transactionType"];
  source: WebTransactionRow["source"];
  updated_at_text: string;
  credit_card: boolean;
  has_installment_plan: boolean;
  plan_id: string;
  original_transaction_id: string;
  sequence: number;
  tenor_months: number;
  due_date_text: string;
  principal: string;
  interest: string;
  posted_amount: string | null;
  due: boolean;
  interest_linked: boolean;
}

// Keep both kinds in one relation: every filter, category query and page sees the same entries.
const ENTRIES_SQL = `
  WITH entries AS (
    SELECT t.transaction_date AS sort_at, 0 AS kind_rank, t.id AS row_id,
      t.amount, t.merchant, NULLIF(regexp_replace(t.category, '^[[:space:]]+|[[:space:]]+$', '', 'g'), '') AS category,
      COALESCE(t.merchant_normalized, t.merchant, '') AS merchant_search,
      t.pocket_id,
      (SELECT pocket.category FROM budgets pocket WHERE pocket.id = t.pocket_id AND pocket.user_id = t.user_id) AS pocket_name,
      t.transaction_type, t.source, t.updated_at,
      t.source = 'email' AND t.transaction_type = 'expense'
        AND lower(trim(COALESCE(t.raw_payload -> 'parsed' ->> 'paymentType', ''))) = 'credit card' AS credit_card,
      EXISTS (SELECT 1 FROM credit_card_installment_plans plan WHERE plan.transaction_id = t.id) AS has_installment_plan,
      NULL::bigint AS plan_id, NULL::bigint AS original_transaction_id,
      NULL::integer AS sequence, NULL::integer AS tenor_months, NULL::date AS due_date,
      NULL::bigint AS principal, NULL::bigint AS interest, NULL::numeric AS posted_amount,
      NULL::boolean AS due, NULL::boolean AS interest_linked, NULL::text AS entry_timezone
    FROM transactions t
    WHERE t.user_id = $1::bigint AND t.status = 'confirmed' AND t.transaction_type IN ('income', 'expense')
      AND NOT EXISTS (
        SELECT 1 FROM credit_card_installments folded
        JOIN credit_card_installment_plans plan ON plan.id = folded.plan_id
        JOIN transactions original ON original.id = plan.transaction_id
        WHERE folded.interest_transaction_id = t.id AND original.user_id = t.user_id
      )
    UNION ALL
    SELECT schedule.due_date::timestamp AT TIME ZONE plan.timezone, 1, schedule.id,
      NULL::numeric, plan.merchant, NULLIF(regexp_replace(plan.category, '^[[:space:]]+|[[:space:]]+$', '', 'g'), ''),
      plan.merchant, plan.pocket_id, NULL::text, 'expense', NULL::text, NULL::timestamptz, false, false,
      plan.id, original.id, schedule.sequence, plan.tenor_months, schedule.due_date,
      schedule.principal, schedule.interest, charge.amount,
      schedule.due_date <= (CURRENT_TIMESTAMP AT TIME ZONE plan.timezone)::date,
      schedule.interest_transaction_id IS NOT NULL, plan.timezone
    FROM credit_card_installments schedule
    JOIN credit_card_installment_plans plan ON plan.id = schedule.plan_id
    JOIN transactions original ON original.id = plan.transaction_id
    LEFT JOIN transactions charge ON charge.id = schedule.interest_transaction_id
      AND charge.user_id = original.user_id AND charge.status = 'confirmed' AND charge.transaction_type = 'expense'
    WHERE original.user_id = $1::bigint
  )
`;

@Injectable()
export class TransactionTimelineRepository {
  constructor(private readonly database: DatabaseService) {}

  async findEntries(
    userId: string,
    filter: TimelineFilter,
  ): Promise<TimelineRow[]> {
    const { predicates, values } = this.filteredQuery(userId, filter);
    const previous = filter.direction === "previous";
    if (filter.cursor !== null) {
      values.push(filter.cursor.at, filter.cursor.kind, filter.cursor.id);
      predicates.push(
        `(sort_at, kind_rank, row_id) ${previous ? ">" : "<"} ($${values.length - 2}::timestamptz, $${values.length - 1}::integer, $${values.length}::bigint)`,
      );
    }
    values.push(filter.limit + 1);
    const order = previous ? "ASC" : "DESC";
    const result = await this.database.query<EntryRecord>(
      `
      ${ENTRIES_SQL}
      SELECT row_id, kind_rank, amount, merchant, category, pocket_id, pocket_name,
        transaction_type, source, credit_card, has_installment_plan,
        plan_id, original_transaction_id, sequence, tenor_months, principal, interest,
        posted_amount, due, interest_linked,
        to_char(sort_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS sort_at_text,
        to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at_text,
        to_char(due_date, 'YYYY-MM-DD') AS due_date_text
      FROM entries
      WHERE ${predicates.join(" AND ")}
      ORDER BY sort_at ${order}, kind_rank ${order}, row_id ${order}
      LIMIT $${values.length}
    `,
      values,
    );
    return result.rows.map((row) => this.row(row));
  }

  async findCategories(
    userId: string,
    filter: TimelineCategoryFilter,
  ): Promise<string[]> {
    const { predicates, values } = this.filteredQuery(userId, filter);
    const result = await this.database.query<{ category: string }>(
      `
      ${ENTRIES_SQL}
      SELECT category FROM entries
      WHERE ${predicates.join(" AND ")} AND category IS NOT NULL
      GROUP BY category ORDER BY category
    `,
      values,
    );
    return result.rows.map((row) => row.category);
  }

  private filteredQuery(
    userId: string,
    filter: TimelineFilter | TimelineCategoryFilter,
  ) {
    const values: unknown[] = [userId, filter.timezone];
    const predicates: string[] = ["TRUE"];
    if (filter.type !== null) {
      values.push(filter.type);
      predicates.push(`transaction_type = $${values.length}`);
    }
    if ("category" in filter && filter.category !== null) {
      values.push(filter.category);
      predicates.push(`category = $${values.length}`);
    }
    if (filter.merchantQuery !== null) {
      values.push(filter.merchantQuery);
      predicates.push(`merchant_search ILIKE '%' || $${values.length} || '%'`);
    }
    // Schedule bounds use its immutable local date, not the viewer's timezone.
    if (filter.startDate !== null) {
      values.push(filter.startDate);
      predicates.push(
        `sort_at >= ($${values.length}::date::timestamp AT TIME ZONE COALESCE(entry_timezone, $2))`,
      );
    }
    if (filter.endDate !== null) {
      values.push(filter.endDate);
      predicates.push(
        `sort_at < ($${values.length}::date::timestamp AT TIME ZONE COALESCE(entry_timezone, $2))`,
      );
    }
    if (filter.startDate === null && filter.endDate === null) {
      predicates.push(
        `sort_at < (((CURRENT_TIMESTAMP AT TIME ZONE COALESCE(entry_timezone, $2))::date + 1)::timestamp AT TIME ZONE COALESCE(entry_timezone, $2))`,
      );
    }
    return { predicates, values };
  }

  private row(row: EntryRecord): TimelineRow {
    if (
      !this.validId(row.row_id) ||
      !isValidMicrosecondUtcTimestamp(row.sort_at_text)
    )
      this.invalid();
    let entry: TimelineEntry;
    if (row.kind_rank === 0) {
      if (typeof row.has_installment_plan !== "boolean") this.invalid();
      const transaction = toPublicWebTransaction({
        id: row.row_id,
        amount: toPublicIdrAmount(row.amount),
        merchant: row.merchant,
        category: row.category,
        pocketId: row.pocket_id,
        pocketName: row.pocket_name,
        transactionType: row.transaction_type,
        source: row.source,
        transactionDate: row.sort_at_text,
        updatedAt: row.updated_at_text,
        creditCard: row.credit_card,
      });
      entry = {
        kind: "transaction",
        entryId: `transaction:${row.row_id}`,
        transaction,
        hasInstallmentPlan: row.has_installment_plan,
        budgetAmount: transaction.type === "expense" ? transaction.amount : 0,
      };
    } else if (row.kind_rank === 1) {
      if (
        !this.validId(row.plan_id) ||
        !this.validId(row.original_transaction_id) ||
        (row.pocket_id !== null && !this.validId(row.pocket_id)) ||
        !Number.isInteger(row.sequence) ||
        row.sequence < 1 ||
        row.sequence > row.tenor_months ||
        !Number.isInteger(row.tenor_months) ||
        row.tenor_months < 1 ||
        row.tenor_months > 120 ||
        !isValidMicrosecondUtcTimestamp(
          `${row.due_date_text}T00:00:00.000000Z`,
        ) ||
        typeof row.due !== "boolean" ||
        typeof row.interest_linked !== "boolean"
      )
        this.invalid();
      const principal = toPublicIdrAmount(row.principal);
      const interest =
        row.interest === "0" ? 0 : toPublicIdrAmount(row.interest);
      const total = toPublicIdrAmount(principal + interest);
      entry = {
        kind: "installment",
        entryId: `installment:${row.row_id}`,
        planId: row.plan_id,
        originalTransactionId: row.original_transaction_id,
        sequence: row.sequence,
        tenorMonths: row.tenor_months,
        dueDate: row.due_date_text,
        merchant: this.requiredText(row.merchant),
        category: this.requiredText(row.category),
        pocketId: row.pocket_id,
        principal,
        interest,
        total,
        budgetAmount:
          row.due && row.interest_linked && row.posted_amount !== null
            ? toPublicIdrAmount(row.posted_amount)
            : 0,
        scheduledBudgetAmount: interest,
        state: row.due ? "due" : "scheduled",
        interestPostingPending: row.due && interest > 0 && !row.interest_linked,
      };
    } else {
      return this.invalid();
    }
    return {
      sortAt: row.sort_at_text,
      kindRank: row.kind_rank,
      rowId: row.row_id,
      entry,
    };
  }

  private validId(value: unknown): value is string {
    return (
      typeof value === "string" &&
      value.length <= 19 &&
      isPositivePostgresBigint(value)
    );
  }

  private requiredText(value: unknown): string {
    if (
      typeof value !== "string" ||
      !value.trim() ||
      value.trim().length > WEB_TRANSACTION_MAX_TEXT_LENGTH
    )
      return this.invalid();
    return value.trim();
  }

  private invalid(): never {
    throw new InternalServerErrorException("Timeline data is invalid");
  }
}
