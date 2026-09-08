import * as assert from "node:assert/strict";
import { test } from "node:test";
import { CreatorService } from "./creator.service";

type Session = { step: string; data: Record<string, unknown> };
function createService(initial?: Session) {
  let session: Session | null = initial ?? null;
  const actions: Array<Record<string, unknown>> = [];
  const repository = {
    findSession: async () => session ? { ...session } : null,
    upsertSession: async (input: { step: string; data: Record<string, unknown> }) => { session = input; return input; },
    createAction: async (input: Record<string, unknown>) => { actions.push(input); return { ...input, token: "opaque-token" }; },
    consumeButtonAction: async (input: Record<string, unknown>) => ({ status: "consumed" as const, action: { kind: "CONFIRM_DRAFT" }, result: input.result }),
  };
  return { service: new CreatorService(repository as never), getSession: () => session, actions };
}

test("walks the free draft fields in order", async () => {
  const { service, getSession } = createService();
  assert.match((await service.handleTelegram({ telegramUserId: "976684739", chatId: "976684739", messageText: "/new" })).text, /title/i);
  for (const [messageText, step] of [["Koko", "NEW_DURATION"], ["30", "NEW_PREMISE"], ["A premise", "NEW_LEARNING_GOAL"], ["A lesson", "NEW_TONE"], ["warm", "NEW_CANON_CODES"], ["KOKO", "NEW_SHOT_DIRECTIONS"]] as const) {
    await service.handleTelegram({ telegramUserId: "976684739", chatId: "976684739", messageText });
    assert.equal(getSession()?.step, step);
  }
});

test("done without directions stays in direction collection", async () => {
  const { service, getSession, actions } = createService({ step: "NEW_SHOT_DIRECTIONS", data: { shotDirections: [] } });
  const reply = await service.handleTelegram({ telegramUserId: "976684739", chatId: "976684739", messageText: "done" });
  assert.equal(getSession()?.step, "NEW_SHOT_DIRECTIONS");
  assert.match(reply.text, /direction/i);
  assert.equal(actions.length, 0);
});

test("done with manual directions reaches ready and creates only a confirm action", async () => {
  const { service, getSession, actions } = createService({ step: "NEW_SHOT_DIRECTIONS", data: { shotDirections: ["camera follows Koko"] } });
  const reply = await service.handleTelegram({ telegramUserId: "976684739", chatId: "976684739", messageText: "done" });
  assert.equal(getSession()?.step, "DRAFT_READY");
  assert.equal(actions.length, 1);
  assert.equal(actions[0].kind, "CONFIRM_DRAFT");
  assert.match(reply.text, /confirm/i);
  assert.deepEqual(reply.inlineKeyboard, [[{ text: "Confirm draft", callbackData: "rv:opaque-token" }]]);
});

test("draft messages create no provider or domain work", async () => {
  const { service, actions } = createService({ step: "NEW_SHOT_DIRECTIONS", data: { shotDirections: [] } });
  await service.handleTelegram({ telegramUserId: "976684739", chatId: "976684739", messageText: "manual shot" });
  assert.equal(actions.length, 0);
});

test("consumes confirm callback and returns safe next-step text", async () => {
  const { service } = createService();
  const reply = await service.handleTelegram({ telegramUserId: "976684739", chatId: "976684739", callbackToken: "opaque-token" });
  assert.match(reply.text, /confirmation processing comes next/i);
});

test("handles the start-menu New episode callback as the new command", async () => {
  const { service, getSession, actions } = createService();
  const reply = await service.handleTelegram({ telegramUserId: "976684739", chatId: "976684739", callbackToken: "new" });
  assert.match(reply.text, /title/i);
  assert.equal(getSession()?.step, "NEW_TITLE");
  assert.equal(actions.length, 0);
});

test("handles deferred start-menu callbacks without opaque action lookup", async () => {
  const { service, actions } = createService();
  for (const token of ["canon", "mywork", "audio"]) {
    const reply = await service.handleTelegram({ telegramUserId: "976684739", chatId: "976684739", callbackToken: token });
    assert.match(reply.text, /coming next/i);
  }
  assert.equal(actions.length, 0);
});

test("blank shot directions are not collected", async () => {
  const { service, getSession } = createService({ step: "NEW_SHOT_DIRECTIONS", data: { shotDirections: [] } });
  const reply = await service.handleTelegram({ telegramUserId: "976684739", chatId: "976684739", messageText: "   " });
  assert.match(reply.text, /direction/i);
  assert.deepEqual(getSession()?.data.shotDirections, []);
});
