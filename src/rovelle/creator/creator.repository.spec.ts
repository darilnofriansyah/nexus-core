import * as assert from "node:assert/strict";
import { test } from "node:test";
import { PrismaService } from "../../database/prisma.service";
import type { RovelleCreatorAction, RovelleCreatorSession } from "../../generated/prisma/client";
import { CreatorRepository } from "./creator.repository";

const session: RovelleCreatorSession = {
  id: "550e8400-e29b-41d4-a716-446655440000",
  telegramUserId: "976684739",
  step: "IDLE",
  data: {},
  createdAt: new Date("2026-09-07T00:00:00.000Z"),
  updatedAt: new Date("2026-09-07T00:00:00.000Z"),
};

const action: RovelleCreatorAction = {
  id: "650e8400-e29b-41d4-a716-446655440000",
  token: "short-token",
  telegramUserId: "976684739",
  kind: "CONFIRM_DRAFT",
  payload: { episodeId: "episode" },
  expiresAt: new Date("2099-09-08T00:00:00.000Z"),
  consumedAt: null,
  result: null,
  createdAt: new Date("2026-09-07T00:00:00.000Z"),
  updatedAt: new Date("2026-09-07T00:00:00.000Z"),
};

function createRepository(options: {
  foundAction?: RovelleCreatorAction | null;
  foundActions?: Array<RovelleCreatorAction | null>;
  updateCount?: number;
  duplicateAction?: RovelleCreatorAction | null;
  transactionErrors?: unknown[];
  reviewActions?: RovelleCreatorAction[];
} = {}) {
  const calls: Array<{ operation: string; args: unknown }> = [];
  const foundActions = [...(options.foundActions ?? [])];
  const transactionErrors = [...(options.transactionErrors ?? [])];
  const findAction = async (args: unknown) => {
    calls.push({ operation: "action.findUnique", args });
    const token = (args as { where?: { token?: string } }).where?.token;
    if (token && options.reviewActions) return options.reviewActions.find((candidate) => candidate.token === token) ?? null;
    return foundActions.shift() ?? (options.foundAction === undefined ? action : options.foundAction);
  };
  const tx = {
    rovelleCreatorSession: {
      upsert: async (args: unknown) => {
        calls.push({ operation: "session.upsert", args });
        return session;
      },
    },
    rovelleCreatorAction: {
      findUnique: findAction,
      findMany: async (args: unknown) => {
        calls.push({ operation: "action.findMany", args });
        return options.reviewActions ?? [];
      },
      create: async (args: unknown) => {
        calls.push({ operation: "action.create", args });
        return action;
      },
      updateMany: async (args: unknown) => {
        calls.push({ operation: "action.updateMany", args });
        return { count: options.updateCount ?? 1 };
      },
      update: async (args: unknown) => {
        calls.push({ operation: "action.update", args });
        return options.duplicateAction ?? { ...action, consumedAt: new Date(), result: { text: "done" } };
      },
    },
  };
  const client = {
    rovelleCreatorSession: tx.rovelleCreatorSession,
    rovelleCreatorAction: tx.rovelleCreatorAction,
    $transaction: async <T>(callback: (value: typeof tx) => Promise<T>, options: unknown) => {
      calls.push({ operation: "transaction", args: options });
      const error = transactionErrors.shift();
      if (error) throw error;
      return callback(tx);
    },
  };
  return {
    calls,
    transaction: tx,
    repository: new CreatorRepository({ client } as unknown as PrismaService),
  };
}

test("upserts a Telegram-keyed creator session", async () => {
  const { calls, repository } = createRepository();
  assert.equal(await repository.upsertSession({ telegramUserId: "976684739", step: "IDLE", data: {} }), session);
  assert.deepEqual(calls[0], {
    operation: "session.upsert",
    args: {
      where: { telegramUserId: "976684739" },
      create: { telegramUserId: "976684739", step: "IDLE", data: {} },
      update: { step: "IDLE", data: {} },
    },
  });
});

