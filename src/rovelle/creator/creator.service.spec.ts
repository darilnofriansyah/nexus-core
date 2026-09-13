import * as assert from "node:assert/strict";
import { test } from "node:test";
import { RovelleAssetStatus, RovelleCanonEntityType, RovelleCanonVersionStatus } from "../../generated/prisma/client";
import type { CanonPinDto } from "../canon/dto/canon.dto";
import { CreatorService } from "./creator.service";

type Session = { step: string; data: Record<string, unknown> };
function createService(initial?: Session) {
  let session: Session | null = initial ?? null;
  const actions: Array<Record<string, unknown>> = [];
  const repository = {
    findSession: async () => session ? { ...session } : null,
    upsertSession: async (input: { step: string; data: Record<string, unknown> }) => { session = input; return input; },
    createAction: async (input: Record<string, unknown>) => { actions.push(input); return { ...input, token: "opaque-token" }; },
    findPendingButtonAction: async () => ({ status: "pending" as const, action: { kind: "CONFIRM_DRAFT", payload: {} } }),
    consumeButtonAction: async (input: Record<string, unknown>) => ({ status: "consumed" as const, action: { kind: "CONFIRM_DRAFT" }, result: input.result }),
  };
  return { service: new CreatorService(repository as never), getSession: () => session, actions };
}

test("walks the free draft fields in order", async () => {
  const { service, getSession } = createService();
  assert.match((await service.handleTelegram({ telegramUserId: "976684739", chatId: "976684739", messageText: "/new" })).text, /title/i);
  for (const [messageText, step] of [["Koko", "NEW_DURATION"], ["8", "NEW_PREMISE"], ["A premise", "NEW_LEARNING_GOAL"], ["A lesson", "NEW_TONE"], ["warm", "NEW_CANON_CODES"], ["KOKO", "NEW_SHOT_DIRECTIONS"]] as const) {
    await service.handleTelegram({ telegramUserId: "976684739", chatId: "976684739", messageText });
    assert.equal(getSession()?.step, step);
  }
});

test("done without directions stays in direction collection", async () => {
  const { service, getSession, actions } = createService({ step: "NEW_SHOT_DIRECTIONS", data: { duration: "4", shotDirections: [] } });
  const reply = await service.handleTelegram({ telegramUserId: "976684739", chatId: "976684739", messageText: "done" });
  assert.equal(getSession()?.step, "NEW_SHOT_DIRECTIONS");
  assert.match(reply.text, /direction/i);
  assert.equal(actions.length, 0);
});

test("done with manual directions reaches ready and creates only a confirm action", async () => {
  const { service, getSession, actions } = createService({ step: "NEW_SHOT_DIRECTIONS", data: { duration: "4", shotDirections: ["camera follows Koko"] } });
  const reply = await service.handleTelegram({ telegramUserId: "976684739", chatId: "976684739", messageText: "done" });
  assert.equal(getSession()?.step, "DRAFT_READY");
  assert.equal(actions.length, 1);
  assert.equal(actions[0].kind, "CONFIRM_DRAFT");
  assert.match(reply.text, /confirm/i);
  assert.deepEqual(reply.inlineKeyboard, [[{ text: "Confirm draft", callbackData: "rv:opaque-token" }]]);
});

test("requires a whole four-second target duration before planning", async () => {
  const { service, getSession } = createService({ step: "NEW_DURATION", data: { shotDirections: [] } });
  const reply = await service.handleTelegram({ telegramUserId: "976684739", chatId: "976684739", messageText: "10" });
  assert.match(reply.text, /4-second increment/i);
  assert.equal(getSession()?.step, "NEW_DURATION");
});

test("requires one manual direction for every four seconds before confirm", async () => {
  const { service, getSession, actions } = createService({ step: "NEW_SHOT_DIRECTIONS", data: { duration: "8", shotDirections: ["opening"] } });
  const reply = await service.handleTelegram({ telegramUserId: "976684739", chatId: "976684739", messageText: "done" });
  assert.match(reply.text, /2 manual shot directions/i);
  assert.equal(getSession()?.step, "NEW_SHOT_DIRECTIONS");
  assert.equal(actions.length, 0);
});

test("draft messages create no provider or domain work", async () => {
  const { service, actions } = createService({ step: "NEW_SHOT_DIRECTIONS", data: { duration: "4", shotDirections: [] } });
  await service.handleTelegram({ telegramUserId: "976684739", chatId: "976684739", messageText: "manual shot" });
  assert.equal(actions.length, 0);
});

test("rejects an incomplete confirm callback before consuming it", async () => {
  const { service } = createService();
  const reply = await service.handleTelegram({ telegramUserId: "976684739", chatId: "976684739", callbackToken: "opaque-token" });
  assert.match(reply.text, /4-second target duration/i);
});

test("handles the start-menu New episode callback as the new command", async () => {
  const { service, getSession, actions } = createService();
  const reply = await service.handleTelegram({ telegramUserId: "976684739", chatId: "976684739", callbackToken: "new" });
  assert.match(reply.text, /title/i);
  assert.equal(getSession()?.step, "NEW_TITLE");
  assert.equal(actions.length, 0);
});

