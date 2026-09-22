import * as assert from "node:assert/strict";
import { test } from "node:test";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import {
  TimelineFilter,
  TimelineQueryRequest,
  TimelineRow,
} from "./dto/transaction-timeline.dto";
import { TransactionTimelineRepository } from "./transaction-timeline.repository";
import { TransactionTimelineService } from "./transaction-timeline.service";
import { WebTransactionsRepository } from "./web-transactions.repository";

const at = "2026-10-17T17:00:00.000001Z";
const cursor = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");
const decode = (value: string | null) =>
  value ? JSON.parse(Buffer.from(value, "base64url").toString()) : null;

function row(id: string, kind: 0 | 1 = 0): TimelineRow {
  return {
    sortAt: at,
    kindRank: kind,
    rowId: id,
    entry:
      kind === 0
        ? {
            kind: "transaction",
            entryId: `transaction:${id}`,
            hasInstallmentPlan: true,
            budgetAmount: 100,
            transaction: {
              id,
              amount: 100,
              merchant: null,
              category: null,
              pocketId: null,
              pocketName: null,
              source: "manual",
              type: "expense",
              transactionDate: at,
              updatedAt: at,
              creditCard: false,
            },
          }
        : {
            kind: "installment",
            entryId: `installment:${id}`,
            planId: "1",
            originalTransactionId: "2",
            sequence: 1,
            tenorMonths: 2,
            dueDate: "2026-10-18",
            merchant: "Shop",
            category: "Shopping",
            pocketId: null,
            principal: 100,
            interest: 1,
            total: 101,
            budgetAmount: 0,
            scheduledBudgetAmount: 1,
            state: "scheduled",
            interestPostingPending: false,
          },
  };
}

function fixture() {
  const calls: Array<{ userId: string; filter: TimelineFilter }> = [];
  const categoryCalls: unknown[] = [];
  let rows: TimelineRow[] = [];
  let user: {
    id: string;
    telegramUserId: string;
    cycleStartDay: number;
  } | null = { id: "7", telegramUserId: "42", cycleStartDay: 31 };
  let lookups = 0;
  const repository = {
    findEntries: async (userId: string, filter: TimelineFilter) => {
      calls.push({ userId, filter });
      return rows;
    },
    findCategories: async (userId: string, filter: unknown) => {
      categoryCalls.push({ userId, filter });
      return [" Shopping ", "Shopping", "Income"];
    },
  };
  const users = {
    findActiveUserByTelegramId: async () => {
      lookups++;
      return user;
    },
  };
  return {
    service: new TransactionTimelineService(
      repository as unknown as TransactionTimelineRepository,
      users as unknown as WebTransactionsRepository,
    ),
    calls,
    categoryCalls,
    setRows: (value: TimelineRow[]) => {
      rows = value;
    },
    setUser: (value: typeof user) => {
      user = value;
    },
    lookups: () => lookups,
  };
}

test("timeline rejects invalid filters and nonexact cursors before user lookup", async () => {
  const f = fixture();
  const valid = { v: 1, at, kind: 0, id: "1" };
  const invalid: unknown[] = [
    null,
    [],
    {},
    { telegramUserId: "0" },
    { telegramUserId: "9223372036854775808" },
    { telegramUserId: "42", userId: "7" },
    { telegramUserId: "42", month: "2026-13" },
    { telegramUserId: "42", month: "0000-01" },
    { telegramUserId: "42", month: "2026-1" },
    { telegramUserId: "42", month: "2026-10", cycle: "current" },
    { telegramUserId: "42", asOfDate: "2026-02-30" },
    { telegramUserId: "42", asOfDate: 12 },
    { telegramUserId: "42", timezone: "Mars/Olympus" },
    { telegramUserId: "42", limit: 51 },
    { telegramUserId: "42", limit: 1.5 },
    { telegramUserId: "42", type: "transfer" },
    { telegramUserId: "42", cycle: "future" },
    { telegramUserId: "42", direction: "back" },
    { telegramUserId: "42", merchantQuery: "x".repeat(201) },
    { telegramUserId: "42", category: " " },
  ];
  for (const payload of [
    null,
    [],
    {},
    { ...valid, extra: 1 },
    { ...valid, v: 2 },
    { ...valid, kind: 2 },
    { ...valid, kind: "1" },
    { ...valid, id: 1 },
    { ...valid, id: "01" },
    { ...valid, id: "9223372036854775808" },
    { ...valid, at: "2026-10-17T17:00:00.001Z" },
    { ...valid, at: "2026-02-31T17:00:00.000001Z" },
  ]) {
    invalid.push({ telegramUserId: "42", cursor: cursor(payload) });
  }
  for (const value of ["", "x".repeat(513), `${cursor(valid)}=`, "_x"])
    invalid.push({ telegramUserId: "42", cursor: value });
  for (const request of invalid)
    await assert.rejects(
      () => f.service.query(request as TimelineQueryRequest),
      BadRequestException,
    );
  assert.equal(f.lookups(), 0);
});

