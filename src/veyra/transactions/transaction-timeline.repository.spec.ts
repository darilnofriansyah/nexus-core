import * as assert from "node:assert/strict";
import { test } from "node:test";
import { InternalServerErrorException } from "@nestjs/common";
import { DatabaseService } from "../../database/database.service";
import { TimelineFilter } from "./dto/transaction-timeline.dto";
import { TransactionTimelineRepository } from "./transaction-timeline.repository";

const at = "2026-10-17T17:00:00.000001Z";
const filter: TimelineFilter = {
  cursor: null,
  direction: "next",
  limit: 50,
  type: null,
  category: null,
  merchantQuery: null,
  cycle: null,
  asOfDate: "2026-09-18",
  startDate: null,
  endDate: null,
  timezone: "Asia/Jakarta",
};
const ordinary = {
  row_id: "9007199254740993",
  kind_rank: 0,
  sort_at_text: at,
  amount: "100.00",
  merchant: "\tShop\n",
  category: " Shopping ",
  pocket_id: null,
  pocket_name: null,
  transaction_type: "expense",
  source: "email",
  updated_at_text: at,
  credit_card: true,
  has_installment_plan: true,
};
const schedule = {
  row_id: "2",
  kind_rank: 1,
  sort_at_text: at,
  plan_id: "3",
  original_transaction_id: "4",
  sequence: 1,
  tenor_months: 2,
  due_date_text: "2026-10-18",
  merchant: "\tShop\n",
  category: "\nShopping\t",
  pocket_id: "9",
  principal: "100",
  interest: "5",
  posted_amount: null,
  due: false,
  interest_linked: false,
};

function fixture(rows: object[] = []) {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const database = {
    query: async (sql: string, values: unknown[]) => {
      calls.push({ sql, values });
      return { rows };
    },
  };
  return {
    calls,
    repository: new TransactionTimelineRepository(
      database as unknown as DatabaseService,
    ),
  };
}

test("timeline SQL scopes both union branches and bound filters before one tuple pagination", async () => {
  const f = fixture();
  const unsafe = "x' OR TRUE --";
  await f.repository.findEntries("7", {
    ...filter,
    type: "expense",
    category: unsafe,
    merchantQuery: unsafe,
    startDate: "2026-10-01",
    endDate: "2026-11-01",
    direction: "previous",
    cursor: { v: 1, at, kind: 1, id: "9223372036854775807" },
    limit: 2,
  });
  const { sql, values } = f.calls[0];
  assert.match(sql, /UNION ALL/i);
  assert.match(sql, /t\.user_id = \$1::bigint/);
  assert.match(sql, /original\.user_id = \$1::bigint/);
  assert.match(sql, /charge\.user_id = original\.user_id/);
  assert.match(sql, /pocket\.user_id = t\.user_id/);
  assert.match(sql, /NOT EXISTS[\s\S]+interest_transaction_id = t\.id/);
  assert.match(
    sql,
    /\(sort_at, kind_rank, row_id\) > \(\$\d+::timestamptz, \$\d+::integer, \$\d+::bigint\)/,
  );
  assert.match(sql, /ORDER BY sort_at ASC, kind_rank ASC, row_id ASC/);
  assert.equal(sql.includes(unsafe), false);
  assert.ok(values.includes(unsafe));
  assert.ok(values.includes(at));
  assert.ok(values.includes("9223372036854775807"));
  assert.equal(values.at(-1), 3);
});