test("opens canon setup and keeps audio gated before an episode", async () => {
  const { service, actions } = createService();
  assert.match((await service.handleTelegram({ telegramUserId: "976684739", chatId: "976684739", callbackToken: "canon" })).text, /canon details/i);
  assert.match((await service.handleTelegram({ telegramUserId: "976684739", chatId: "976684739", callbackToken: "audio" })).text, /confirm an episode/i);
  assert.match((await service.handleTelegram({ telegramUserId: "976684739", chatId: "976684739", callbackToken: "mywork" })).text, /no confirmed episode/i);
  assert.equal(actions.length, 0);
});

test("blank shot directions are not collected", async () => {
  const { service, getSession } = createService({ step: "NEW_SHOT_DIRECTIONS", data: { duration: "4", shotDirections: [] } });
  const reply = await service.handleTelegram({ telegramUserId: "976684739", chatId: "976684739", messageText: "   " });
  assert.match(reply.text, /direction/i);
  assert.deepEqual(getSession()?.data.shotDirections, []);
});

type Action = { kind: string; payload: Record<string, unknown>; result?: Record<string, unknown> };

function createActionService(options: {
  action: Action;
  session?: Session | null;
  canon?: { id: string; versions: Array<{ id: string; status: string }> } | null;
  episode?: Record<string, unknown>;
  generations?: Array<Record<string, unknown>>;
  consumeStatus?: "consumed" | "duplicate";
  failBrief?: boolean;
  failConfirmationCheckpoint?: boolean;
  preflightError?: boolean;
  canonIssue?: "missing" | "unlocked" | "unavailable" | "excess";
  generationError?: boolean;
  reviewError?: boolean;
  reviewActions?: Record<string, Action>;
  currentReview?: boolean;
  renderError?: boolean;
} ) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  let session = options.session ?? null;
  const consumedTokens = new Set<string>();
  const claimedReviewGroups = new Set<string>();
  const createdActions = new Map<string, Action>();
  let storedResult = options.action.result;
  let activeAction = options.action;
  let confirmationCheckpointFailures = 0;
  const actionFor = (token: string) => options.reviewActions?.[token] ?? createdActions.get(token) ?? options.action;
  const actionGroupFor = (action: Action) => typeof action.payload.actionGroup === "string" ? action.payload.actionGroup : null;
  const repository = {
    findSession: async () => session,
    upsertSession: async (input: Session) => {
      confirmationCheckpointFailures += 1;
      if (options.failConfirmationCheckpoint) {
        throw new Error("injected confirmation checkpoint failure");
      }
      session = input;
      return input;
    },
    createAction: async (input: Record<string, unknown>) => {
      calls.push({ method: "action.create", args: [input] });
      const baseToken = `${input.kind}-token`;
      const token = createdActions.has(baseToken) ? `${input.kind}-${createdActions.size}-token` : baseToken;
      const action = { kind: input.kind as string, payload: input.payload as Record<string, unknown> };
      createdActions.set(token, action);
      return { ...input, token };
    },
    findPendingButtonAction: async (token: string) => {
      calls.push({ method: "action.lookup", args: [] });
      activeAction = actionFor(token);
      const actionGroup = actionGroupFor(activeAction);
      if (actionGroup !== null && claimedReviewGroups.has(actionGroup) && !consumedTokens.has(token)) {
        return { status: "duplicate" as const, action: activeAction, result: { text: "That review was already handled. Check /mywork for its status." } };
      }
      return options.consumeStatus === "duplicate" || consumedTokens.has(token)
        ? { status: "duplicate" as const, action: activeAction, result: storedResult ?? { text: "That review was already handled. Check /mywork for its status." } }
        : { status: "pending" as const, action: activeAction };
    },
    consumeButtonAction: async (input: Record<string, unknown>) => {
      calls.push({ method: "action.consume", args: [input] });
      const token = input.token as string;
      if (options.consumeStatus === "duplicate" || consumedTokens.has(token)) {
        return { status: "duplicate" as const, action: activeAction, result: storedResult ?? { text: "already processing" } };
      }
      consumedTokens.add(token);
      storedResult = input.result as Record<string, unknown>;
      return { status: "consumed" as const, action: activeAction, result: input.result };
    },
    claimActionGroup: async (input: Record<string, unknown>) => {
      calls.push({ method: "action.groupClaim", args: [input] });
      const token = input.token as string;
      const actionGroup = actionGroupFor(activeAction);
      if (!actionGroup || claimedReviewGroups.has(actionGroup)) {
        return { status: "duplicate" as const, action: activeAction, result: { text: "That review was already handled. Check /mywork for its status." } };
      }
      claimedReviewGroups.add(actionGroup);
      consumedTokens.add(token);
      storedResult = input.result as Record<string, unknown>;
      return { status: "consumed" as const, action: activeAction, result: input.result };
    },
    updateConsumedButtonResult: async (input: Record<string, unknown>) => {
      calls.push({ method: "action.updateResult", args: [input] });
      storedResult = input.result as Record<string, unknown>;
    },
  };
  const episode = options.episode ?? {
    id: "episode-1",
    shots: [{ id: "shot-1", sequence: 1, status: "READY_TO_GENERATE" }],
  };
  const episodes = {
    createEpisode: async (...args: unknown[]) => { calls.push({ method: "episode.create", args }); return episode; },
    updateBrief: async (...args: unknown[]) => { calls.push({ method: "episode.brief", args }); if (options.failBrief) throw new Error("brief failure"); return episode; },
    approveBrief: async (...args: unknown[]) => { calls.push({ method: "episode.approve", args }); return episode; },
    startPreproduction: async (...args: unknown[]) => { calls.push({ method: "episode.preproduction", args }); return episode; },
    replaceShots: async (...args: unknown[]) => { calls.push({ method: "episode.shots", args }); return episode; },
    markReadyToGenerate: async (...args: unknown[]) => { calls.push({ method: "episode.ready", args }); return episode; },
    getEpisode: async (...args: unknown[]) => {
      calls.push({ method: "episode.get", args });
      return options.currentReview === false
        ? { ...episode, shots: [{ id: "shot-1", sequence: 1, status: "READY_TO_GENERATE" }] }
        : episode;
    },
  };
  const canonRepository = {
    findEntityByCode: async (...args: unknown[]) => { calls.push({ method: "canon.find", args }); return options.canon ?? { id: "canon-1", versions: [{ id: "canon-version-1", status: "LOCKED" }] }; },
  };
  const canonPins = {
    pinEpisode: async (...args: unknown[]) => { calls.push({ method: "canon.pin", args }); return {}; },
    getEffectiveShotCanon: async (...args: unknown[]) => { calls.push({ method: "canon.ready", args }); return canonPinsFor(options.canonIssue); },
  };
  const generation = {
    submitShot: async (...args: unknown[]) => { calls.push({ method: "generation.submit", args }); if (options.generationError) throw new Error("provider private URL"); return { id: "generation-1" }; },
    listShotGenerations: async (...args: unknown[]) => { calls.push({ method: "generation.list", args }); return options.generations ?? []; },
  };
  const review = {
    submitHumanReview: async (...args: unknown[]) => { calls.push({ method: "review.submit", args }); if (options.reviewError) throw new Error("provider private URL"); return {}; },
  };
  const preflight = {
    preflight: async (...args: unknown[]) => {
      calls.push({ method: "generation.preflight", args });
      if (options.preflightError) throw new Error("invalid canon");
      return {};
    },
  };
  const renders = {
    createRender: async (...args: unknown[]) => { calls.push({ method: "render.create", args }); if (options.renderError) throw new Error("private render error"); return { id: "render-1" }; },
  };
  const Constructor = CreatorService as unknown as new (...args: unknown[]) => CreatorService;
  return {
    service: new Constructor(repository, episodes, canonRepository, canonPins, generation, review, preflight, undefined, renders),
    calls,
    getSession: () => session,
    getConfirmationCheckpointFailures: () => confirmationCheckpointFailures,
    getCreatedActionTokens: () => [...createdActions.keys()],
  };
}

