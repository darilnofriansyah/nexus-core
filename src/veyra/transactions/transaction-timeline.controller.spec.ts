import * as assert from "node:assert/strict";
import { test } from "node:test";
import { BadRequestException } from "@nestjs/common";
import { HTTP_CODE_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { WebTransactionsController } from "./web-transactions.controller";
import { TransactionTimelineService } from "./transaction-timeline.service";
import { TransactionTimelineRepository } from "./transaction-timeline.repository";
import { WebTransactionsRepository } from "./web-transactions.repository";
import { WebTransactionsService } from "./web-transactions.service";

test("timeline exposes its distinct route with HTTP 200 without replacing legacy query", () => {
  const method = (
    WebTransactionsController.prototype as unknown as Record<string, unknown>
  ).timeline;
  assert.equal(typeof method, "function");
  assert.equal(
    Reflect.getMetadata(PATH_METADATA, method as object),
    "timeline/query",
  );
  assert.equal(Reflect.getMetadata(HTTP_CODE_METADATA, method as object), 200);
  assert.equal(
    Reflect.getMetadata(
      PATH_METADATA,
      WebTransactionsController.prototype.query,
    ),
    "query",
  );
});

test("timeline controller applies real request validation before querying persistence", async () => {
  const repository = {
    findEntries: async () => [],
    findCategories: async () => ["Shopping"],
  };
  const users = {
    findActiveUserByTelegramId: async () => ({
      id: "1",
      telegramUserId: "42",
      cycleStartDay: 1,
    }),
  };
  const timeline = new TransactionTimelineService(
    repository as unknown as TransactionTimelineRepository,
    users as unknown as WebTransactionsRepository,
  );
  const controller = new WebTransactionsController(
    {} as WebTransactionsService,
    timeline,
  );
  await assert.rejects(
    () => controller.timeline({ telegramUserId: "42", month: "2026-13" }),
    BadRequestException,
  );
  assert.deepEqual(
    await controller.timeline({ telegramUserId: "42", month: "2026-10" }),
    {
      items: [],
      categories: ["Shopping"],
      nextCursor: null,
      previousCursor: null,
    },
  );
});