test("timeline repository keeps microseconds and original flags, sanitizes legacy public metadata", async () => {
  const f = fixture([
    ordinary,
    {
      ...ordinary,
      row_id: "5",
      transaction_type: "income",
      merchant: " ",
      category: null,
    },
  ]);
  const rows = await f.repository.findEntries("7", filter);
  assert.equal(rows[0].sortAt, at);
  assert.equal(rows[0].rowId, "9007199254740993");
  const entry = rows[0].entry;
  assert.equal(entry.kind, "transaction");
  if (entry.kind !== "transaction") assert.fail();
  assert.equal(entry.transaction.transactionDate, at);
  assert.equal(entry.transaction.merchant, "Shop");
  assert.equal(entry.transaction.category, "Shopping");
  assert.equal(entry.hasInstallmentPlan, true);
  assert.equal(entry.budgetAmount, 100);
  assert.equal(rows[1].entry.budgetAmount, 0);
  if (rows[1].entry.kind !== "transaction") assert.fail();
  assert.equal(rows[1].entry.transaction.merchant, null);
});

test("timeline schedule distinguishes due, pending, posted and projected interest without principal spending", async () => {
  const variants = [
    schedule,
    { ...schedule, due: true },
    { ...schedule, due: true, interest_linked: true, posted_amount: "5.00" },
    { ...schedule, due: true, interest: "0" },
    { ...schedule, interest_linked: true, posted_amount: "5.00" },
  ];
  const f = fixture(variants);
  const rows = await f.repository.findEntries("7", filter);
  assert.deepEqual(
    rows.map(
      ({ entry }) =>
        entry.kind === "installment" && [
          entry.state,
          entry.budgetAmount,
          entry.scheduledBudgetAmount,
          entry.interestPostingPending,
        ],
    ),
    [
      ["scheduled", 0, 5, false],
      ["due", 0, 5, true],
      ["due", 5, 5, false],
      ["due", 0, 0, false],
      ["scheduled", 0, 5, false],
    ],
  );
  assert.deepEqual(rows[0].entry, {
    kind: "installment",
    entryId: "installment:2",
    planId: "3",
    originalTransactionId: "4",
    sequence: 1,
    tenorMonths: 2,
    dueDate: "2026-10-18",
    merchant: "Shop",
    category: "Shopping",
    pocketId: "9",
    principal: 100,
    interest: 5,
    total: 105,
    budgetAmount: 0,
    scheduledBudgetAmount: 5,
    state: "scheduled",
    interestPostingPending: false,
  });
});

test("timeline categories use both branches and other filters without page/category restrictions", async () => {
  const f = fixture([{ category: "Shopping" }]);
  const { cursor, direction, limit, category, ...categoryFilter } = filter;
  assert.deepEqual(
    await f.repository.findCategories("7", {
      ...categoryFilter,
      type: "income",
      merchantQuery: "shop",
    }),
    ["Shopping"],
  );
  const { sql, values } = f.calls[0];
  assert.match(sql, /UNION ALL/);
  assert.match(sql, /GROUP BY category/);
  assert.equal(sql.includes("LIMIT"), false);
  assert.ok(values.includes("income"));
  assert.ok(values.includes("shop"));
});

test("timeline default horizon and due state use real time and stored timezone, never asOfDate", async () => {
  const f = fixture();
  await f.repository.findEntries("7", { ...filter, asOfDate: "2090-12-31" });
  const { sql, values } = f.calls[0];
  assert.match(sql, /CURRENT_TIMESTAMP AT TIME ZONE plan\.timezone/);
  assert.match(sql, /CURRENT_TIMESTAMP AT TIME ZONE/);
  assert.equal(values.includes("2090-12-31"), false);
});

test("timeline rejects corrupt persisted schedule values instead of publishing unsafe values", async () => {
  for (const changed of [
    { principal: "100.5" },
    { interest: "-1" },
    { interest: "9007199254740992" },
    { plan_id: "0" },
    { row_id: "0" },
    { kind_rank: 2 },
    { due_date_text: "2026-02-30" },
    { sequence: 0 },
    { tenor_months: 121 },
    { merchant: " " },
    { category: "x".repeat(201) },
    { due: "true" },
    { interest_linked: null },
    { sort_at_text: "invalid" },
  ]) {
    const f = fixture([{ ...schedule, ...changed }]);
    await assert.rejects(
      () => f.repository.findEntries("7", filter),
      InternalServerErrorException,
    );
  }
});