function canonPinsFor(issue?: "missing" | "unlocked" | "unavailable" | "excess"): CanonPinDto[] {
  const assetStatus = issue === "unavailable" ? RovelleAssetStatus.RESERVED : RovelleAssetStatus.AVAILABLE;
  const versionStatus = issue === "unlocked" ? RovelleCanonVersionStatus.DRAFT : RovelleCanonVersionStatus.LOCKED;
  const pin = (entityType: RovelleCanonEntityType, assets = 1) => ({
    version: {
      status: versionStatus,
      entity: { entityType },
      assets: Array.from({ length: assets }, () => ({ asset: { status: assetStatus, mediaType: "image/png" } })),
    },
  }) as CanonPinDto;
  const pins = [
    pin(RovelleCanonEntityType.CHARACTER, issue === "excess" ? 29 : 1),
    pin(RovelleCanonEntityType.ENVIRONMENT),
    pin(RovelleCanonEntityType.STYLE),
  ];
  return issue === "missing" ? pins.slice(0, 2) : pins;
}

const draft = {
  title: "Berry Count",
  duration: "4",
  premise: "Count berries",
  learningGoal: "Learn counting",
  tone: "warm",
  canonCodes: ["KOKO"],
  shotDirections: ["Koko finds three berries"],
};

test("confirming a draft is free, pins locked canon, and offers only shot one", async () => {
  const { service, calls, getSession } = createActionService({ action: { kind: "CONFIRM_DRAFT", payload: { draft } } });
  const reply = await service.handleTelegram({ telegramUserId: "976684739", chatId: "976684739", callbackToken: "confirm" });
  assert.match(reply.text, /Generate shot 1 · est\. \$0\.22/);
  assert.deepEqual(calls.map((call) => call.method), [
    "action.lookup", "canon.find", "action.consume", "episode.create", "episode.brief", "episode.approve", "episode.preproduction", "episode.shots", "canon.pin", "episode.ready", "episode.get", "generation.preflight", "canon.ready", "action.create",
  ]);
  assert.equal(calls.some((call) => call.method === "generation.submit"), false);
  assert.equal(getSession()?.data.episodeId, "episode-1");
  assert.deepEqual((calls.find((call) => call.method === "episode.shots")?.args[1] as { shots: unknown[] }).shots, [
    { sequence: 1, direction: "Koko finds three berries", targetDurationSeconds: 4 },
  ]);
  assert.deepEqual(reply.inlineKeyboard, [[{ text: "Generate shot 1 · est. $0.22", callbackData: "rv:GENERATE_SHOT-token" }]]);
});

