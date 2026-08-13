import * as assert from "node:assert/strict";
import { test } from "node:test";
import { BadRequestException } from "@nestjs/common";
import { applyCreditCardCycleUsageDelta } from "./credit-card-cycle-usage";

test("credit-card cycle helper upserts a positive signed delta in the user financial cycle", async () => {
  const calls: Array<{ text: string; values?: unknown[] }> = [];

  await applyCreditCardCycleUsageDelta({
    userId: "1",
    transactionDate: "2026-08-13T03:00:00.000Z",
    delta: 25000,
    query: async (text, values) => {
      calls.push({ text, values });
      return {};
    },
  });

  assert.deepEqual(calls[0]?.values, [
    "1",
    "2026-08-13T03:00:00.000Z",
    25000,
    25000,
  ]);
  assert.match(calls[0]?.text ?? "", /ON CONFLICT \(user_id, cycle_start\)/);
});

test("credit-card cycle helper creates zero usage for a negative delta", async () => {
  const calls: Array<{ text: string; values?: unknown[] }> = [];

  await applyCreditCardCycleUsageDelta({
    userId: "1",
    transactionDate: "2026-08-13T03:00:00.000Z",
    delta: -25000,
    query: async (text, values) => {
      calls.push({ text, values });
      return {};
    },
  });

  assert.deepEqual(calls[0]?.values, [
    "1",
    "2026-08-13T03:00:00.000Z",
    0,
    -25000,
  ]);
  assert.match(calls[0]?.text ?? "", /GREATEST\(\s*0,/);
});

test("credit-card cycle helper rejects a non-safe-integer delta", async () => {
  await assert.rejects(
    () =>
      applyCreditCardCycleUsageDelta({
        userId: "1",
        transactionDate: "2026-08-13T03:00:00.000Z",
        delta: 1.5,
        query: async () => ({}),
      }),
    BadRequestException,
  );
});