test("returns a stored Telegram reply only when the update hash matches", async () => {
  const response = { text: "Saved reply", inlineKeyboard: [[{ text: "Continue", callbackData: "rv:next" }]] };
  const calls: unknown[] = [];
  const repository = new CreatorRepository({
    client: {
      rovelleTelegramReceipt: {
        findUnique: async (args: unknown) => {
          calls.push(args);
          return { requestHash: "a".repeat(64), response };
        },
      },
    },
  } as never);
  const key = { botId: "test-bot", updateId: "17", requestHash: "a".repeat(64) };

  assert.deepEqual(await repository.findTelegramReceipt(key), response);
  await assert.rejects(
    () => repository.findTelegramReceipt({ ...key, requestHash: "b".repeat(64) }),
    /Telegram update content changed after it was received/,
  );
  assert.deepEqual(calls[0], { where: { botId_updateId: { botId: "test-bot", updateId: "17" } } });
});

test("consumes a button once for its Telegram user", async () => {
  const { calls, repository } = createRepository();
  const result = await repository.consumeButtonAction({ token: "short-token", telegramUserId: "976684739", result: { text: "done" } });
  assert.equal(result.status, "consumed");
  assert.deepEqual((calls.find((call) => call.operation === "action.updateMany")?.args as { where: unknown }).where, {
    id: action.id,
    token: "short-token",
    telegramUserId: "976684739",
    consumedAt: null,
    expiresAt: { gt: (calls.find((call) => call.operation === "action.updateMany")?.args as { where: { expiresAt: { gt: Date } } }).where.expiresAt.gt },
  });
  assert.equal((result.action as RovelleCreatorAction).token, action.token);
  assert.deepEqual(calls.find((call) => call.operation === "transaction")?.args, { isolationLevel: "Serializable" });
});

test("consumes a creative action inside the caller's transaction", async () => {
  const creativeAction = { ...action, kind: "CREATIVE_PAGE" };
  const { calls, repository, transaction } = createRepository({
    foundAction: creativeAction,
  });
  const consume = (
    repository as unknown as {
      consumeCreativeActionInTransaction?: (...args: unknown[]) => Promise<{ status: string }>;
    }
  ).consumeCreativeActionInTransaction;

  assert.equal(typeof consume, "function");
  const result = await consume!.call(repository, transaction, {
    token: creativeAction.token,
    telegramUserId: creativeAction.telegramUserId,
    kind: "CREATIVE_PAGE",
    result: { text: "Page 2" },
  });

  assert.equal(result.status, "consumed");
  assert.equal(
    calls.some((call) => call.operation === "transaction"),
    false,
  );
  const update = calls.find((call) => call.operation === "action.updateMany")?.args as {
    where: Record<string, unknown>;
    data: Record<string, unknown>;
  };
  assert.equal(update.where.kind, "CREATIVE_PAGE");
  assert.deepEqual(update.data.result, { text: "Page 2" });
});

test("replaces a consumed button result with a safe terminal reply", async () => {
  const { calls, repository } = createRepository();
  await repository.updateConsumedButtonResult({ token: action.token, telegramUserId: action.telegramUserId, result: { text: "Generation could not be completed." } });
  assert.deepEqual(calls, [{
    operation: "action.updateMany",
    args: {
      where: { token: action.token, telegramUserId: action.telegramUserId, consumedAt: { not: null } },
      data: { result: { text: "Generation could not be completed." } },
    },
  }]);
});

