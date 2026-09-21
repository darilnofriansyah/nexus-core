import { ConflictException } from "@nestjs/common";
import { QueryResultRow } from "pg";

interface InstallmentLinkRow extends QueryResultRow {
  is_purchase: boolean;
  is_interest: boolean;
}

interface TransactionQuery {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: T[] }>;
}

const PURCHASE_MATERIAL_FIELDS = new Set([
  "amount",
  "transaction_date",
  "transaction_type",
  "status",
  "user_id",
  "delete",
]);

export async function assertInstallmentMutationAllowed(
  query: TransactionQuery,
  transactionId: string,
  changedFields: Iterable<string>,
): Promise<void> {
  const changes = new Set(changedFields);
  if (changes.size === 0) return;

  const result = await query.query<InstallmentLinkRow>(
    `
      SELECT EXISTS (
        SELECT 1 FROM credit_card_installment_plans WHERE transaction_id = $1::bigint
      ) AS is_purchase,
      EXISTS (
        SELECT 1 FROM credit_card_installments WHERE interest_transaction_id = $1::bigint
      ) AS is_interest
    `,
    [transactionId],
  );
  const links = result.rows[0];

  if (links?.is_interest) {
    throw new ConflictException(
      "Installment interest transactions cannot be edited.",
    );
  }
  if (
    links?.is_purchase &&
    [...changes].some((field) => PURCHASE_MATERIAL_FIELDS.has(field))
  ) {
    throw new ConflictException(
      "This purchase has an installment schedule and cannot be materially changed.",
    );
  }
}
