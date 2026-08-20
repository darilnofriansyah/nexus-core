import * as assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const migration = readFileSync(
  join(process.cwd(), "docs/migration/2026-08-20-budget-categories-pockets-schema.sql"),
  "utf8",
);

test("budget pockets migration adds only additive ownership and assignment fields", () => {
  assert.match(migration, /ALTER TABLE public\.categories[\s\S]*user_id bigint NULL/);
  assert.match(migration, /is_active boolean NOT NULL DEFAULT true/);
  assert.match(migration, /categories_unique_user_name_ci/);
  assert.match(migration, /ALTER TABLE public\.budgets[\s\S]*is_default boolean NOT NULL DEFAULT false/);
  assert.match(migration, /budgets_unique_default_active_top_level_per_user/);
  assert.match(migration, /ALTER TABLE public\.transactions[\s\S]*pocket_id bigint NULL/);
  assert.match(migration, /ON DELETE SET NULL/);
  assert.match(migration, /'Uncategorized'/);
  assert.doesNotMatch(migration, /DELETE FROM|DROP TABLE|ALTER COLUMN category/);
});

test("pocket backfill assigns only unambiguous null expense rows", () => {
  const backfill = readFileSync(
    join(process.cwd(), "docs/migration/2026-08-20-budget-categories-pockets-backfill.sql"),
    "utf8",
  );
  assert.match(backfill, /t\.pocket_id IS NULL/);
  assert.match(backfill, /t\.transaction_type = 'expense'/);
  assert.equal((backfill.match(/count\(\*\) AS match_count/g) ?? []).length, 3);
  assert.match(backfill, /WHEN COALESCE\(child\.match_count, 0\) > 1 THEN NULL/);
  assert.match(backfill, /WHEN child\.match_count = 1 THEN child\.pocket_id/);
  assert.match(backfill, /WHEN COALESCE\(top_level\.match_count, 0\) > 1 THEN NULL/);
  assert.match(backfill, /WHEN top_level\.match_count = 1 THEN top_level\.pocket_id/);
  assert.match(backfill, /WHEN single_pocket\.match_count = 1 THEN single_pocket\.pocket_id/);
  assert.doesNotMatch(backfill, /DELETE FROM|SET category|SET status/);
});