test("claims selected review action and same-group sibling atomically", async () => {
  const reviewActions = [
    { ...action, kind: "APPROVE_GENERATION", payload: { actionGroup: "review-1" } },
    { ...action, id: "750e8400-e29b-41d4-a716-446655440000", token: "sibling-token", kind: "REGENERATE_SHOT", payload: { actionGroup: "review-1" } },
  ];
  const { calls, repository } = createRepository({ reviewActions });
  const result = await repository.claimActionGroup({
    token: reviewActions[0].token,
    telegramUserId: action.telegramUserId,
    result: { text: "accepted" },
    siblingResult: { text: "already handled" },
    scope: "review",
  });
  assert.equal(result.status, "consumed");
  const updates = calls.filter((call) => call.operation === "action.updateMany");
  assert.equal(updates.length, 2);
  assert.deepEqual((updates[0]?.args as { where: unknown }).where, {
    id: reviewActions[0].id,
    token: reviewActions[0].token,
    telegramUserId: action.telegramUserId,
    kind: "APPROVE_GENERATION",
    consumedAt: null,
    expiresAt: { gt: ((updates[0]?.args as { where: { expiresAt: { gt: Date } } }).where.expiresAt.gt) },
  });
  assert.deepEqual((updates[1]?.args as { data: unknown }).data, { result: { text: "already handled" }, consumedAt: (updates[1]?.args as { data: { consumedAt: Date } }).data.consumedAt });
  assert.deepEqual(calls.find((call) => call.operation === "action.findMany")?.args, {
    where: {
      telegramUserId: action.telegramUserId,
      kind: { in: ["APPROVE_GENERATION", "REGENERATE_SHOT"] },
      consumedAt: null,
      expiresAt: { gt: (calls.find((call) => call.operation === "action.findMany")?.args as { where: { expiresAt: { gt: Date } } }).where.expiresAt.gt },
    },
  });
});

test("retries serializable conflict while claiming a review group", async () => {
  const review = { ...action, kind: "APPROVE_GENERATION", payload: { actionGroup: "review-1" } };
  const { calls, repository } = createRepository({ reviewActions: [review], transactionErrors: [{ code: "P2034" }] });
  const result = await repository.claimActionGroup({
    token: review.token,
    telegramUserId: review.telegramUserId,
    result: { text: "accepted" },
    siblingResult: { text: "already handled" },
    scope: "review",
  });
  assert.equal(result.status, "consumed");
  assert.equal(calls.filter((call) => call.operation === "transaction").length, 2);
});

test("claims generation siblings and retries a serializable conflict", async () => {
  const generationActions = [
    { ...action, kind: "GENERATE_SHOT", payload: { actionGroup: "generation:976684739:episode-1:shot-1" } },
    { ...action, id: "850e8400-e29b-41d4-a716-446655440000", token: "generation-sibling", kind: "GENERATE_SHOT", payload: { actionGroup: "generation:976684739:episode-1:shot-1" } },
  ];
  const { calls, repository } = createRepository({ reviewActions: generationActions, transactionErrors: [{ code: "P2034" }] });
  const result = await repository.claimActionGroup({
    token: generationActions[0].token,
    telegramUserId: action.telegramUserId,
    result: { text: "accepted" },
    siblingResult: { text: "already handled" },
    scope: "generation",
  });
  assert.equal(result.status, "consumed");
  assert.equal(calls.filter((call) => call.operation === "transaction").length, 2);
  assert.equal(calls.filter((call) => call.operation === "action.updateMany").length, 2);
  assert.deepEqual((calls.filter((call) => call.operation === "action.findMany").at(-1)?.args as { where: { kind: unknown } }).where.kind, { in: ["GENERATE_SHOT"] });
});

test("claims duplicate render buttons as one render action group", async () => {
  const renders = [
    { ...action, kind: "QUEUE_RENDER", payload: { actionGroup: "render:976684739:episode-1" } },
    { ...action, id: "950e8400-e29b-41d4-a716-446655440000", token: "render-sibling", kind: "QUEUE_RENDER", payload: { actionGroup: "render:976684739:episode-1" } },
  ];
  const { calls, repository } = createRepository({ reviewActions: renders });
  const result = await repository.claimActionGroup({
    token: renders[0].token,
    telegramUserId: action.telegramUserId,
    result: { text: "queued", requestId: "request-id" },
    siblingResult: { text: "already handled" },
    scope: "render",
  });
  assert.equal(result.status, "consumed");
  assert.deepEqual((calls.find((call) => call.operation === "action.findMany")?.args as { where: { kind: unknown } }).where.kind, { in: ["QUEUE_RENDER"] });
  assert.equal(calls.filter((call) => call.operation === "action.updateMany").length, 2);
});