test("a draft cannot confirm with an unlocked canon version", async () => {
  const { service, calls } = createActionService({
    action: { kind: "CONFIRM_DRAFT", payload: { draft } },
    canon: { id: "canon-1", versions: [{ id: "draft-version", status: "DRAFT" }] },
  });
  const reply = await service.handleTelegram({ telegramUserId: "976684739", chatId: "976684739", callbackToken: "confirm" });
  assert.match(reply.text, /locked canon/i);
  assert.equal(calls.some((call) => call.method === "episode.create"), false);
  assert.equal(calls.some((call) => call.method === "action.consume"), false);
});

test("invalid generate canon never mints a paid action", async () => {
  const { service, calls } = createActionService({
    action: { kind: "CONFIRM_DRAFT", payload: { draft } },
    preflightError: true,
  });
  const reply = await service.handleTelegram({ telegramUserId: "976684739", chatId: "976684739", callbackToken: "confirm" });
  assert.match(reply.text, /another try/i);
  assert.equal(calls.some((call) => call.method === "generation.submit"), false);
  const actions = calls.filter((call) => call.method === "action.create").map((call) => (call.args[0] as { kind: string }).kind);
  assert.deepEqual(actions, ["CONFIRM_DRAFT"]);
});

test("a confirmation domain failure keeps the episode and offers a resume action", async () => {
  const { service, getSession } = createActionService({ action: { kind: "CONFIRM_DRAFT", payload: { draft } }, failBrief: true });
  const reply = await service.handleTelegram({ telegramUserId: "976684739", chatId: "976684739", callbackToken: "confirm" });
  assert.match(reply.text, /another try/i);
  assert.equal(getSession()?.data.episodeId, "episode-1");
  assert.equal(getSession()?.data.confirmationStage, "CREATED");
  assert.deepEqual(reply.inlineKeyboard, [[{ text: "Retry confirmation", callbackData: "rv:CONFIRM_DRAFT-token" }]]);
});

test("legacy confirmDraft can orphan its episode when the post-create checkpoint also fails", async () => {
  const { service, calls, getSession, getConfirmationCheckpointFailures } = createActionService({
    action: { kind: "CONFIRM_DRAFT", payload: { draft } },
    failConfirmationCheckpoint: true,
  });

  await assert.rejects(() => service.handleTelegram({
    telegramUserId: "976684739",
    chatId: "976684739",
    callbackToken: "confirm",
  }), /injected confirmation checkpoint failure/);

  assert.equal(calls.filter((call) => call.method === "episode.create").length, 1);
  assert.equal(getConfirmationCheckpointFailures(), 2);
  assert.equal(getSession(), null);
  // No durable episode ID survived; a fresh confirm action can create an orphan duplicate.
});

test("a retry resumes the saved episode instead of creating another", async () => {
  const { service, calls } = createActionService({
    action: { kind: "CONFIRM_DRAFT", payload: { draft, episodeId: "episode-1", stage: "CREATED" } },
  });
  await service.handleTelegram({ telegramUserId: "976684739", chatId: "976684739", callbackToken: "retry" });
  assert.equal(calls.some((call) => call.method === "episode.create"), false);
  assert.equal(calls.some((call) => call.method === "episode.brief"), true);
});

test("a paid generation action is consumed before exactly one draft submission", async () => {
  const { service, calls } = createActionService({ action: { kind: "GENERATE_SHOT", payload: { shotId: "shot-1", sequence: 1, actionGroup: "generation-1" } } });
  const reply = await service.handleTelegram({ telegramUserId: "976684739", chatId: "976684739", callbackToken: "generate" });
  assert.match(reply.text, /started/i);
  assert.deepEqual(calls.map((call) => call.method), ["action.lookup", "canon.ready", "generation.preflight", "action.groupClaim", "generation.submit"]);
  const consumeResult = (calls[3]?.args[0] as { result: { requestId: string } }).result;
  const submitRequest = (calls[4]?.args[1] as { requestId: string; profile: string });
  assert.match(consumeResult.requestId, /^[0-9a-f-]{36}$/i);
  assert.deepEqual(submitRequest, { requestId: consumeResult.requestId, profile: "DRAFT" });
});

test("invalid canon leaves a generate button unconsumed", async () => {
  const { service, calls } = createActionService({
    action: { kind: "GENERATE_SHOT", payload: { shotId: "shot-1", sequence: 1, actionGroup: "generation-1" } },
    preflightError: true,
  });
  const reply = await service.handleTelegram({ telegramUserId: "976684739", chatId: "976684739", callbackToken: "generate" });
  assert.match(reply.text, /not ready to generate/i);
  assert.deepEqual(calls.map((call) => call.method), ["action.lookup", "canon.ready", "generation.preflight"]);
  assert.equal(calls.some((call) => call.method === "generation.submit"), false);
});

test("invalid canon never mints paid generate or regenerate actions", async () => {
  for (const canonIssue of ["missing", "unlocked", "unavailable", "excess"] as const) {
    const generate = createActionService({
      action: { kind: "unused", payload: {} },
      canonIssue,
      session: { step: "IDLE", data: { episodeId: "episode-1" } },
      episode: { id: "episode-1", shots: [{ id: "shot-1", sequence: 1, status: "READY_TO_GENERATE" }] },
    });
    const generateReply = await generate.service.handleTelegram({ telegramUserId: "976684739", chatId: "976684739", messageText: "/mywork" });
    assert.match(generateReply.text, /Canon references are not ready/i);
    assert.equal(generate.calls.some((call) => call.method === "action.create"), false);

    const regenerate = createActionService({
      action: { kind: "unused", payload: {} },
      canonIssue,
      session: { step: "IDLE", data: { episodeId: "episode-1" } },
      episode: { id: "episode-1", shots: [{ id: "shot-1", sequence: 1, status: "REVIEW_REQUIRED" }] },
      generations: [{ id: "generation-1", status: "COMPLETED" }],
    });
    const regenerateReply = await regenerate.service.handleTelegram({ telegramUserId: "976684739", chatId: "976684739", messageText: "/mywork" });
    assert.match(regenerateReply.text, /Canon references are not ready/i);
    assert.equal(regenerate.calls.some((call) => call.method === "action.create"), false);
    assert.equal(regenerate.calls.some((call) => call.method === "generation.list"), false);
  }
});

