import * as assert from "node:assert/strict";
import { test } from "node:test";
import { BadRequestException } from "@nestjs/common";
import { CreatorService } from "./creator.service";
import { CreatorRepository } from "./creator.repository";
import { CreatorCreativeService } from "./creator-creative.service";
import type { CreatorTelegramReply, CreatorTelegramRequest } from "./dto/creator.dto";

test("delegates authorized Telegram updates before legacy routing", async () => {
  const calls: string[] = [];
  const repository = {
    upsertSession: async () => { calls.push("legacy"); return {}; },
  };
  const creative = {
    handle: async (request: CreatorTelegramRequest): Promise<CreatorTelegramReply> => {
      calls.push(`creative:${request.updateId}`);
      return { text: "Handled by creative intake." };
    },
  };
  const Constructor = CreatorService as unknown as new (...args: unknown[]) => CreatorService;
  const service = new Constructor(repository, ...Array(9).fill(undefined), creative);

  const denied = await service.handleTelegram({ telegramUserId: "1", chatId: "1", updateId: "7", messageText: "/new" });
  assert.match(denied.text, /not available/i);
  assert.deepEqual(calls, []);

  const allowed = await service.handleTelegram({ telegramUserId: "976684739", chatId: "976684739", updateId: "7", messageText: "/new" });
  assert.deepEqual(allowed, { text: "Handled by creative intake." });
  assert.deepEqual(calls, ["creative:7"]);
});

test("routes legacy creator commands outside an enabled creative intake", async () => {
  await withCreativeEnabled(async () => {
    const owner = "976684739";
    let session: TestSession = { id: "session-legacy", telegramUserId: owner, step: "NEW_TITLE", data: {} };
    let creativeCalls = 0;
    const creativeRepository = {
      findTelegramReceipt: async () => null,
      findSession: async () => session,
      withTelegramReceipt: async () => {
        creativeCalls += 1;
        return { text: "Captured by creative intake." };
      },
    };
    const Constructor = CreatorService as unknown as new (...args: unknown[]) => CreatorService;
    const legacyRepository = {
      findSession: async () => session,
      upsertSession: async (input: { step: string; data: Record<string, unknown> }) => {
        session = { ...session, ...input };
        return session;
      },
    };
    const creative = new CreatorCreativeService(creativeRepository as never, {} as never);
    const service = new Constructor(legacyRepository, ...Array(9).fill(undefined), creative);
    const commands = [
      { text: "/start", expected: /creator ready/i },
      { text: "/canon", expected: /canon details/i },
      { text: "/audio", expected: /confirm an episode/i },
    ];

    for (const [index, command] of commands.entries()) {
      session = { id: "session-legacy", telegramUserId: owner, step: "NEW_TITLE", data: {} };
      const reply = await service.handleTelegram({
        telegramUserId: owner,
        chatId: owner,
        updateId: String(300 + index),
        messageText: command.text,
      });
      assert.match(reply.text, command.expected);
    }

    assert.equal(creativeCalls, 0);
  });
});

test("replays the canon update after Manual selection moves routing to NEW_SHOT_DIRECTIONS", async () => {
  await withCreativeEnabled(async () => {
    const owner = "976684739";
    const savedReply: CreatorTelegramReply = {
      text: "Codex drafts support 4 to 120 seconds in whole 4-second increments. Choose how to draft the episode:",
      inlineKeyboard: [[{ text: "Draft with Codex — uses AI quota", callbackData: "rv:codex-token" }]],
    };
    let receiptReads = 0;
    let sessionReads = 0;
    let legacyWrites = 0;
    const session: TestSession = {
      id: "session-manual",
      telegramUserId: owner,
      step: "NEW_SHOT_DIRECTIONS",
      data: { duration: "4", draftMode: "MANUAL", shotDirections: [] },
    };
    const creativeRepository = {
      findTelegramReceipt: async () => {
        receiptReads += 1;
        return savedReply;
      },
      findSession: async () => {
        sessionReads += 1;
        return session;
      },
    };
    const legacyRepository = {
      findSession: async () => session,
      upsertSession: async () => {
        legacyWrites += 1;
        return session;
      },
    };
    const creative = new CreatorCreativeService(creativeRepository as never, {} as never);
    const Constructor = CreatorService as unknown as new (...args: unknown[]) => CreatorService;
    const service = new Constructor(legacyRepository, ...Array(9).fill(undefined), creative);

    const reply = await service.handleTelegram({
      telegramUserId: owner,
      chatId: owner,
      updateId: "manual-canon-update",
      messageText: "CASTLE",
    });

    assert.deepEqual(reply, savedReply);
    assert.equal(receiptReads, 1);
    assert.equal(sessionReads, 0);
    assert.equal(legacyWrites, 0);
  });
});

