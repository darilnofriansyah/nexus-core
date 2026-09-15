import * as assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseService } from "../../database/database.service";
import { CategoryService } from "../categories/category.service";
import { BudgetRepository } from "./budget.repository";
import { BudgetService } from "./budget.service";

function pocketWarning() {
  const delivered = new Set<string>();
  const writes: unknown[][] = [];
  const transaction = {
    id: "123", user_id: "1", pocket_id: "42" as string | null,
    category: "Shopping", status: "confirmed", transaction_type: "expense",
    transaction_date: "2026-09-13T12:00:00.000Z", timezone: "Asia/Jakarta",
  };
  const pocket = {
    budget_id: "42", category: "Monthly Allowance", parent_budget_id: null,
    budget_amount: "1500000", spent_amount: "7089338",
    category_breakdown: [
      { category: "Food", spent_amount: "651000" },
      { category: "Shopping", spent_amount: "6438338" },
    ],
  };
  const database = {
    query: async (sql: string, values: unknown[] = []) => {
      if (sql.includes("INSERT INTO budget_alerts")) {
        writes.push(values);
        delivered.add(JSON.stringify([values[1], values[2], values[4]]));
        return { rows: [{ budget_id: values[1], alert_type: values[2], threshold_percent: values[3], period_key: values[4] }] };
      }
      if (sql.includes("SELECT EXISTS")) {
        return { rows: [{ exists: delivered.has(JSON.stringify(values.slice(1))) }] };
      }
      if (sql.includes("FROM transactions")) return { rows: [transaction] };
      if (sql.includes("cycle_start_day")) return { rows: [{ cycle_start_day: 25 }] };
      throw new Error(`Unexpected query: ${sql}`);
    },
  } as unknown as DatabaseService;
  const repository = {
    findPocketStatus: async () => pocket,
    resolveLegacyPocketId: async () => "42",
  } as unknown as BudgetRepository;
  const service = new BudgetService(database, {} as CategoryService, repository);
  return { service, transaction, pocket, writes, delivered };
}

test("over-budget pocket retries until delivery and warns again only on a new spending day", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-09-13T12:00:00Z") });
  const { service, transaction, writes } = pocketWarning();
  const evaluate = () => service.evaluateTransaction({ userId: "1", transactionId: "123" });
  const first = await evaluate();
  assert.equal(first.alerts.length, 1);
  assert.equal(first.alerts[0].type, "budget_over_100_daily");
  assert.equal(first.alerts[0].alertRecord?.periodKey, "2026-09-13");
  assert.equal(first.alerts[0].budgetId, "42");
  assert.deepEqual(writes, [], "checking must not mark an unsent alert delivered");
  assert.deepEqual((await evaluate()).alerts, first.alerts, "failed sends remain retryable");

  await service.recordOverspendingAlert(first.alerts[0].alertRecord!);
  assert.equal((await evaluate()).hasAlert, false);
  transaction.id = "124";
  assert.equal((await evaluate()).hasAlert, false, "more same-day spending is suppressed");

  t.mock.timers.setTime(new Date("2026-09-13T17:01:00Z").getTime());
  assert.equal((await evaluate()).hasAlert, false, "replaying yesterday is not new spending");
  transaction.transaction_date = "2026-09-13T17:00:30Z";
  const tomorrow = await evaluate();
  assert.equal(tomorrow.alerts[0].alertRecord?.periodKey, "2026-09-14");
});

test("daily dedupe uses the stored user timezone and does not repeat a cycle's old threshold", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-09-13T17:30:00Z") });
  const { service, transaction, delivered } = pocketWarning();
  transaction.transaction_date = "2026-09-13T17:15:00Z";
  delivered.add(JSON.stringify(["42", "budget_100", "2026-08-25"]));
  const result = await service.evaluateTransaction({ userId: "1", transactionId: "123" });
  assert.equal(result.alerts[0].alertRecord?.periodKey, "2026-09-14");
  assert.equal(result.alerts[0].type, "budget_over_100_daily");
});

test("pocket status reports category spending without category budget limits", async () => {
  const { service } = pocketWarning();
  const result = await service.getBudgetStatus({ userId: "1", pocketId: "42", asOfDate: "2026-09-13" });
  assert.equal("child_breakdown" in result, false);
  assert.deepEqual((result as unknown as { category_breakdown: unknown }).category_breakdown, [
    { category: "Food", spent_amount: 651000 },
    { category: "Shopping", spent_amount: 6438338 },
  ]);
});

test("only the highest pocket threshold produces a delivery-ready warning", async () => {
  const { service, pocket, writes } = pocketWarning();
  pocket.spent_amount = "1425000";
  const result = await service.evaluateTransaction({ userId: "1", transactionId: "123" });
  assert.deepEqual(result.alerts.map(({ type }) => type), ["budget_90"]);
  assert.equal(result.alerts[0].alertRecord?.periodKey, "2026-08-25");
  assert.match(result.alerts[0].telegramText ?? "", /95%/);
  assert.deepEqual(writes, []);
});

test("legacy transaction category resolves a pocket, never a child limit", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-09-13T12:00:00Z") });
  const { service, transaction } = pocketWarning();
  transaction.pocket_id = null;
  transaction.category = "Food";
  const result = await service.evaluateTransaction({ userId: "1", transactionId: "123" });
  assert.deepEqual(result.alerts.map(({ budgetId }) => budgetId), ["42"]);
});

for (const state of ["pending", "rejected"]) {
  test(`${state} transactions do not trigger daily warnings`, async () => {
    const { service, transaction, writes } = pocketWarning();
    transaction.status = state;
    const result = await service.evaluateTransaction({ userId: "1", transactionId: "123" });
    assert.equal(result.hasAlert, false);
    assert.deepEqual(writes, []);
  });
}

test("explicit pocket expenses with no category still affect its warning", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-09-13T12:00:00Z") });
  const { service, transaction } = pocketWarning();
  transaction.category = "";
  assert.equal((await service.evaluateTransaction({ userId: "1", transactionId: "123" })).hasAlert, true);
});

test("legacy parentCategory writes are rejected instead of creating child budgets", async () => {
  const { service, writes } = pocketWarning();
  await assert.rejects(service.upsertBudget({ userId: "1", category: "Food", parentCategory: "Monthly Allowance", amount: 500000 }), /Child budgets are no longer supported/);
  assert.deepEqual(writes, []);
});