test("looks up a pending button without consuming it", async () => {
  const { calls, repository } = createRepository();
  const result = await repository.findPendingButtonAction(action.token, action.telegramUserId);
  assert.equal(result.status, "pending");
  assert.equal(calls.some((call) => call.operation === "action.updateMany"), false);
});

test("rejects an expired action before consuming it", async () => {
  const { calls, repository } = createRepository({ foundAction: { ...action, expiresAt: new Date("2020-01-01T00:00:00.000Z") } });
  const result = await repository.consumeButtonAction({ token: action.token, telegramUserId: action.telegramUserId, result: { text: "done" } });
  assert.equal(result.status, "expired");
  assert.equal(calls.some((call) => call.operation === "action.updateMany"), false);
});

test("returns the stored result for a duplicate button click", async () => {
  const { repository } = createRepository({ foundAction: { ...action, consumedAt: new Date(), result: { text: "already done" } } });
  const result = await repository.consumeButtonAction({ token: action.token, telegramUserId: action.telegramUserId, result: { text: "done" } });
  assert.equal(result.status, "duplicate");
  assert.deepEqual(result.result, { text: "already done" });
});

test("rejects a consumed upload token in the button path", async () => {
  const upload = { ...action, kind: "UPLOAD_CANON", consumedAt: new Date(), result: { text: "uploaded" } };
  const { repository } = createRepository({ foundAction: upload });
  const result = await repository.consumeButtonAction({ token: upload.token, telegramUserId: upload.telegramUserId, result: { text: "done" } });
  assert.equal(result.status, "not_found");
});

test("does not reveal a foreign upload token through the button path", async () => {
  const upload = { ...action, kind: "UPLOAD_CANON" };
  const { repository } = createRepository({ foundAction: upload });
  const result = await repository.consumeButtonAction({ token: upload.token, telegramUserId: "123", result: { text: "done" } });
  assert.equal(result.status, "not_found");
});

test("rejects a foreign Telegram user", async () => {
  const { calls, repository } = createRepository();
  const result = await repository.consumeButtonAction({ token: action.token, telegramUserId: "123", result: { text: "done" } });
  assert.equal(result.status, "foreign_user");
  assert.equal(calls.some((call) => call.operation === "action.updateMany"), false);
});

test("retries a serializable conflict before consuming", async () => {
  const { calls, repository } = createRepository({ transactionErrors: [{ code: "P2034" }] });
  const result = await repository.consumeButtonAction({ token: action.token, telegramUserId: action.telegramUserId, result: { text: "done" } });
  assert.equal(result.status, "consumed");
  assert.equal(calls.filter((call) => call.operation === "transaction").length, 2);
});

test("rethrows after serializable retry exhaustion", async () => {
  const conflict = { code: "P2034" };
  const { calls, repository } = createRepository({ transactionErrors: [conflict, conflict, conflict] });
  await assert.rejects(() => repository.consumeButtonAction({ token: action.token, telegramUserId: action.telegramUserId, result: { text: "done" } }), (error) => error === conflict);
  assert.equal(calls.filter((call) => call.operation === "transaction").length, 3);
});

test("rejects a button without a safe result before opening a transaction", async () => {
  const { calls, repository } = createRepository();
  const result = await repository.consumeButtonAction({ token: action.token, telegramUserId: action.telegramUserId, result: undefined as never });
  assert.equal(result.status, "invalid_result");
  assert.equal(calls.some((call) => call.operation === "transaction"), false);
  assert.equal(calls.some((call) => call.operation === "action.updateMany"), false);
});

test("classifies a raced action after re-reading it", async () => {
  const expired = { ...action, expiresAt: new Date("2020-01-01T00:00:00.000Z") };
  const { repository } = createRepository({ foundActions: [action, expired], updateCount: 0 });
  const result = await repository.consumeButtonAction({ token: action.token, telegramUserId: action.telegramUserId, result: { text: "done" } });
  assert.equal(result.status, "expired");
});