test("requires updateId before an enabled creative /new can write", async () => {
  await withCreativeEnabled(async () => {
    const { service, calls } = createCreativeService(null);
    await assert.rejects(
      () => service.handle({ telegramUserId: "1", chatId: "1", messageText: "/new" }),
      BadRequestException,
    );
    assert.deepEqual(calls, []);
  });
});

test("creative intake advances the shared brief step atomically", async () => {
  await withCreativeEnabled(async () => {
    const { service, calls, getSession } = createCreativeService({
      id: "session-1",
      telegramUserId: "1",
      step: "NEW_TITLE",
      data: { shotDirections: [] },
    });

    const reply = await service.handle({ telegramUserId: "1", chatId: "1", updateId: "8", messageText: "Sharing" });

    assert.match(reply?.text ?? "", /duration/i);
    assert.equal(getSession()?.step, "NEW_DURATION");
    assert.equal(getSession()?.data.title, "Sharing");
    assert.deepEqual(calls, ["receipt.begin", "session.update", "receipt.commit"]);
  });
});

test("offers Codex and manual modes after canon selection, including an empty canon", async () => {
  await withCreativeEnabled(async () => {
    const { service, getSession } = createCreativeService({
      id: "session-1",
      telegramUserId: "1",
      step: "NEW_CANON_CODES",
      data: {
        title: "Sharing",
        duration: "4",
        premise: "Two friends share a toy.",
        learningGoal: "Taking turns",
        tone: "Warm",
        shotDirections: [],
      },
    });

    const reply = await service.handle({ telegramUserId: "1", chatId: "1", updateId: "9", messageText: "" });

    assert.match(reply?.text ?? "", /4 to 120 seconds/i);
    assert.deepEqual(reply?.inlineKeyboard?.map((row) => row[0]?.text), [
      "Draft with Codex — uses AI quota",
      "Write shots myself",
    ]);
    assert.equal(getSession()?.step, "NEW_DRAFT_MODE");
    assert.deepEqual(getSession()?.data.canonCodes, []);
  });
});

test("choosing Draft with Codex creates one queued job and advances to review", async () => {
  await withCreativeEnabled(async () => {
    const { service, getSession, getJobs } = createCreativeService({
      id: "session-1",
      telegramUserId: "1",
      step: "NEW_DRAFT_MODE",
      data: {
        title: "Sharing",
        duration: "8",
        premise: "Two friends share a toy.",
        learningGoal: "Taking turns",
        tone: "Warm",
        canonCodes: [],
        shotDirections: [],
      },
    });
    const menu = await service.handle({ telegramUserId: "1", chatId: "1", updateId: "10", messageText: "" });
    const draftButton = menu?.inlineKeyboard?.flat().find((button) => button.text === "Draft with Codex — uses AI quota");
    assert.ok(draftButton && "callbackData" in draftButton);

    const reply = await service.handle({
      telegramUserId: "1",
      chatId: "1",
      updateId: "11",
      callbackToken: draftButton.callbackData.slice(3),
    });

    assert.equal(getJobs().length, 1);
    assert.equal(getJobs()[0]?.input.inputRevision, 1);
    assert.equal(getSession()?.step, "CREATIVE_REVIEW");
    assert.equal(getSession()?.data.creativeJobId, "job-1");
    assert.deepEqual(reply?.creativeJob, { id: "job-1", action: "DISPATCH" });
  });
});

