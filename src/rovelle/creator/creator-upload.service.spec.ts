import * as assert from "node:assert/strict";
import { test } from "node:test";
import { NotFoundException } from "@nestjs/common";
import { CreatorUploadService } from "./creator-upload.service";

type UploadAction = {
  token: string;
  telegramUserId: string;
  kind: string;
  payload: Record<string, unknown>;
  expiresAt: Date;
  consumedAt: Date | null;
  result: Record<string, unknown> | null;
};

const ACTION: UploadAction = {
  token: "opaque-token",
  telegramUserId: "976684739",
  kind: "UPLOAD_CANON",
  payload: {
    canonVersionId: "11111111-1111-4111-8111-111111111111",
    assetType: "CHARACTER_REFERENCE",
  },
  expiresAt: new Date(Date.now() + 60_000),
  consumedAt: null,
  result: null,
};

function createService(action: UploadAction = ACTION, options: { reserveGate?: Promise<void>; finalizeFailures?: number; reclaimReservation?: boolean } = {}) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  let current = { ...action, payload: { ...action.payload } };
  let finalizeFailures = options.finalizeFailures ?? 0;
  const repository = {
    findPendingUploadActionByToken: async () => current.consumedAt
      ? { status: "consumed" as const, action: current, result: current.result }
      : { status: "pending" as const, action: current },
    claimUploadReservation: async (input: { assetId: string; mediaType: string }) => {
      if (current.result && !options.reclaimReservation) return { status: "reserving" as const, action: current, assetId: current.result.assetId as string };
      const assetId = options.reclaimReservation && typeof current.result?.assetId === "string" ? current.result.assetId : input.assetId;
      current = { ...current, result: { phase: "RESERVING", assetId, mediaType: input.mediaType, leaseExpiresAt: new Date(Date.now() + 30_000).toISOString() } };
      calls.push({ method: "action.reserveClaim", args: [input] });
      return { status: "claimed" as const, action: current, assetId };
    },
    bindReservedUploadAsset: async (input: { payload: Record<string, unknown> }) => {
      current = { ...current, payload: input.payload };
      current = { ...current, result: null };
      calls.push({ method: "action.assetBind", args: [input] });
      return { status: "pending" as const, action: current };
    },
    findSession: async () => ({ step: "IDLE", data: { episodeId: "22222222-2222-4222-8222-222222222222" } }),
    upsertSession: async (input: unknown) => { calls.push({ method: "session.upsert", args: [input] }); return input; },
    claimUploadCompletion: async () => {
      if (current.consumedAt) return { status: "duplicate" as const, action: current, result: current.result };
      if (current.result) return { status: "processing" as const, action: current };
      current = { ...current, result: { phase: "COMPLETING" } };
      calls.push({ method: "action.completeClaim", args: [] });
      return { status: "claimed" as const, action: current };
    },
    completeUploadAction: async (input: { result: Record<string, unknown> }) => {
      calls.push({ method: "action.complete", args: [input] });
      if (finalizeFailures > 0) {
        finalizeFailures -= 1;
        throw new Error("finalize failed");
      }
      current = { ...current, consumedAt: new Date(), result: input.result };
      return { status: "consumed" as const, action: current, result: input.result };
    },
  };
  const assets = {
    reserveWithId: async (...args: unknown[]) => {
      calls.push({ method: "asset.reserve", args });
      await options.reserveGate;
      return {
        asset: { id: "33333333-3333-4333-8333-333333333333" },
        upload: { method: "PUT", url: "https://r2.example/private", headers: { "content-type": "image/png" }, expiresAt: "soon" },
      };
    },
    createUploadUrl: async (...args: unknown[]) => {
      calls.push({ method: "asset.uploadUrl", args });
      return {
        asset: { id: "33333333-3333-4333-8333-333333333333" },
        upload: { method: "PUT", url: "https://r2.example/private", headers: { "content-type": "image/png" }, expiresAt: "soon" },
      };
    },
    confirmUpload: async (...args: unknown[]) => { calls.push({ method: "asset.confirm", args }); return { id: "33333333-3333-4333-8333-333333333333" }; },
  };
  const canon = {
    attachAsset: async (...args: unknown[]) => { calls.push({ method: "canon.attach", args }); return {}; },
    getVersion: async () => ({ assets: [] }),
  };
  return { service: new CreatorUploadService(repository as never, assets as never, canon as never, "https://core.test"), calls };
}