test("returns stored result for a raced button claim", async () => {
  const consumed = { ...action, consumedAt: new Date(), result: { text: "already done" } };
  const { repository } = createRepository({ foundActions: [action, consumed], updateCount: 0 });
  const result = await repository.consumeButtonAction({ token: action.token, telegramUserId: action.telegramUserId, result: { text: "done" } });
  assert.equal(result.status, "duplicate");
  assert.deepEqual(result.result, { text: "already done" });
});

test("upload action lookup is user-bound and pending", async () => {
  const upload = { ...action, kind: "UPLOAD_CANON" };
  const { repository } = createRepository({ foundAction: upload });
  const result = await repository.findPendingUploadAction(upload.token, upload.telegramUserId);
  assert.equal(result.status, "pending");
});

test("public upload lookup exposes only a pending action bound to its session user", async () => {
  const upload = { ...action, kind: "UPLOAD_AUDIO" };
  const { repository } = createRepository({ foundAction: upload });
  const result = await repository.findPendingUploadActionByToken(upload.token);
  assert.equal(result.status, "pending");
  assert.equal(result.action.telegramUserId, upload.telegramUserId);
});

test("claims a single upload reservation before creating its asset", async () => {
  const upload = { ...action, kind: "UPLOAD_CANON", payload: { canonVersionId: "version-1", assetType: "CHARACTER_REFERENCE" } };
  const { calls, repository } = createRepository({ foundAction: upload });
  const result = await repository.claimUploadReservation({
    token: upload.token,
    telegramUserId: upload.telegramUserId,
    assetId: "750e8400-e29b-41d4-a716-446655440000",
    mediaType: "image/png",
  });
  assert.equal(result.status, "claimed");
  const where = (calls.find((call) => call.operation === "action.updateMany")?.args as { where: { id: string; token: string; telegramUserId: string; result: unknown } }).where;
  assert.equal(where.id, upload.id);
  assert.equal(where.token, upload.token);
  assert.equal(where.telegramUserId, upload.telegramUserId);
  assert.ok(where.result);
});

test("reclaims a crashed reservation after its short lease using the same asset ID", async () => {
  const upload = {
    ...action,
    kind: "UPLOAD_CANON",
    payload: { canonVersionId: "version-1", assetType: "CHARACTER_REFERENCE" },
    updatedAt: new Date("2020-01-01T00:00:00.000Z"),
    result: {
      phase: "RESERVING",
      assetId: "750e8400-e29b-41d4-a716-446655440000",
      mediaType: "image/png",
      leaseExpiresAt: "2020-01-01T00:00:30.000Z",
    },
  };
  const { repository } = createRepository({ foundAction: upload });
  const result = await repository.claimUploadReservation({
    token: upload.token,
    telegramUserId: upload.telegramUserId,
    assetId: "950e8400-e29b-41d4-a716-446655440000",
    mediaType: "image/png",
  });
  assert.equal(result.status, "claimed");
  assert.equal(result.assetId, "750e8400-e29b-41d4-a716-446655440000");
});

test("does not reclaim a live reservation lease", async () => {
  const upload = {
    ...action,
    kind: "UPLOAD_CANON",
    result: {
      phase: "RESERVING",
      assetId: "750e8400-e29b-41d4-a716-446655440000",
      mediaType: "image/png",
      leaseExpiresAt: new Date(Date.now() + 30_000).toISOString(),
    },
  };
  const { calls, repository } = createRepository({ foundAction: upload });
  const result = await repository.claimUploadReservation({
    token: upload.token,
    telegramUserId: upload.telegramUserId,
    assetId: "950e8400-e29b-41d4-a716-446655440000",
    mediaType: "image/png",
  });
  assert.equal(result.status, "reserving");
  assert.equal(calls.some((call) => call.operation === "action.updateMany"), false);
});

