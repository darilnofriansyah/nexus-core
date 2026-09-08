import * as assert from "node:assert/strict";
import { test } from "node:test";
import { BadRequestException } from "@nestjs/common";
import { normalizeCreatorTelegramRequest } from "./creator-validation";

test("requires exactly one message or callback", () => {
  assert.throws(
    () => normalizeCreatorTelegramRequest({ telegramUserId: "1", chatId: "1" }),
    (error) => error instanceof BadRequestException && /exactly one/.test(error.message),
  );
  assert.throws(() => normalizeCreatorTelegramRequest({ telegramUserId: "1", chatId: "1", messageText: "x", callbackToken: "rv:y" }), BadRequestException);
});

test("validates decimal Telegram identifiers", () => {
  assert.throws(() => normalizeCreatorTelegramRequest({ telegramUserId: "1.2", chatId: "1", messageText: "x" }), BadRequestException);
  assert.deepEqual(normalizeCreatorTelegramRequest({ telegramUserId: "976684739", chatId: "976684739", messageText: "/start" }), {
    telegramUserId: "976684739", chatId: "976684739", messageText: "/start",
  });
});

test("strips only the rv callback prefix", () => {
  assert.deepEqual(normalizeCreatorTelegramRequest({ telegramUserId: "1", chatId: "1", callbackToken: "rv:opaque" }), {
    telegramUserId: "1", chatId: "1", callbackToken: "opaque",
  });
  assert.throws(() => normalizeCreatorTelegramRequest({ telegramUserId: "1", chatId: "1", callbackToken: "opaque" }), BadRequestException);
  assert.throws(() => normalizeCreatorTelegramRequest({ telegramUserId: "1", chatId: "1", callbackToken: "rv:" }), BadRequestException);
  assert.throws(() => normalizeCreatorTelegramRequest({ telegramUserId: "1", chatId: "1", callbackToken: "rv:   " }), BadRequestException);
  assert.throws(() => normalizeCreatorTelegramRequest({ telegramUserId: "1", chatId: "1", callbackToken: "rv:ok\nno" }), BadRequestException);
});
