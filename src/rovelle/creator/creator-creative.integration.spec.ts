import * as assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, afterEach, before, test } from "node:test";
import { ConflictException } from "@nestjs/common";
import { PrismaService } from "../../database/prisma.service";
import {
  Prisma,
  RovelleCanonEntityType,
  RovelleCanonVersionStatus,
  RovelleCreativeJobStatus,
} from "../../generated/prisma/client";
import { creativeInput, creativeResult } from "../creative/creative.fixture";
import { CreativeRepository } from "../creative/creative.repository";
import type { CreativeInput } from "../creative/dto/creative.dto";
import { CreatorCreativeService } from "./creator-creative.service";
import { CreatorRepository } from "./creator.repository";
import { CreatorService } from "./creator.service";
import { normalizeCreatorTelegramRequest } from "./creator-validation";
import type { CreatorTelegramReply, CreatorTelegramRequest } from "./dto/creator.dto";

const testDatabaseUrl = process.env.ROVELLE_TEST_DATABASE_URL;
const originalDatabaseUrl = process.env.DATABASE_URL;
const originalCreativeEnabled = process.env.ROVELLE_CREATIVE_ENABLED;
const originalTelegramBotId = process.env.ROVELLE_TELEGRAM_BOT_ID;
const telegramUserId = "976684739";
const testBotId = "phase3a-test-bot";

let prisma: PrismaService | undefined;
let creatorRepository: CreatorRepository;
let creativeRepository: CreativeRepository;
let creativeService: CreatorCreativeService;
let creatorService: CreatorService;
let updateCounter = 0;
const sessionIds: string[] = [];
const creativeJobIds: string[] = [];
const actionTokens: string[] = [];
const canonEntityIds: string[] = [];
const canonVersionIds: string[] = [];
const receiptUpdateIds: string[] = [];

before(async () => {
  if (!testDatabaseUrl || process.env.ROVELLE_TEST_DATABASE_DISPOSABLE !== "true") {
    throw new Error(
      "ROVELLE_TEST_DATABASE_URL and ROVELLE_TEST_DATABASE_DISPOSABLE=true are required for the verified disposable phase3a database",
    );
  }
  process.env.DATABASE_URL = testDatabaseUrl;
  process.env.ROVELLE_CREATIVE_ENABLED = "true";
  process.env.ROVELLE_TELEGRAM_BOT_ID = testBotId;
  prisma = new PrismaService();
  creatorRepository = new CreatorRepository(prisma);
  creativeRepository = new CreativeRepository(prisma);
  const CreativeConstructor = CreatorCreativeService as unknown as new (...args: unknown[]) => CreatorCreativeService;
  creativeService = new CreativeConstructor(creatorRepository, creativeRepository);
  creatorService = new CreatorService(
    creatorRepository,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    creativeService,
  );
  const [database] = await prisma.client.$queryRaw<Array<{ database_name: string }>>`
    SELECT current_database() AS database_name
  `;
  assert.equal(database?.database_name, "rovelle_phase3a", "Refusing cleanup unless current_database() is exactly rovelle_phase3a");
  await cleanupTestUserFixtures();
});

async function cleanupTestUserFixtures(): Promise<void> {
  const client = prisma!.client;
  await client.rovelleTelegramReceipt.deleteMany({ where: { botId: testBotId, telegramUserId } });
  await client.rovelleCreatorAction.deleteMany({ where: { telegramUserId } });
  await client.rovelleCreativeJob.deleteMany({ where: { telegramUserId } });
  await client.rovelleCreatorSession.deleteMany({ where: { telegramUserId } });
}

afterEach(async () => {
  if (!prisma) return;
  const client = prisma.client;
  if (receiptUpdateIds.length) {
    await client.rovelleTelegramReceipt.deleteMany({
      where: { botId: testBotId, updateId: { in: receiptUpdateIds.splice(0) } },
    });
  }
  if (actionTokens.length) {
    await client.rovelleCreatorAction.deleteMany({ where: { token: { in: actionTokens.splice(0) } } });
  }
  if (creativeJobIds.length) {
    await client.rovelleCreativeJob.deleteMany({ where: { id: { in: creativeJobIds.splice(0) } } });
  }
  if (sessionIds.length) {
    await client.rovelleCreativeJob.deleteMany({ where: { creatorSessionId: { in: sessionIds } } });
    await client.rovelleCreatorSession.deleteMany({ where: { id: { in: sessionIds.splice(0) } } });
  }
  if (canonVersionIds.length) {
    await client.rovelleCanonVersion.deleteMany({ where: { id: { in: canonVersionIds.splice(0) } } });
  }
  if (canonEntityIds.length) {
    await client.rovelleCanonEntity.deleteMany({ where: { id: { in: canonEntityIds.splice(0) } } });
  }
});

