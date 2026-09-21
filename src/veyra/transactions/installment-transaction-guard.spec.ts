import * as assert from "node:assert/strict";
import { ConflictException } from "@nestjs/common";
import { test } from "node:test";
import { assertInstallmentMutationAllowed } from "./installment-transaction-guard";

function queryWith(row: { is_purchase: boolean; is_interest: boolean }) {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  return {
    calls,
    query: async <T extends Record<string, unknown> = Record<string, unknown>>(
      text: string,
      values: unknown[] = [],
    ) => {
      calls.push({ text, values });
      return { rows: [row as unknown as T] };
    },
  };
}

test("installment transaction guard blocks material edits to planned purchases", async () => {
  const database = queryWith({ is_purchase: true, is_interest: false });

  await assert.rejects(
    () => assertInstallmentMutationAllowed(database, "123", ["amount"]),
    ConflictException,
  );
  assert.match(database.calls[0]?.text ?? "", /credit_card_installment_plans/);
  assert.match(database.calls[0]?.text ?? "", /credit_card_installments/);
  assert.deepEqual(database.calls[0]?.values, ["123"]);
});

test("installment transaction guard allows planned-purchase snapshot edits", async () => {
  const database = queryWith({ is_purchase: true, is_interest: false });

  await assert.doesNotReject(() =>
    assertInstallmentMutationAllowed(database, "123", ["merchant", "category"]),
  );
});

test("installment transaction guard blocks every linked-interest edit", async () => {
  const database = queryWith({ is_purchase: false, is_interest: true });

  await assert.rejects(
    () => assertInstallmentMutationAllowed(database, "123", ["notes"]),
    ConflictException,
  );
});
