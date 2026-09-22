import * as assert from "node:assert/strict";
import { test } from "node:test";

import { calculateInstallmentSchedule } from "./installment-schedule";

test("installment schedule: flat rate preserves principal and total interest", () => {
  const result = calculateInstallmentSchedule(6_000_000, {
    tenorMonths: 6,
    monthlyRatePercent: "1",
    firstDueDate: "2026-09-30",
  });

  assert.equal(result.totalInterest, 360_000);
  assert.equal(result.totalPayable, 6_360_000);
  assert.equal(result.items.length, 6);
  assert.deepEqual(result.items[0], {
    sequence: 1,
    dueDate: "2026-09-30",
    principal: 1_000_000,
    interest: 60_000,
    total: 1_060_000,
  });
  assert.equal(
    result.items.reduce((sum, row) => sum + row.principal, 0),
    6_000_000,
  );
});

test("installment schedule: puts principal and rounded interest remainders in the final row", () => {
  const principalOnly = calculateInstallmentSchedule(100, {
    tenorMonths: 3,
    monthlyRatePercent: "0",
    firstDueDate: "2026-01-31",
  });
  const roundedInterest = calculateInstallmentSchedule(101, {
    tenorMonths: 3,
    monthlyRatePercent: "0.5",
    firstDueDate: "2026-01-31",
  });

  assert.deepEqual(
    principalOnly.items.map(({ principal, interest }) => ({ principal, interest })),
    [
      { principal: 33, interest: 0 },
      { principal: 33, interest: 0 },
      { principal: 34, interest: 0 },
    ],
  );
  assert.equal(roundedInterest.totalInterest, 2);
  assert.deepEqual(
    roundedInterest.items.map(({ interest }) => interest),
    [0, 0, 2],
  );
});

test("installment schedule: clamps each month independently to its month end", () => {
  assert.deepEqual(
    calculateInstallmentSchedule(3, {
      tenorMonths: 3,
      monthlyRatePercent: "0",
      firstDueDate: "2024-01-31",
    }).items.map(({ dueDate }) => dueDate),
    ["2024-01-31", "2024-02-29", "2024-03-31"],
  );
  assert.deepEqual(
    calculateInstallmentSchedule(3, {
      tenorMonths: 3,
      monthlyRatePercent: "0",
      firstDueDate: "2025-01-31",
    }).items.map(({ dueDate }) => dueDate),
    ["2025-01-31", "2025-02-28", "2025-03-31"],
  );
});

test("installment schedule: rejects malformed terms and unsafe totals", () => {
  for (const terms of [
    { tenorMonths: 0, monthlyRatePercent: "0", firstDueDate: "2026-01-01" },
    { tenorMonths: 121, monthlyRatePercent: "0", firstDueDate: "2026-01-01" },
    { tenorMonths: 3, monthlyRatePercent: "1.00001", firstDueDate: "2026-01-01" },
    { tenorMonths: 3, monthlyRatePercent: "1e2", firstDueDate: "2026-01-01" },
    { tenorMonths: 3, monthlyRatePercent: "-1", firstDueDate: "2026-01-01" },
    { tenorMonths: 3, monthlyRatePercent: "0", firstDueDate: "2026-02-29" },
  ]) {
    assert.throws(() => calculateInstallmentSchedule(100, terms));
  }
  assert.throws(() =>
    calculateInstallmentSchedule(10_000_000_000_000, {
      tenorMonths: 1,
      monthlyRatePercent: "0",
      firstDueDate: "2026-01-01",
    }),
  );
});