test("invalid canon leaves generate and regenerate callbacks unconsumed", async () => {
  for (const canonIssue of ["missing", "unlocked", "unavailable", "excess"] as const) {
    for (const [kind, payload] of [
      ["GENERATE_SHOT", { shotId: "shot-1", sequence: 1, actionGroup: "generation-1" }],
      ["REGENERATE_SHOT", { shotId: "shot-1", generationId: "generation-1", sequence: 1, actionGroup: "review-1" }],
    ] as const) {
      const { service, calls } = createActionService({
        action: { kind, payload },
        canonIssue,
        session: kind === "REGENERATE_SHOT" ? { step: "IDLE", data: { episodeId: "episode-1" } } : undefined,
        episode: kind === "REGENERATE_SHOT" ? { id: "episode-1", shots: [{ id: "shot-1", sequence: 1, status: "REVIEW_REQUIRED" }] } : undefined,
        generations: kind === "REGENERATE_SHOT" ? [{ id: "generation-1", status: "COMPLETED" }] : undefined,
      });
      const reply = await service.handleTelegram({ telegramUserId: "976684739", chatId: "976684739", callbackToken: "paid" });
      assert.match(reply.text, /Canon references are not ready/i);
      assert.deepEqual(calls.map((call) => call.method), kind === "REGENERATE_SHOT"
        ? ["action.lookup", "episode.get", "generation.list", "canon.ready"]
        : ["action.lookup", "canon.ready"]);
      assert.equal(calls.some((call) => call.method === "review.submit" || call.method === "generation.submit"), false);
    }
  }
});

test("post-consume generation and review failures are durable and private", async () => {
  for (const [action, options] of [
    [{ kind: "GENERATE_SHOT", payload: { shotId: "shot-1", sequence: 1, actionGroup: "generation-1" } }, { generationError: true }],
    [{ kind: "APPROVE_GENERATION", payload: { shotId: "shot-1", generationId: "generation-1", sequence: 1, actionGroup: "review-1" } }, { reviewError: true }],
    [{ kind: "REGENERATE_SHOT", payload: { shotId: "shot-1", generationId: "generation-1", sequence: 1, actionGroup: "review-1" } }, { reviewError: true }],
  ] as const) {
    const { service, calls } = createActionService({
      action,
      ...options,
      session: action.kind === "GENERATE_SHOT" ? undefined : { step: "IDLE", data: { episodeId: "episode-1" } },
      episode: action.kind === "GENERATE_SHOT" ? undefined : { id: "episode-1", shots: [{ id: "shot-1", sequence: 1, status: "REVIEW_REQUIRED" }] },
      generations: action.kind === "GENERATE_SHOT" ? undefined : [{ id: "generation-1", status: "COMPLETED" }],
    });
    const first = await service.handleTelegram({ telegramUserId: "976684739", chatId: "976684739", callbackToken: "paid" });
    const second = await service.handleTelegram({ telegramUserId: "976684739", chatId: "976684739", callbackToken: "paid" });
    assert.equal(first.text, second.text);
    assert.doesNotMatch(first.text, /provider|private|URL/i);
    assert.equal(calls.filter((call) => call.method === "action.updateResult").length, 1);
    assert.equal(calls.filter((call) => call.method === "generation.submit" || call.method === "review.submit").length, 1);
  }
});

test("a duplicate paid callback never submits twice", async () => {
  const { service, calls } = createActionService({
    action: { kind: "GENERATE_SHOT", payload: { shotId: "shot-1", sequence: 1, actionGroup: "generation-1" }, result: { text: "Generation already started." } },
    consumeStatus: "duplicate",
  });
  const reply = await service.handleTelegram({ telegramUserId: "976684739", chatId: "976684739", callbackToken: "generate" });
  assert.equal(reply.text, "Generation already started.");
  assert.deepEqual(calls.map((call) => call.method), ["action.lookup"]);
});