test("an old Codex button after /new cannot return dispatch metadata", async () => {
  await withCreativeEnabled(async () => {
    const { service, getJobs } = createCreativeService({
      id: "session-1",
      telegramUserId: "1",
      step: "NEW_DRAFT_MODE",
      data: {
        title: "Sharing",
        duration: "8",
        premise: "Two friends share a toy.",
        learningGoal: "Taking turns",
        tone: "Warm",
        canonCodes: [],
        shotDirections: [],
      },
    });
    const menu = await service.handle({ telegramUserId: "1", chatId: "1", updateId: "20", messageText: "" });
    const draftButton = menu?.inlineKeyboard?.flat().find((button) => button.text === "Draft with Codex — uses AI quota");
    assert.ok(draftButton && "callbackData" in draftButton);
    const token = draftButton.callbackData.slice(3);

    const queued = await service.handle({ telegramUserId: "1", chatId: "1", updateId: "21", callbackToken: token });
    assert.deepEqual(queued?.creativeJob, { id: "job-1", action: "DISPATCH" });
    await service.handle({ telegramUserId: "1", chatId: "1", updateId: "22", messageText: "/new" });

    const stale = await service.handle({ telegramUserId: "1", chatId: "1", updateId: "23", callbackToken: token });

    assert.match(stale?.text ?? "", /no longer current/i);
    assert.equal(stale?.creativeJob, undefined);
    assert.equal(getJobs().length, 1);
  });
});

test("preserves long-duration briefs for manual intake when Codex duration exceeds its cap", async () => {
  await withCreativeEnabled(async () => {
    const { service, getSession, getJobs, getActionStates } = createCreativeService({
      id: "session-1",
      telegramUserId: "1",
      step: "NEW_DRAFT_MODE",
      data: {
        title: "Sharing",
        duration: "3600",
        premise: "Two friends share a toy.",
        learningGoal: "Taking turns",
        tone: "Warm",
        canonCodes: [],
        shotDirections: [],
      },
    });
    const menu = await service.handle({ telegramUserId: "1", chatId: "1", updateId: "12", messageText: "" });
    const buttons = menu?.inlineKeyboard?.flat() ?? [];
    const draftButton = buttons.find((button) => button.text === "Draft with Codex — uses AI quota");
    const manualButton = buttons.find((button) => button.text === "Write shots myself");
    assert.ok(draftButton && "callbackData" in draftButton);
    assert.ok(manualButton && "callbackData" in manualButton);

    const rejected = await service.handle({
      telegramUserId: "1",
      chatId: "1",
      updateId: "13",
      callbackToken: draftButton.callbackData.slice(3),
    });
    assert.match(rejected?.text ?? "", /4 to 120 seconds/i);
    assert.equal(getJobs().length, 0);
    assert.equal(getSession()?.step, "NEW_DRAFT_MODE");
    assert.equal(getActionStates().get(draftButton.callbackData.slice(3)), "pending");

    const manual = await service.handle({
      telegramUserId: "1",
      chatId: "1",
      updateId: "14",
      callbackToken: manualButton.callbackData.slice(3),
    });
    assert.match(manual?.text ?? "", /manual shot direction/i);
    assert.equal(getSession()?.step, "NEW_SHOT_DIRECTIONS");
    assert.equal(getSession()?.data.duration, "3600");
    assert.equal(getJobs().length, 0);
  });
});

test("legacy manual intake still accepts its 3600-second ceiling", async () => {
  let session = { step: "NEW_DURATION", data: { shotDirections: [] as string[] } };
  const repository = {
    findSession: async () => session,
    upsertSession: async (input: typeof session) => { session = input; return input; },
  };
  const service = new CreatorService(repository as never);

  const reply = await service.handleTelegram({ telegramUserId: "976684739", chatId: "976684739", messageText: "3600" });

  assert.match(reply.text, /premise/i);
  assert.equal(session.step, "NEW_PREMISE");
});

test("retries receipt transactions after raw-query SQLSTATE 40001 errors", async () => {
  for (const error of [
    { code: "40001" },
    { code: "P2010", meta: { code: "40001" } },
    { message: "Raw query failed. Code: `40001`." },
  ]) {
    const fixture = createReceiptRetryRepository([error, error]);
    const retryDelays: number[] = [];
    const originalSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((callback: () => void, delay = 0) => {
      retryDelays.push(delay);
      queueMicrotask(callback);
      return 0;
    }) as typeof globalThis.setTimeout;
    let response: CreatorTelegramReply | null;
    try {
      response = await fixture.repository.withTelegramReceipt({
        botId: "test-bot",
        updateId: "100",
        telegramUserId: "1",
        chatId: "1",
        requestHash: "a".repeat(64),
      }, async (tx) => {
        await fixture.repository.lockSession(tx, "1");
        return { text: "Saved once." };
      });
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }

    assert.deepEqual(response, { text: "Saved once." });
    assert.deepEqual(retryDelays, [50, 100]);
    assert.equal(fixture.getRawQueryAttempts(), 3);
    assert.equal(fixture.getCreatedReceipt()?.updateId, "100");
  }
});

