import * as assert from "node:assert/strict";
import { test } from "node:test";
import { Prisma, RovelleCreativeJobStatus } from "../../generated/prisma/client";
import { creativeInput, creativeResult } from "./creative.fixture";
import { hashCreativeValue } from "./creative-validation";
import { CreativeApprovalService } from "./creative-approval.service";

const telegramUserId = "976684739";
const sessionId = "623e4567-e89b-42d3-a456-426614174000";
const jobId = "723e4567-e89b-42d3-a456-426614174000";
const actionToken = "opaque-creative-approval-token";
const canonEntityId = "223e4567-e89b-42d3-a456-426614174000";
const canonVersionId = "323e4567-e89b-42d3-a456-426614174000";

function createApproval(options: {
  approved?: boolean;
  viewedPages?: number[];
  currentPage?: number;
  page?: number;
  scriptLength?: number;
} = {}) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const input = {
    ...creativeInput,
    canon: [{ entityId: canonEntityId, versionId: canonVersionId, code: "KOKO", definition: { color: "yellow" } }],
  };
  const inputHash = hashCreativeValue(input);
  const result = options.scriptLength === undefined
    ? creativeResult
    : { ...creativeResult, script: "S".repeat(options.scriptLength) };
  const episode = { id: "823e4567-e89b-42d3-a456-426614174000", code: "RV12345678901234567890", title: input.title };
  const reply = { text: `Plan saved as “${input.title}” (${episode.code}). Episode is in PREPRODUCTION; no generation has started.` };
  const sessionData: Record<string, unknown> = {
    creativeJobId: jobId,
    creativeInputRevision: input.inputRevision,
    creativeReviewProgress: {
      jobId,
      inputRevision: input.inputRevision,
      inputHash,
      currentPage: options.currentPage ?? 1,
      viewedPages: options.viewedPages ?? [1],
    },
    ...(options.approved ? {
      episodeId: episode.id,
      creativeSavedPlan: { jobId, inputRevision: input.inputRevision, inputHash, reply },
    } : {}),
  };
  const job = {
    id: jobId,
    creatorSessionId: sessionId,
    telegramUserId,
    chatId: telegramUserId,
    inputRevision: input.inputRevision,
    task: "STORYBOARD",
    input: input as unknown as Prisma.JsonValue,
    inputHash,
    status: RovelleCreativeJobStatus.SUCCEEDED,
    attemptTokenHash: null,
    leaseExpiresAt: null,
    result: result as unknown as Prisma.JsonValue,
    completionMetadata: null,
    completionResponse: null,
    completionHash: null,
    failureCode: null,
    supersededAt: null,
    episodeId: options.approved ? episode.id : null,
    approvedAt: options.approved ? new Date() : null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const action = {
    id: "923e4567-e89b-42d3-a456-426614174000",
    token: actionToken,
    telegramUserId,
    kind: "CREATIVE_APPROVE",
    payload: { jobId, inputRevision: input.inputRevision, inputHash, page: options.page ?? 1 },
    expiresAt: new Date(Date.now() + 60_000),
    consumedAt: options.approved ? new Date() : null,
    result: options.approved ? reply : null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const session = { id: sessionId, telegramUserId, step: options.approved ? "IDLE" : "CREATIVE_REVIEW", data: sessionData };
  const repository = {
    lockSession: async (...args: unknown[]) => { calls.push({ method: "session.lock", args }); return session; },
    lockCreativeJob: async (...args: unknown[]) => { calls.push({ method: "job.lock", args }); return job; },
    lockActionInTransaction: async (...args: unknown[]) => { calls.push({ method: "action.lock", args }); return action; },
    approveCreativeJobInTransaction: async (...args: unknown[]) => { calls.push({ method: "job.approve", args }); return true; },
    consumeCreativeActionInTransaction: async (...args: unknown[]) => { calls.push({ method: "action.consume", args }); return { status: "consumed" as const }; },
    invalidateCreativeActions: async (...args: unknown[]) => { calls.push({ method: "actions.invalidate", args }); },
    saveSession: async (...args: unknown[]) => { calls.push({ method: "session.save", args }); },
  };
  const episodes = {
    createEpisode: async (...args: unknown[]) => { calls.push({ method: "episode.create", args }); return episode; },
    updateBrief: async (...args: unknown[]) => { calls.push({ method: "episode.brief", args }); return episode; },
    approveBrief: async (...args: unknown[]) => { calls.push({ method: "episode.approve", args }); return episode; },
    startPreproduction: async (...args: unknown[]) => { calls.push({ method: "episode.preproduction", args }); return episode; },
    replaceShots: async (...args: unknown[]) => { calls.push({ method: "episode.shots", args }); return episode; },
  };
  const canonPins = {
    pinEpisode: async (...args: unknown[]) => { calls.push({ method: "canon.pin", args }); return {}; },
  };
  const service = new CreativeApprovalService(
    repository as never,
    episodes as never,
    canonPins as never,
  );
  return { service, calls, input, inputHash, result, episode, reply, tx: {} as Prisma.TransactionClient };
}

test("approves the reviewed storyboard in the supplied transaction and saves the reply", async () => {
  const fake = createApproval();

  const reply = await fake.service.approve(fake.tx, { telegramUserId, token: actionToken });

  assert.deepEqual(reply, fake.reply);
  assert.deepEqual(fake.calls.map((call) => call.method), [
    "session.lock", "job.lock", "action.lock", "episode.create", "episode.brief", "episode.approve",
    "episode.preproduction", "episode.shots", "canon.pin", "job.approve", "action.consume",
    "actions.invalidate", "session.save",
  ]);
  const episodeCreate = fake.calls.find((call) => call.method === "episode.create")!.args;
  assert.equal(((episodeCreate[0] as { code: string }).code).length <= 32, true);
  assert.equal(episodeCreate[1], fake.tx);
  const brief = fake.calls.find((call) => call.method === "episode.brief")!.args[1] as { brief: Record<string, unknown> };
  assert.deepEqual(brief.brief.storyboard, fake.result);
  assert.equal(brief.brief.script, fake.result.script);
  assert.equal(brief.brief.creativeJobId, jobId);
  assert.equal(brief.brief.creativeInputRevision, creativeInput.inputRevision);
  const shots = fake.calls.find((call) => call.method === "episode.shots")!.args[1] as { shots: Array<Record<string, unknown>> };
  assert.deepEqual(shots.shots, [{ sequence: 1, name: "Shot 1", direction: fake.result.shots[0]!.direction, targetDurationSeconds: 4 }]);
  const pin = fake.calls.find((call) => call.method === "canon.pin")!.args;
  assert.deepEqual(pin.slice(0, 3), [fake.episode.id, canonEntityId, { canonVersionId }]);
  assert.equal(pin[3], fake.tx);
  assert.equal(fake.calls.some((call) => /generation|preflight|render/i.test(call.method)), false);
});

test("replays an approved plan without repeating episode mutations", async () => {
  const fake = createApproval({ approved: true });

  const reply = await fake.service.approve(fake.tx, { telegramUserId, token: actionToken });

  assert.deepEqual(reply, fake.reply);
  assert.equal(fake.calls.some((call) => call.method.startsWith("episode.")), false);
  assert.equal(fake.calls.some((call) => call.method === "job.approve"), false);
});

test("rejects approval until every preview page is recorded", async () => {
  const fake = createApproval({ viewedPages: [] });

  const reply = await fake.service.approve(fake.tx, { telegramUserId, token: actionToken });

  assert.match(reply.text, /view every preview page/i);
  assert.equal(fake.calls.some((call) => call.method.startsWith("episode.")), false);
});

test("allows a reviewed approval token after navigating back from the final page", async () => {
  const fake = createApproval({ scriptLength: 8_000, page: 3, currentPage: 2, viewedPages: [1, 2, 3] });

  const reply = await fake.service.approve(fake.tx, { telegramUserId, token: actionToken });

  assert.deepEqual(reply, fake.reply);
  assert.ok(fake.calls.some((call) => call.method === "episode.create"));
});
