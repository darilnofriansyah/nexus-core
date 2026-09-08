import * as assert from "node:assert/strict";
import { test } from "node:test";
import { BadRequestException } from "@nestjs/common";
import { CreatorController } from "./creator.controller";
import { CreatorService } from "./creator.service";

test("returns the API envelope and normalized request", async () => {
  const calls: unknown[] = [];
  const service = { handleTelegram: async (request: unknown) => { calls.push(request); return { text: "hello" }; } };
  const result = await new CreatorController(service as unknown as CreatorService).handleTelegram({ telegramUserId: "1", chatId: "1", messageText: "/start" });
  assert.deepEqual(result, { ok: true, data: { text: "hello" } });
  assert.deepEqual(calls, [{ telegramUserId: "1", chatId: "1", messageText: "/start" }]);
});

test("rejects malformed input before calling service", async () => {
  let called = false;
  const service = { handleTelegram: async () => { called = true; return { text: "no" }; } };
  const controller = new CreatorController(service as unknown as CreatorService);
  await assert.rejects(() => controller.handleTelegram({ telegramUserId: "1", chatId: "1" }), BadRequestException);
  assert.equal(called, false);
});