test("caps receipt retries at three raw-query SQLSTATE 40001 failures", async () => {
  const error = { code: "40001" };
  const fixture = createReceiptRetryRepository([error, error, error, error]);

  await assert.rejects(() => fixture.repository.withTelegramReceipt({
    botId: "test-bot",
    updateId: "101",
    telegramUserId: "1",
    chatId: "1",
    requestHash: "b".repeat(64),
  }, async (tx) => {
    await fixture.repository.lockSession(tx, "1");
    return { text: "Never committed." };
  }));

  assert.equal(fixture.getRawQueryAttempts(), 3);
  assert.equal(fixture.getCreatedReceipt(), null);
});

test("reconciles an expired running job to outcome-unknown before returning it", async () => {
  const job: {
    id: string;
    telegramUserId: string;
    status: string;
    leaseExpiresAt: Date | null;
    supersededAt: Date | null;
  } = {
    id: "job-1",
    telegramUserId: "1",
    status: "RUNNING",
    leaseExpiresAt: new Date(0),
    supersededAt: null,
  };
  const updates: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }> = [];
  const transaction = {
    rovelleCreativeJob: {
      updateMany: async (input: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        updates.push(input);
        const leaseExpiresAt = input.where.leaseExpiresAt as { lte: Date };
        const expiresAt = job.leaseExpiresAt;
        if (job.status === "RUNNING" && expiresAt !== null && expiresAt <= leaseExpiresAt.lte) {
          job.status = input.data.status as string;
          job.leaseExpiresAt = input.data.leaseExpiresAt as null;
          return { count: 1 };
        }
        return { count: 0 };
      },
      findFirst: async () => ({ ...job }),
    },
  };
  const repository = new CreatorRepository({} as never);

  const current = await repository.findCreativeJobInTransaction(transaction as never, {
    id: "job-1",
    telegramUserId: "1",
  });

  assert.equal(current?.status, "OUTCOME_UNKNOWN");
  assert.equal(current?.leaseExpiresAt, null);
  assert.equal(updates.length, 1);
  assert.equal(updates[0]?.where.status, "RUNNING");
  assert.equal((updates[0]?.where.leaseExpiresAt as { lte: Date }).lte instanceof Date, true);
  assert.equal(updates[0]?.data.status, "OUTCOME_UNKNOWN");
  assert.equal(updates[0]?.data.leaseExpiresAt, null);
});

type TestSession = { id: string; telegramUserId: string; step: string; data: Record<string, unknown> };