test("rejects unavailable public upload tokens without exposing details", async () => {
  const { service } = createService({ ...ACTION, consumedAt: new Date() });
  await assert.rejects(() => service.page("opaque-token"), NotFoundException);
});

test("prepares only a canon image and keeps R2 URL out of completion", async () => {
  const { service, calls } = createService();
  await assert.rejects(() => service.prepare("opaque-token", { mediaType: "audio/mpeg" }), /image/i);
  const prepared = await service.prepare("opaque-token", { mediaType: "image/png", originalFilename: "koko.png" });
  assert.equal(prepared.upload.url, "https://r2.example/private");
  const completed = await service.complete("opaque-token");
  assert.deepEqual(calls.map((call) => call.method), ["action.reserveClaim", "asset.reserve", "action.assetBind", "action.completeClaim", "asset.confirm", "canon.attach", "session.upsert", "action.complete"]);
  assert.equal(((calls.find((call) => call.method === "session.upsert")?.args[0] as { data: { pendingCanonLockVersionId?: string } }).data.pendingCanonLockVersionId), "11111111-1111-4111-8111-111111111111");
  assert.doesNotMatch(JSON.stringify(completed), /r2\.example|33333333/i);
});

test("stores an audio master only after confirm and accepts audio only", async () => {
  const { service, calls } = createService({
    ...ACTION,
    kind: "UPLOAD_AUDIO",
    payload: { episodeId: "22222222-2222-4222-8222-222222222222" },
  });
  await assert.rejects(() => service.prepare("opaque-token", { mediaType: "image/png" }), /audio/i);
  await service.prepare("opaque-token", { mediaType: "audio/mpeg" });
  const completed = await service.complete("opaque-token");
  assert.equal(calls.findIndex((call) => call.method === "asset.confirm") < calls.findIndex((call) => call.method === "session.upsert"), true);
  assert.match(completed.text, /audio master/i);
});

test("replays the stored safe completion result", async () => {
  const { service } = createService({ ...ACTION, consumedAt: new Date(), result: { text: "Canon image attached. Return to Telegram." } });
  assert.deepEqual(await service.complete("opaque-token"), { text: "Canon image attached. Return to Telegram." });
});

test("concurrent prepares claim one deterministic asset and later reuse it", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const { service, calls } = createService(ACTION, { reserveGate: gate });
  const first = service.prepare("opaque-token", { mediaType: "image/png" });
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(() => service.prepare("opaque-token", { mediaType: "image/png" }), /being prepared/i);
  release();
  await first;
  await service.prepare("opaque-token", { mediaType: "image/png" });
  assert.equal(calls.filter((call) => call.method === "asset.reserve").length, 1);
  assert.equal(calls.filter((call) => call.method === "asset.uploadUrl").length, 1);
});

test("a crash before bind reclaims the original reservation without creating another asset", async () => {
  const crashed = {
    ...ACTION,
    result: {
      phase: "RESERVING",
      assetId: "44444444-4444-4444-8444-444444444444",
      mediaType: "image/png",
      leaseExpiresAt: "2020-01-01T00:00:00.000Z",
    },
  };
  const { service, calls } = createService(crashed, { reclaimReservation: true });
  await service.prepare("opaque-token", { mediaType: "image/png" });
  assert.equal((calls.find((call) => call.method === "asset.reserve")?.args[1]), "44444444-4444-4444-8444-444444444444");
  assert.equal(calls.filter((call) => call.method === "asset.reserve").length, 1);
});

test("finalize retry replays a safe completion without repeating confirm or attach", async () => {
  const { service, calls } = createService(ACTION, { finalizeFailures: 1 });
  await service.prepare("opaque-token", { mediaType: "image/png" });
  const first = await service.complete("opaque-token");
  const replay = await service.complete("opaque-token");
  assert.deepEqual(replay, first);
  assert.equal(calls.filter((call) => call.method === "asset.confirm").length, 1);
  assert.equal(calls.filter((call) => call.method === "canon.attach").length, 1);
  assert.equal(calls.filter((call) => call.method === "action.complete").length, 2);
});