test("repeated my work generation buttons claim one deterministic shot group", async () => {
  const { service, calls, getCreatedActionTokens } = createActionService({
    action: { kind: "unused", payload: {} },
    session: { step: "IDLE", data: { episodeId: "episode-1" } },
    episode: { id: "episode-1", shots: [{ id: "shot-1", sequence: 1, status: "READY_TO_GENERATE" }] },
  });
  const firstMenu = await service.handleTelegram({ telegramUserId: "976684739", chatId: "976684739", messageText: "/mywork" });
  const secondMenu = await service.handleTelegram({ telegramUserId: "976684739", chatId: "976684739", messageText: "/mywork" });
  assert.match(firstMenu.text, /Generate shot/i);
  assert.match(secondMenu.text, /Generate shot/i);
  const [firstToken, secondToken] = getCreatedActionTokens();
  assert.ok(firstToken);
  assert.ok(secondToken);
  assert.notEqual(firstToken, secondToken);
  const created = calls.filter((call) => call.method === "action.create").map((call) => call.args[0] as { payload: { actionGroup: string } });
  assert.deepEqual(created.map((action) => action.payload.actionGroup), [
    "generation:976684739:episode-1:shot-1",
    "generation:976684739:episode-1:shot-1",
  ]);
  const first = await service.handleTelegram({ telegramUserId: "976684739", chatId: "976684739", callbackToken: firstToken });
  const second = await service.handleTelegram({ telegramUserId: "976684739", chatId: "976684739", callbackToken: secondToken });
  assert.match(first.text, /generation started/i);
  assert.match(second.text, /already handled/i);
  assert.equal(calls.filter((call) => call.method === "action.groupClaim").length, 1);
  assert.equal(calls.filter((call) => call.method === "generation.submit").length, 1);
});

test("repeated my work review menus claim one deterministic generation decision", async () => {
  const { service, calls, getCreatedActionTokens } = createActionService({
    action: { kind: "unused", payload: {} },
    session: { step: "IDLE", data: { episodeId: "episode-1" } },
    episode: { id: "episode-1", shots: [{ id: "shot-1", sequence: 1, status: "REVIEW_REQUIRED" }] },
    generations: [{ id: "generation-1", status: "COMPLETED" }],
  });
  await service.handleTelegram({ telegramUserId: "976684739", chatId: "976684739", messageText: "/mywork" });
  await service.handleTelegram({ telegramUserId: "976684739", chatId: "976684739", messageText: "/mywork" });
  const [firstApprove, , , secondRegenerate] = getCreatedActionTokens();
  assert.ok(firstApprove);
  assert.ok(secondRegenerate);
  const created = calls.filter((call) => call.method === "action.create").map((call) => call.args[0] as { payload: { actionGroup: string } });
  assert.deepEqual(created.map((action) => action.payload.actionGroup), [
    "review:976684739:episode-1:shot-1:generation-1",
    "review:976684739:episode-1:shot-1:generation-1",
    "review:976684739:episode-1:shot-1:generation-1",
    "review:976684739:episode-1:shot-1:generation-1",
  ]);
  const approved = await service.handleTelegram({ telegramUserId: "976684739", chatId: "976684739", callbackToken: firstApprove });
  const staleRegenerate = await service.handleTelegram({ telegramUserId: "976684739", chatId: "976684739", callbackToken: secondRegenerate });
  assert.match(approved.text, /approved/i);
  assert.match(staleRegenerate.text, /already handled/i);
  assert.deepEqual(calls.filter((call) => call.method === "review.submit").map((call) => (call.args[1] as { decision: string }).decision), ["APPROVE"]);
  assert.equal(calls.some((call) => call.method === "generation.submit"), false);
});

test("approve and regenerate use independent Core UUIDs", async () => {
  const reviewState = {
    session: { step: "IDLE", data: { episodeId: "episode-1" } },
    episode: { id: "episode-1", shots: [{ id: "shot-1", sequence: 1, status: "REVIEW_REQUIRED" }] },
    generations: [{ id: "generation-1", status: "COMPLETED" }],
  };
  const approve = createActionService({ ...reviewState, action: { kind: "APPROVE_GENERATION", payload: { shotId: "shot-1", generationId: "generation-1", sequence: 1, actionGroup: "approve-group" } } });
  await approve.service.handleTelegram({ telegramUserId: "976684739", chatId: "976684739", callbackToken: "approve" });
  const regenerated = createActionService({ ...reviewState, action: { kind: "REGENERATE_SHOT", payload: { shotId: "shot-1", generationId: "generation-1", sequence: 1, actionGroup: "regenerate-group" } } });
  await regenerated.service.handleTelegram({ telegramUserId: "976684739", chatId: "976684739", callbackToken: "regenerate" });
  const approveRequest = approve.calls.find((call) => call.method === "review.submit")?.args[1] as { requestId: string; decision: string };
  const regenerateStored = (regenerated.calls.find((call) => call.method === "action.groupClaim")?.args[0] as { result: { requestId: string; reviewRequestId: string } }).result;
  const regenerateReview = regenerated.calls.find((call) => call.method === "review.submit")?.args[1] as { requestId: string; decision: string };
  const regenerateRequest = regenerated.calls.find((call) => call.method === "generation.submit")?.args[1] as { requestId: string; profile: string };
  assert.deepEqual(approveRequest.decision, "APPROVE");
  assert.equal(regenerateReview.decision, "REGENERATE");
  assert.equal(regenerateRequest.profile, "DRAFT");
  assert.equal(regenerateReview.requestId, regenerateStored.reviewRequestId);
  assert.equal(regenerateRequest.requestId, regenerateStored.requestId);
  assert.notEqual(approveRequest.requestId, regenerateRequest.requestId);
  assert.equal(regenerated.calls.filter((call) => call.method === "action.groupClaim").length, 1);
});