test("claims upload completion before its domain side effects", async () => {
  const upload = { ...action, kind: "UPLOAD_CANON", payload: { canonVersionId: "version-1", assetType: "CHARACTER_REFERENCE", assetId: "750e8400-e29b-41d4-a716-446655440000", mediaType: "image/png" } };
  const { repository } = createRepository({ foundAction: upload });
  assert.equal((await repository.claimUploadCompletion({ token: upload.token, telegramUserId: upload.telegramUserId })).status, "claimed");
});

test("does not claim completion before a reserved asset is bound", async () => {
  const upload = { ...action, kind: "UPLOAD_CANON", payload: { canonVersionId: "version-1", assetType: "CHARACTER_REFERENCE" } };
  const { repository } = createRepository({ foundAction: upload });
  assert.equal((await repository.claimUploadCompletion({ token: upload.token, telegramUserId: upload.telegramUserId })).status, "unbound");
});

test("rejects a consumed button token in upload lookup", async () => {
  const consumed = { ...action, consumedAt: new Date(), result: { text: "done" } };
  const { repository } = createRepository({ foundAction: consumed });
  const result = await repository.findPendingUploadAction(consumed.token, consumed.telegramUserId);
  assert.equal(result.status, "not_found");
});

test("completes an upload action once and stores its safe result", async () => {
  const upload = { ...action, kind: "UPLOAD_CANON" };
  const { calls, repository } = createRepository({ foundAction: upload });
  const result = await repository.completeUploadAction({ token: upload.token, telegramUserId: upload.telegramUserId, result: { text: "uploaded" } });
  assert.equal(result.status, "consumed");
  assert.equal(calls.filter((call) => call.operation === "action.updateMany").length, 1);
  assert.deepEqual(calls.find((call) => call.operation === "transaction")?.args, { isolationLevel: "Serializable" });
});

test("returns the stored result for a duplicate upload completion", async () => {
  const upload = { ...action, kind: "UPLOAD_CANON", consumedAt: new Date(), result: { text: "uploaded" } };
  const { calls, repository } = createRepository({ foundAction: upload });
  const result = await repository.completeUploadAction({ token: upload.token, telegramUserId: upload.telegramUserId, result: { text: "again" } });
  assert.equal(result.status, "duplicate");
  assert.deepEqual(result.result, { text: "uploaded" });
  assert.equal(calls.some((call) => call.operation === "action.updateMany"), false);
});

test("rejects a consumed button token in the upload path", async () => {
  const consumed = { ...action, consumedAt: new Date(), result: { text: "done" } };
  const { repository } = createRepository({ foundAction: consumed });
  const result = await repository.completeUploadAction({ token: consumed.token, telegramUserId: consumed.telegramUserId, result: { text: "uploaded" } });
  assert.equal(result.status, "not_found");
});

test("does not reveal a foreign button token through the upload path", async () => {
  const { repository } = createRepository({ foundAction: action });
  const result = await repository.completeUploadAction({ token: action.token, telegramUserId: "123", result: { text: "uploaded" } });
  assert.equal(result.status, "not_found");
});

test("returns stored result for a raced upload completion", async () => {
  const upload = { ...action, kind: "UPLOAD_CANON" };
  const consumed = { ...upload, consumedAt: new Date(), result: { text: "already uploaded" } };
  const { repository } = createRepository({ foundActions: [upload, consumed], updateCount: 0 });
  const result = await repository.completeUploadAction({ token: upload.token, telegramUserId: upload.telegramUserId, result: { text: "uploaded" } });
  assert.equal(result.status, "duplicate");
  assert.deepEqual(result.result, { text: "already uploaded" });
});

test("classifies foreign and expired upload completion without consuming", async () => {
  const upload = { ...action, kind: "UPLOAD_CANON" };
  const foreign = createRepository({ foundAction: upload });
  assert.equal((await foreign.repository.completeUploadAction({ token: upload.token, telegramUserId: "123", result: {} })).status, "foreign_user");
  const expired = createRepository({ foundAction: { ...upload, expiresAt: new Date("2020-01-01T00:00:00.000Z") } });
  assert.equal((await expired.repository.completeUploadAction({ token: upload.token, telegramUserId: upload.telegramUserId, result: {} })).status, "expired");
});