after(async () => {
  await prisma?.onModuleDestroy();
  restoreEnv("DATABASE_URL", originalDatabaseUrl);
  restoreEnv("ROVELLE_CREATIVE_ENABLED", originalCreativeEnabled);
  restoreEnv("ROVELLE_TELEGRAM_BOT_ID", originalTelegramBotId);
});

test("duplicate title delivery leaves the answer in NEW_DURATION and stores one receipt", async () => {
  await createSession("NEW_TITLE", { shotDirections: [] });
  const request = message("Sharing");

  const first = await creatorService.handleTelegram(request);
  const replay = await creatorService.handleTelegram(request);

  assert.deepEqual(replay, first);
  assert.match(first.text, /duration/i);
  const session = await prisma!.client.rovelleCreatorSession.findUniqueOrThrow({
    where: { telegramUserId },
  });
  assert.equal(session.step, "NEW_DURATION");
  assert.equal((session.data as Record<string, unknown>).title, "Sharing");
  assert.equal("duration" in (session.data as Record<string, unknown>), false);
  assert.equal(
    await prisma!.client.rovelleTelegramReceipt.count({
      where: { botId: testBotId, updateId: request.updateId },
    }),
    1,
  );
});

test("rejects changed text for a previously received Telegram update", async () => {
  await createSession("NEW_TITLE", { shotDirections: [] });
  const request = message("Sharing");
  await creatorService.handleTelegram(request);

  await assert.rejects(
    () => creatorService.handleTelegram({ ...request, messageText: "Different title" }),
    ConflictException,
  );
  const session = await prisma!.client.rovelleCreatorSession.findUniqueOrThrow({
    where: { telegramUserId },
  });
  assert.equal((session.data as Record<string, unknown>).title, "Sharing");
});

test("concurrent Draft clicks create one job with the exact locked canon snapshot", async () => {
  const code = `TEST_${randomUUID().slice(0, 8).toUpperCase()}`;
  const entity = await prisma!.client.rovelleCanonEntity.create({
    data: {
      code,
      displayName: "Locked Koko",
      entityType: RovelleCanonEntityType.CHARACTER,
    },
  });
  canonEntityIds.push(entity.id);
  const lockedDefinition = { description: "The approved character." };
  const locked = await prisma!.client.rovelleCanonVersion.create({
    data: {
      entityId: entity.id,
      version: 1,
      status: RovelleCanonVersionStatus.LOCKED,
      lockedAt: new Date(),
      definition: lockedDefinition,
    },
  });
  canonVersionIds.push(locked.id);
  const draft = await prisma!.client.rovelleCanonVersion.create({
    data: {
      entityId: entity.id,
      version: 2,
      status: RovelleCanonVersionStatus.DRAFT,
      definition: { description: "An unapproved replacement." },
    },
  });
  canonVersionIds.push(draft.id);
  await createSession("NEW_CANON_CODES", {
    title: "Sharing",
    duration: "4",
    premise: "Two friends share a toy.",
    learningGoal: "Taking turns",
    tone: "Warm",
    shotDirections: [],
  });

  const menu = await creatorService.handleTelegram(message(code));
  const draftButton = menu.inlineKeyboard?.flat().find((button) => button.text === "Draft with Codex — uses AI quota");
  assert.ok(draftButton && "callbackData" in draftButton);
  actionTokens.push(...(menu.inlineKeyboard ?? []).flat().flatMap((button) =>
    "callbackData" in button ? [button.callbackData.slice(3)] : [],
  ));
  const firstUpdate = callback(draftButton.callbackData);
  const secondUpdate = callback(draftButton.callbackData);

  const replies = await Promise.all([
    creatorService.handleTelegram(firstUpdate),
    creatorService.handleTelegram(secondUpdate),
  ]);

  assert.deepEqual(replies[1], replies[0]);
  const dispatch = (replies[0] as CreatorTelegramReply & { creativeJob?: { id: string; action: "DISPATCH" } }).creativeJob;
  assert.ok(dispatch);
  assert.equal(dispatch.action, "DISPATCH");
  const jobs = await prisma!.client.rovelleCreativeJob.findMany({
    where: { telegramUserId, inputRevision: 1 },
  });
  assert.equal(jobs.length, 1);
  creativeJobIds.push(jobs[0]!.id);
  const input = jobs[0]!.input as unknown as CreativeInput;
  assert.deepEqual(input.canon, [{ entityId: entity.id, versionId: locked.id, code, definition: lockedDefinition }]);
  assert.notEqual(input.canon[0]?.versionId, draft.id);
  assert.equal(
    await prisma!.client.rovelleTelegramReceipt.count({
      where: { botId: testBotId, updateId: { in: [firstUpdate.updateId!, secondUpdate.updateId!] } },
    }),
    2,
  );
});

