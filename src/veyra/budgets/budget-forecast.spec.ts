import * as assert from "node:assert/strict";
import { test } from "node:test";
import { calculateBudgetForecast } from "./budget-forecast";

test("projects cycle spend from the inclusive reference day", () => {
  assert.deepEqual(
    calculateBudgetForecast({
      spentAmount: 500_000,
      budgetAmount: 1_500_000,
      cycleStart: "2026-07-01",
      cycleEnd: "2026-08-01",
      asOfDate: "2026-07-10",
    }),
    {
      elapsedDays: 10,
      cycleDays: 31,
      remainingDays: 21,
      projectedSpend: 1_550_000,
      projectedOverrun: 50_000,
      remainingAmount: 1_000_000,
      safeDailySpend: 47_619,
    },
  );
});

test("uses one remaining day on the final cycle day", () => {
  assert.deepEqual(
    calculateBudgetForecast({
      spentAmount: 1_600_000,
      budgetAmount: 1_500_000,
      cycleStart: "2026-07-01",
      cycleEnd: "2026-08-01",
      asOfDate: "2026-07-31",
    }),
    {
      elapsedDays: 31,
      cycleDays: 31,
      remainingDays: 1,
      projectedSpend: 1_600_000,
      projectedOverrun: 100_000,
      remainingAmount: 0,
      safeDailySpend: 0,
    },
  );
});

test("rejects invalid ranges and non-positive budgets", () => {
  assert.equal(
    calculateBudgetForecast({
      spentAmount: 10,
      budgetAmount: 0,
      cycleStart: "2026-07-01",
      cycleEnd: "2026-08-01",
      asOfDate: "2026-07-10",
    }),
    null,
  );
  assert.equal(
    calculateBudgetForecast({
      spentAmount: 10,
      budgetAmount: 100,
      cycleStart: "2026-07-01",
      cycleEnd: "2026-08-01",
      asOfDate: "2026-08-01",
    }),
    null,
  );
});