function createCreativeService(initial: TestSession | null) {
  let session = initial;
  const calls: string[] = [];
  const actions = new Map<string, { token: string; kind: string; payload: Record<string, unknown>; consumedAt: Date | null; result: CreatorTelegramReply | null }>();
  const jobs: Array<{
    input: Record<string, unknown>;
    id: string;
    telegramUserId: string;
    status: string;
    leaseExpiresAt: Date | null;
    supersededAt: Date | null;
  }> = [];
  const actionStates = new Map<string, string>();
  const repository = {
    findSession: async () => session,
    findTelegramReceipt: async () => null,
    withTelegramReceipt: async (_input: unknown, operation: (tx: unknown) => Promise<CreatorTelegramReply | null>) => {
      calls.push("receipt.begin");
      const result = await operation({});
      if (result) calls.push("receipt.commit");
      return result;
    },
    lockSession: async () => session ?? { id: "session-1", telegramUserId: "1", step: "IDLE", data: {} },
    saveSession: async (_tx: unknown, input: Omit<TestSession, "id">) => {
      calls.push("session.update");
      session = { id: session?.id ?? "session-1", ...input };
      return session;
    },
    createActionInTransaction: async (_tx: unknown, input: Record<string, unknown>) => {
      const token = `token-${String(input.kind)}-${actions.size + 1}`;
      const action = {
        token,
        telegramUserId: input.telegramUserId as string,
        kind: input.kind as string,
        payload: input.payload as Record<string, unknown>,
        consumedAt: null,
        result: null,
      };
      actions.set(token, action);
      actionStates.set(token, "pending");
      return action;
    },
    findCreativeModeActionsInTransaction: async (_tx: unknown, input: { telegramUserId: string; actionGroup: string }) =>
      [...actions.values()].filter((action) => action.payload.actionGroup === input.actionGroup && action.consumedAt === null),
    findActionInTransaction: async (_tx: unknown, token: string) => actions.get(token) ?? null,
    consumeCreativeModeActions: async (_tx: unknown, input: Record<string, unknown>) => {
      const action = actions.get(input.token as string);
      if (!action || action.consumedAt) return { status: "duplicate", action, result: action?.result };
      const actionGroup = action.payload.actionGroup;
      for (const candidate of actions.values()) {
        if (candidate.payload.actionGroup === actionGroup) {
          candidate.consumedAt = new Date();
          candidate.result = candidate.token === action.token
            ? input.result as CreatorTelegramReply
            : input.siblingResult as CreatorTelegramReply;
          actionStates.set(candidate.token, "consumed");
        }
      }
      return { status: "consumed", action, result: input.result };
    },
    findLockedCanonVersions: async () => [],
    createQueued: async (_tx: unknown, input: { input: Record<string, unknown> }) => {
      const job = {
        id: "job-1",
        input: input.input,
        telegramUserId: "1",
        status: "QUEUED",
        leaseExpiresAt: null,
        supersededAt: null,
      };
      jobs.push(job);
      calls.push("job.create");
      return job;
    },
    findCreativeJobInTransaction: async (_tx: unknown, input: { id: string; telegramUserId: string }) =>
      jobs.find((job) => job.id === input.id && job.telegramUserId === input.telegramUserId) ?? null,
    findActiveCreativeJobInTransaction: async (_tx: unknown, telegramUserId: string) =>
      jobs.find((job) => job.telegramUserId === telegramUserId && ["QUEUED", "RUNNING", "OUTCOME_UNKNOWN"].includes(job.status) && job.supersededAt === null) ?? null,
    supersedeCreativeJob: async (_tx: unknown, job: typeof jobs[number]) => {
      job.status = "FAILED";
      job.supersededAt = new Date();
    },
    invalidateCreativeActions: async () => {
      for (const action of actions.values()) {
        if (action.kind.startsWith("CREATIVE_") && !action.consumedAt) {
          action.consumedAt = new Date();
          action.result = { text: "That creative action is no longer current." };
        }
      }
    },
    findAction: async (token: string, _telegramUserId: string) => actions.get(token) ?? null,
  };
  const Constructor = CreatorCreativeService as unknown as new (...args: unknown[]) => CreatorCreativeService;
  return {
    service: new Constructor(repository, repository),
    calls,
    getSession: () => session,
    getJobs: () => jobs,
    getActionStates: () => actionStates,
  };
}

function createReceiptRetryRepository(errors: unknown[]) {
  let rawQueryAttempts = 0;
  let createdReceipt: Record<string, unknown> | null = null;
  const session = { id: "session-1", telegramUserId: "1", step: "IDLE", data: {} };
  const transaction = {
    rovelleTelegramReceipt: {
      findUnique: async () => null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        createdReceipt = data;
        return data;
      },
    },
    rovelleCreatorSession: {
      upsert: async () => session,
      findUniqueOrThrow: async () => session,
    },
    $queryRaw: async () => {
      const error = errors[rawQueryAttempts];
      rawQueryAttempts += 1;
      if (error) throw error;
      return [];
    },
  };
  const prisma = {
    client: {
      $transaction: async <T>(operation: (tx: typeof transaction) => Promise<T>) => operation(transaction),
    },
  };
  return {
    repository: new CreatorRepository(prisma as never),
    getRawQueryAttempts: () => rawQueryAttempts,
    getCreatedReceipt: () => createdReceipt,
  };
}

async function withCreativeEnabled<T>(run: () => Promise<T>): Promise<T> {
  const oldEnabled = process.env.ROVELLE_CREATIVE_ENABLED;
  const oldBotId = process.env.ROVELLE_TELEGRAM_BOT_ID;
  process.env.ROVELLE_CREATIVE_ENABLED = "true";
  process.env.ROVELLE_TELEGRAM_BOT_ID = "test-bot";
  try {
    return await run();
  } finally {
    restoreEnv("ROVELLE_CREATIVE_ENABLED", oldEnabled);
    restoreEnv("ROVELLE_TELEGRAM_BOT_ID", oldBotId);
  }
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
