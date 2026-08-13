import * as assert from "node:assert/strict";
import { test } from "node:test";
import type {
  WebTransactionUpdateRequestDto,
  WebTransactionsQueryRequestDto,
} from "./web-transactions.dto";
import {
  WEB_TRANSACTION_MAX_CURSOR_LENGTH,
  WEB_TRANSACTION_MAX_TEXT_LENGTH,
} from "./web-transactions.dto";

test("web transaction DTOs represent only approved public fields", () => {
  const query: WebTransactionsQueryRequestDto = {
    telegramUserId: "976684739",
    cycle: "current",
    asOfDate: "2026-08-13",
    limit: 50,
  };
  const update: WebTransactionUpdateRequestDto = {
    telegramUserId: "976684739",
    amount: 30000,
    expectedUpdatedAt: "2026-08-13T03:01:00.123456Z",
  };

  assert.equal(query.cycle, "current");
  assert.equal(update.amount, 30000);
});

test("web transaction DTO limits match the public contract", () => {
  assert.equal(WEB_TRANSACTION_MAX_TEXT_LENGTH, 200);
  assert.equal(WEB_TRANSACTION_MAX_CURSOR_LENGTH, 512);
});