test("approve then regenerate claims one review group without reverse review or paid submit", async () => {
  const actionGroup = "review-group";
  const { service, calls } = createActionService({
    action: { kind: "APPROVE_GENERATION", payload: { shotId: "shot-1", generationId: "generation-1", sequence: 1, actionGroup } },
    reviewActions: {
      approve: { kind: "APPROVE_GENERATION", payload: { shotId: "shot-1", generationId: "generation-1", sequence: 1, actionGroup } },
      regenerate: { kind: "REGENERATE_SHOT", payload: { shotId: "shot-1", generationId: "generation-1", sequence: 1, actionGroup } },
    },
    session: { step: "IDLE", data: { episodeId: "episode-1" } },
    episode: { id: "episode-1", shots: [{ id: "shot-1", sequence: 1, status: "REVIEW_REQUIRED" }] },
    generations: [{ id: "generation-1", status: "COMPLETED" }],
  });
  const approved = await service.handleTelegram({ telegramUserId: "976684739", chatId: "976684739", callbackToken: "approve" });
  const regenerated = await service.handleTelegram({ telegramUserId: "976684739", chatId: "976684739", callbackToken: "regenerate" });
  assert.match(approved.text, /approved/i);
  assert.match(regenerated.text, /already handled/i);
  assert.deepEqual(calls.filter((call) => call.method === "review.submit").map((call) => (call.args[1] as { decision: string }).decision), ["APPROVE"]);
  assert.equal(calls.some((call) => call.method === "generation.submit"), false);
});

test("regenerate then approve claims one review group without reverse approval", async () => {
  const actionGroup = "review-group";
  const { service, calls } = createActionService({
    action: { kind: "REGENERATE_SHOT", payload: { shotId: "shot-1", generationId: "generation-1", sequence: 1, actionGroup } },
    reviewActions: {
      approve: { kind: "APPROVE_GENERATION", payload: { shotId: "shot-1", generationId: "generation-1", sequence: 1, actionGroup } },
      regenerate: { kind: "REGENERATE_SHOT", payload: { shotId: "shot-1", generationId: "generation-1", sequence: 1, actionGroup } },
    },
    session: { step: "IDLE", data: { episodeId: "episode-1" } },
    episode: { id: "episode-1", shots: [{ id: "shot-1", sequence: 1, status: "REVIEW_REQUIRED" }] },
    generations: [{ id: "generation-1", status: "COMPLETED" }],
  });
  const regenerated = await service.handleTelegram({ telegramUserId: "976684739", chatId: "976684739", callbackToken: "regenerate" });
  const approved = await service.handleTelegram({ telegramUserId: "976684739", chatId: "976684739", callbackToken: "approve" });
  assert.match(regenerated.text, /generation started/i);
  assert.match(approved.text, /already handled/i);
  assert.deepEqual(calls.filter((call) => call.method === "review.submit").map((call) => (call.args[1] as { decision: string }).decision), ["REGENERATE"]);
  assert.equal(calls.filter((call) => call.method === "generation.submit").length, 1);
});

test("stale review token does not claim, review, or submit", async () => {
  const { service, calls } = createActionService({
    action: { kind: "REGENERATE_SHOT", payload: { shotId: "shot-1", generationId: "generation-1", sequence: 1, actionGroup: "review-group" } },
    currentReview: false,
    session: { step: "IDLE", data: { episodeId: "episode-1" } },
    episode: { id: "episode-1", shots: [{ id: "shot-1", sequence: 1, status: "REVIEW_REQUIRED" }] },
    generations: [{ id: "generation-1", status: "COMPLETED" }],
  });
  const reply = await service.handleTelegram({ telegramUserId: "976684739", chatId: "976684739", callbackToken: "stale" });
  assert.match(reply.text, /no longer current/i);
  assert.equal(calls.some((call) => call.method === "action.groupClaim" || call.method === "review.submit" || call.method === "generation.submit"), false);
});

test("my work returns review actions without leaking private generation data", async () => {
  const { service, calls } = createActionService({
    action: { kind: "unused", payload: {} },
    session: { step: "IDLE", data: { episodeId: "episode-1" } },
    episode: { id: "episode-1", shots: [{ id: "shot-1", sequence: 1, status: "REVIEW_REQUIRED" }, { id: "shot-2", sequence: 2, status: "READY_TO_GENERATE" }] },
    generations: [{ id: "generation-1", status: "COMPLETED", providerTaskId: "private", prompt: "private", outputAssetId: "private" }],
  });
  const reply = await service.handleTelegram({ telegramUserId: "976684739", chatId: "976684739", messageText: "/mywork" });
  assert.match(reply.text, /Shot 1.*review/i);
  assert.deepEqual(reply.inlineKeyboard?.map((row) => row[0]?.text), ["Approve shot", "Regenerate shot · est. $0.22"]);
  assert.doesNotMatch(JSON.stringify(reply), /private|generation-1|prompt/i);
  const approve = calls.filter((call) => call.method === "action.create")[0]?.args[0] as { payload: { actionGroup: string } };
  const regenerate = calls.filter((call) => call.method === "action.create")[1]?.args[0] as { payload: { generationId: string; actionGroup: string } };
  assert.equal(regenerate.payload.generationId, "generation-1");
  assert.equal(regenerate.payload.actionGroup, approve.payload.actionGroup);
});

test("my work reports an in-progress shot without unsafe actions", async () => {
  const { service } = createActionService({
    action: { kind: "unused", payload: {} },
    session: { step: "IDLE", data: { episodeId: "episode-1" } },
    episode: { id: "episode-1", shots: [{ id: "shot-1", sequence: 1, status: "GENERATING" }] },
  });
  const reply = await service.handleTelegram({ telegramUserId: "976684739", chatId: "976684739", messageText: "/mywork" });
  assert.match(reply.text, /generation is in progress/i);
  assert.equal(reply.inlineKeyboard, undefined);
});