test("timeline only queries rows for an active resolved internal user", async () => {
  const f = fixture();
  f.setUser(null);
  await assert.rejects(
    () => f.service.query({ telegramUserId: "42" }),
    NotFoundException,
  );
  assert.equal(f.calls.length, 0);
});

test("timeline derives calendar and clamped financial periods, preserving other category filters", async () => {
  const f = fixture();
  await f.service.query({
    telegramUserId: 42,
    month: "2027-12",
    category: " Shopping ",
    merchantQuery: " shop ",
    type: "expense",
  });
  await f.service.query({
    telegramUserId: "42",
    cycle: "current",
    asOfDate: "2026-03-01",
  });
  await f.service.query({
    telegramUserId: "42",
    cycle: "previous",
    asOfDate: "2026-03-01",
  });
  await f.service.query({ telegramUserId: "42", asOfDate: "2090-01-01" });
  assert.deepEqual(
    f.calls.map(({ userId, filter }) => [
      userId,
      filter.startDate,
      filter.endDate,
    ]),
    [
      ["7", "2027-12-01", "2028-01-01"],
      ["7", "2026-02-28", "2026-03-31"],
      ["7", "2026-01-31", "2026-02-28"],
      ["7", null, null],
    ],
  );
  assert.equal(f.calls[0].filter.category, "Shopping");
  assert.equal(f.calls[0].filter.merchantQuery, "shop");
  const categoryCall = f.categoryCalls[0] as {
    userId: string;
    filter: Record<string, unknown>;
  };
  assert.equal(categoryCall.userId, "7");
  assert.equal(categoryCall.filter.merchantQuery, "shop");
  assert.equal(categoryCall.filter.type, "expense");
  for (const key of ["category", "cursor", "direction", "limit"])
    assert.equal(key in categoryCall.filter, false);
});

test("timeline pages mixed equal timestamps losslessly and exposes whole-filter categories", async () => {
  const f = fixture();
  f.setRows([
    row("9223372036854775807", 1),
    row("9223372036854775806", 1),
    row("100", 0),
  ]);
  const first = await f.service.query({ telegramUserId: "42", limit: 2 });
  assert.deepEqual(
    first.items.map((item) => item.entryId),
    ["installment:9223372036854775807", "installment:9223372036854775806"],
  );
  assert.equal(first.previousCursor, null);
  assert.deepEqual(decode(first.nextCursor), {
    v: 1,
    at,
    kind: 1,
    id: "9223372036854775806",
  });
  assert.deepEqual(first.categories, ["Shopping", "Income"]);
  f.setRows([row("100"), row("99")]);
  const last = await f.service.query({
    telegramUserId: "42",
    limit: 2,
    cursor: first.nextCursor,
  });
  assert.equal(last.nextCursor, null);
  assert.deepEqual(decode(last.previousCursor), {
    v: 1,
    at,
    kind: 0,
    id: "100",
  });
  f.setRows([row("9223372036854775806", 1), row("9223372036854775807", 1)]);
  const back = await f.service.query({
    telegramUserId: "42",
    limit: 2,
    cursor: last.previousCursor,
    direction: "previous",
  });
  assert.deepEqual(back.items, first.items);
  assert.equal(back.previousCursor, null);
  assert.ok(back.nextCursor);
});

test("timeline previous query takes the nearest limit then reverses, including extra-row boundary", async () => {
  const f = fixture();
  f.setRows([row("101"), row("102"), row("103")]);
  const page = await f.service.query({
    telegramUserId: "42",
    limit: 2,
    direction: "previous",
    cursor: cursor({ v: 1, at, kind: 0, id: "100" }),
  });
  assert.deepEqual(
    page.items.map((item) => item.entryId),
    ["transaction:102", "transaction:101"],
  );
  assert.deepEqual(decode(page.previousCursor), {
    v: 1,
    at,
    kind: 0,
    id: "102",
  });
  assert.deepEqual(decode(page.nextCursor), { v: 1, at, kind: 0, id: "101" });
  f.setRows([]);
  const empty = await f.service.query({
    telegramUserId: "42",
    cursor: page.nextCursor,
  });
  assert.equal(empty.nextCursor, null);
  assert.equal(empty.previousCursor, null);
});

test("timeline previous without a cursor starts at the newest page", async () => {
  const f = fixture();
  f.setRows([row("102"), row("101")]);
  const page = await f.service.query({
    telegramUserId: "42",
    direction: "previous",
    limit: 1,
  });
  assert.equal(f.calls[0].filter.direction, "next");
  assert.equal(page.items[0].entryId, "transaction:102");
  assert.equal(page.previousCursor, null);
  assert.ok(page.nextCursor);
});