test("a caller-supplied bot identity cannot replace the configured identity", async () => {
  await createSession("NEW_TITLE", { shotDirections: [] });
  const request = Object.assign(message("Sharing"), { botId: "caller-controlled-bot" });

  await creatorService.handleTelegram(request);

  assert.equal(
    await prisma!.client.rovelleTelegramReceipt.count({
      where: { botId: testBotId, updateId: request.updateId },
    }),
    1,
  );
  assert.equal(
    await prisma!.client.rovelleTelegramReceipt.count({
      where: { botId: "caller-controlled-bot", updateId: request.updateId },
    }),
    0,
  );
});

test("a receipt failure rolls back the session advancement", async () => {
  await createSession("NEW_TITLE", { shotDirections: [] });
  const request = message("Sharing");
  const receiptRepository = creatorRepository as unknown as {
    createTelegramReceipt: (...args: unknown[]) => Promise<unknown>;
  };
  const original = receiptRepository.createTelegramReceipt.bind(creatorRepository);
  receiptRepository.createTelegramReceipt = async (..._args: unknown[]) => {
    throw new Error("injected receipt failure");
  };
  try {
    await assert.rejects(() => creatorService.handleTelegram(request), /injected receipt failure/);
  } finally {
    receiptRepository.createTelegramReceipt = original;
  }

  const session = await prisma!.client.rovelleCreatorSession.findUniqueOrThrow({
    where: { telegramUserId },
  });
  assert.equal(session.step, "NEW_TITLE");
  assert.equal(
    await prisma!.client.rovelleTelegramReceipt.count({
      where: { botId: testBotId, updateId: request.updateId },
    }),
    0,
  );
});

test("a changed brief supersedes saved results and invalidates their buttons", async () => {
  const session = await createSession("CREATIVE_REVIEW", { creativeInputRevision: 1 });
  const job = await prisma!.client.$transaction((tx) =>
    creativeRepository.createQueued(tx, {
      sessionId: session.id,
      telegramUserId,
      chatId: telegramUserId,
      input: { ...creativeInput, title: "Old brief" },
    }),
  );
  creativeJobIds.push(job.id);
  await prisma!.client.rovelleCreativeJob.update({
    where: { id: job.id },
    data: {
      status: RovelleCreativeJobStatus.SUCCEEDED,
      result: creativeResult as unknown as Prisma.InputJsonValue,
      completionMetadata: { instructionVersion: "storyboard-v1" },
      completionResponse: { text: "Saved storyboard." },
      completionHash: "a".repeat(64),
    },
  });
  const token = randomUUID();
  actionTokens.push(token);
  await creatorRepository.createAction({
    token,
    telegramUserId,
    kind: "CREATIVE_PAGE",
    payload: { jobId: job.id, inputRevision: 1 },
    expiresAt: new Date(Date.now() + 60_000),
  });
  await prisma!.client.rovelleCreatorSession.update({
    where: { id: session.id },
    data: { data: { creativeInputRevision: 1, creativeJobId: job.id } },
  });

  const reply = await creatorService.handleTelegram(message("/new"));

  assert.match(reply.text, /title/i);
  const storedJob = await prisma!.client.rovelleCreativeJob.findUniqueOrThrow({ where: { id: job.id } });
  assert.equal(storedJob.status, RovelleCreativeJobStatus.SUCCEEDED);
  assert.ok(storedJob.supersededAt);
  const action = await prisma!.client.rovelleCreatorAction.findUniqueOrThrow({ where: { token } });
  assert.ok(action.consumedAt);
  const storedSession = await prisma!.client.rovelleCreatorSession.findUniqueOrThrow({ where: { id: session.id } });
  assert.equal(storedSession.step, "NEW_TITLE");
  assert.equal("creativeJobId" in (storedSession.data as Record<string, unknown>), false);
});

function message(messageText: string, id = nextUpdateId()): CreatorTelegramRequest {
  receiptUpdateIds.push(id);
  return { telegramUserId, chatId: telegramUserId, updateId: id, messageText };
}

function callback(callbackData: string, id = nextUpdateId()): CreatorTelegramRequest {
  receiptUpdateIds.push(id);
  return normalizeCreatorTelegramRequest({ telegramUserId, chatId: telegramUserId, updateId: id, callbackToken: callbackData });
}

function nextUpdateId(): string {
  updateCounter += 1;
  return `${Date.now()}${updateCounter}`;
}

async function createSession(step: string, data: Record<string, unknown>) {
  const session = await prisma!.client.rovelleCreatorSession.create({
    data: { telegramUserId, step, data: data as Prisma.InputJsonValue },
  });
  sessionIds.push(session.id);
  return session;
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