test("offers render only after every shot is approved and audio is available", async () => {
  const ready = createActionService({
    action: { kind: "unused", payload: {} },
    session: { step: "IDLE", data: { episodeId: "episode-1", audioMasterAssetId: "audio-1" } },
    episode: { id: "episode-1", shots: [{ id: "shot-1", sequence: 1, status: "APPROVED" }] },
  });
  const reply = await ready.service.handleTelegram({ telegramUserId: "976684739", chatId: "976684739", messageText: "/mywork" });
  assert.deepEqual(reply.inlineKeyboard, [[{ text: "Render episode", callbackData: "rv:QUEUE_RENDER-token" }]]);
  assert.equal(ready.calls.some((call) => call.method === "render.create"), false);

  const missingAudio = createActionService({
    action: { kind: "unused", payload: {} },
    session: { step: "IDLE", data: { episodeId: "episode-1" } },
    episode: { id: "episode-1", shots: [{ id: "shot-1", sequence: 1, status: "APPROVED" }] },
  });
  assert.match((await missingAudio.service.handleTelegram({ telegramUserId: "976684739", chatId: "976684739", messageText: "/mywork" })).text, /add audio/i);
  assert.equal(missingAudio.calls.some((call) => call.method === "action.create"), false);
});

test("a render action is claimed before one queued render and duplicate callbacks do not queue twice", async () => {
  const { service, calls } = createActionService({
    action: { kind: "QUEUE_RENDER", payload: { episodeId: "episode-1", audioAssetId: "audio-1", actionGroup: "render:976684739:episode-1" } },
    session: { step: "IDLE", data: { episodeId: "episode-1", audioMasterAssetId: "audio-1" } },
    episode: { id: "episode-1", shots: [{ id: "shot-1", sequence: 1, status: "APPROVED" }] },
  });
  const first = await service.handleTelegram({ telegramUserId: "976684739", chatId: "976684739", callbackToken: "render" });
  const second = await service.handleTelegram({ telegramUserId: "976684739", chatId: "976684739", callbackToken: "render" });
  assert.match(first.text, /queued/i);
  assert.match(second.text, /already accepted/i);
  const claim = calls.findIndex((call) => call.method === "action.groupClaim");
  const render = calls.findIndex((call) => call.method === "render.create");
  assert.equal(claim < render, true);
  const stored = (calls[claim]?.args[0] as { result: { requestId: string } }).result.requestId;
  assert.match(stored, /^[0-9a-f-]{36}$/i);
  assert.equal((calls[render]?.args[1] as { requestId: string }).requestId, stored);
  assert.equal(calls.filter((call) => call.method === "render.create").length, 1);
});

test("my work resumes an incomplete confirmation without generation work", async () => {
  const { service, calls } = createActionService({
    action: { kind: "unused", payload: {} },
    session: { step: "DRAFT_READY", data: { ...draft, episodeId: "episode-1", confirmationStage: "CREATED" } },
  });
  const reply = await service.handleTelegram({ telegramUserId: "976684739", chatId: "976684739", messageText: "/mywork" });
  assert.deepEqual(reply.inlineKeyboard, [[{ text: "Retry confirmation", callbackData: "rv:CONFIRM_DRAFT-token" }]]);
  assert.deepEqual(calls.map((call) => call.method), ["action.create"]);
  assert.equal((calls[0]?.args[0] as { kind: string }).kind, "CONFIRM_DRAFT");
});

test("a completed canon upload offers one opaque lock action that makes the canon reusable", async () => {
  let session: Session = { step: "IDLE", data: { pendingCanonLockVersionId: "canon-version-1" } };
  const calls: string[] = [];
  const repository = {
    findSession: async () => session,
    createAction: async () => ({ token: "lock-token" }),
    findPendingButtonAction: async () => ({ status: "pending" as const, action: { kind: "LOCK_CANON", payload: { canonVersionId: "canon-version-1", actionGroup: "canon-lock:976684739:canon-version-1" } } }),
    claimActionGroup: async () => ({ status: "consumed" as const, action: { kind: "LOCK_CANON", payload: { canonVersionId: "canon-version-1", actionGroup: "canon-lock:976684739:canon-version-1" } }, result: { text: "accepted" } }),
    upsertSession: async (input: Session) => { session = input; calls.push("session"); return input; },
  };
  const canon = {
    lockVersion: async () => { calls.push("lock"); return {}; },
  };
  const Constructor = CreatorService as unknown as new (...args: unknown[]) => CreatorService;
  const service = new Constructor(repository, undefined, undefined, undefined, undefined, undefined, undefined, canon);
  const menu = await service.handleTelegram({ telegramUserId: "976684739", chatId: "976684739", messageText: "/mywork" });
  assert.deepEqual(menu.inlineKeyboard, [[{ text: "Lock canon", callbackData: "rv:lock-token" }]]);
  const locked = await service.handleTelegram({ telegramUserId: "976684739", chatId: "976684739", callbackToken: "lock-token" });
  assert.match(locked.text, /ready to reuse/i);
  assert.deepEqual(calls, ["lock", "session"]);
  assert.equal("pendingCanonLockVersionId" in session.data, false);
});
