import * as assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

const migrationPath = join(
  process.cwd(),
  "docs/migration/2026-09-18-credit-card-installments.sql",
);

test("installment migration protects one immutable schedule per purchase", async () => {
  const migration = await readFile(migrationPath, "utf8");

  assert.match(migration, /transaction_id bigint NOT NULL UNIQUE REFERENCES public\.transactions\(id\) ON DELETE RESTRICT/);
  assert.match(migration, /UNIQUE \(plan_id, sequence\)/);
  assert.match(migration, /interest_transaction_id bigint UNIQUE REFERENCES public\.transactions\(id\) ON DELETE RESTRICT/);
  assert.match(migration, /principal bigint NOT NULL CHECK \(principal BETWEEN 1 AND 9999999999999\)/);
  assert.match(migration, /interest bigint NOT NULL CHECK \(interest BETWEEN 0 AND 9999999999999\)/);
});
