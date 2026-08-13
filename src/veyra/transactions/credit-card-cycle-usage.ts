import { BadRequestException } from "@nestjs/common";

export interface ApplyCreditCardCycleUsageDeltaInput {
  userId: string;
  transactionDate: string | Date | null | undefined;
  delta: number;
  query: (text: string, values?: unknown[]) => Promise<unknown>;
}

const CREDIT_CARD_CYCLE_USAGE_UPSERT = `
  WITH user_cycle AS (
    SELECT
      COALESCE(NULLIF(timezone, ''), 'Asia/Jakarta') AS timezone,
      GREATEST(1, LEAST(COALESCE(cycle_start_day, 1), 31)) AS cycle_day
    FROM telegram_users
    WHERE id = $1
  ),
  local_transaction AS (
    SELECT
      ($2::timestamptz AT TIME ZONE timezone)::date AS transaction_day,
      cycle_day
    FROM user_cycle
  ),
  cycle_month AS (
    SELECT
      cycle_day,
      CASE
        WHEN EXTRACT(DAY FROM transaction_day)::int >= LEAST(
          cycle_day,
          EXTRACT(DAY FROM (
            date_trunc('month', transaction_day) + interval '1 month - 1 day'
          ))::int
        )
        THEN date_trunc('month', transaction_day)::date
        ELSE (date_trunc('month', transaction_day) - interval '1 month')::date
      END AS month_start
    FROM local_transaction
  ),
  cycle AS (
    SELECT (
      month_start + (
        LEAST(
          cycle_day,
          EXTRACT(DAY FROM (
            month_start + interval '1 month - 1 day'
          ))::int
        ) - 1
      )
    )::date AS cycle_start
    FROM cycle_month
  )
  INSERT INTO credit_card_cycle_summaries (
    user_id,
    cycle_start,
    credit_limit,
    credit_used,
    statement_balance
  )
  SELECT $1, cycle_start, 0, $3, 0
  FROM cycle
  ON CONFLICT (user_id, cycle_start) DO UPDATE
  SET credit_used = GREATEST(
    0,
    credit_card_cycle_summaries.credit_used + $4
  )
`;

export async function applyCreditCardCycleUsageDelta({
  userId,
  transactionDate,
  delta,
  query,
}: ApplyCreditCardCycleUsageDeltaInput): Promise<void> {
  if (!Number.isSafeInteger(delta)) {
    throw new BadRequestException("credit-card delta must be a safe integer");
  }

  await query(CREDIT_CARD_CYCLE_USAGE_UPSERT, [
    userId,
    transactionDate,
    Math.max(delta, 0),
    delta,
  ]);
}
