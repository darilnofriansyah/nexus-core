import * as assert from "node:assert/strict";
import { randomInt, randomUUID } from "node:crypto";
import { after, afterEach, before, describe, test } from "node:test";
import { Prisma, RovelleCanonEntityType, RovelleCanonVersionStatus, RovelleCreativeJobStatus, RovelleEpisodeStatus } from "../../generated/prisma/client";
import { PrismaService } from "../../database/prisma.service";
import { CanonPinRepository } from "../canon/canon-pin.repository";
import { CanonPinService } from "../canon/canon-pin.service";
import { CreativeRepository } from "./creative.repository";
import { renderCreativePages } from "./creative-preview";
import { CreativeApprovalService } from "./creative-approval.service";
import { creativeInput, creativeResult } from "./creative.fixture";
import { EpisodeRepository } from "../production/episode.repository";
import { EpisodeService } from "../production/episode.service";
import { CreatorCreativeService } from "../creator/creator-creative.service";
import { CreatorRepository } from "../creator/creator.repository";
import type { CreatorTelegramRequest } from "../creator/dto/creator.dto";
import type { CreativeInput } from "./dto/creative.dto";

const testDatabaseUrl = process.env.ROVELLE_TEST_DATABASE_URL;
const originalDatabaseUrl = process.env.DATABASE_URL;
const originalCreativeEnabled = process.env.ROVELLE_CREATIVE_ENABLED;
const originalTelegramBotId = process.env.ROVELLE_TELEGRAM_BOT_ID;
const testBotId = "phase3a-approval-test";
const databaseIntegrationEnabled = Boolean(testDatabaseUrl) &&
  process.env.ROVELLE_TEST_DATABASE_DISPOSABLE === "true";

interface ApprovalFixture {
  telegramUserId: string;
  sessionId?: string;
  jobId?: string;
  token?: string;
  canonEntityId?: string;
  canonVersionId?: string;
  episodeIds: string[];
  updateIds: string[];
}

let prisma: PrismaService | undefined;
let creatorRepository: CreatorRepository;
let creativeRepository: CreativeRepository;
let episodes: EpisodeService;
let creativeService: CreatorCreativeService;
let activeFixture: ApprovalFixture | undefined;
let updateCounter = 0;
const fixtures: ApprovalFixture[] = [];

describe(
  "Rovelle creative approval transaction",
  { skip: !databaseIntegrationEnabled },
  () => {
    before(async () => {
      if (!testDatabaseUrl || process.env.ROVELLE_TEST_DATABASE_DISPOSABLE !== "true") {
        throw new Error("ROVELLE_TEST_DATABASE_URL and ROVELLE_TEST_DATABASE_DISPOSABLE=true are required for the verified disposable phase3a database");
      }
      process.env.DATABASE_URL = testDatabaseUrl;
      process.env.ROVELLE_CREATIVE_ENABLED = "true";
      process.env.ROVELLE_TELEGRAM_BOT_ID = testBotId;
      prisma = new PrismaService();
      creatorRepository = new CreatorRepository(prisma);
      creativeRepository = new CreativeRepository(prisma);
      episodes = new EpisodeService(new EpisodeRepository(prisma));
      const canonPins = new CanonPinService(new CanonPinRepository(prisma));
      const approval = new CreativeApprovalService(creatorRepository, episodes, canonPins);
      creativeService = new CreatorCreativeService(creatorRepository, creativeRepository, approval);
      const createEpisode = episodes.createEpisode.bind(episodes);
      episodes.createEpisode = async (...args: Parameters<EpisodeService["createEpisode"]>) => {
        const episode = await createEpisode(...args);
        activeFixture?.episodeIds.push(episode.id);
        return episode;
      };

      const [database] = await prisma.client.$queryRaw<Array<{ database_name: string }>>`
        SELECT current_database() AS database_name
      `;
      assert.equal(database?.database_name, "rovelle_phase3a", "Refusing fixture cleanup unless current_database() is exactly rovelle_phase3a");
    });

    afterEach(async () => {
      activeFixture = undefined;
      if (!prisma) return;
      for (const fixture of fixtures.splice(0)) await cleanupFixture(fixture);
    });

    after(async () => {
      await prisma?.onModuleDestroy();
      restoreEnv("DATABASE_URL", originalDatabaseUrl);
      restoreEnv("ROVELLE_CREATIVE_ENABLED", originalCreativeEnabled);
      restoreEnv("ROVELLE_TELEGRAM_BOT_ID", originalTelegramBotId);
    });

    test("approval rolls back after episode creation, shot replacement, and session persistence, then retry saves once", async () => {
      const fixture = await createApprovalFixture();
      const request = approvalRequest(fixture);
      const originalCreateEpisode = episodes.createEpisode.bind(episodes);
      episodes.createEpisode = async (...args: Parameters<EpisodeService["createEpisode"]>) => {
        await originalCreateEpisode(...args);
        throw new Error("injected approval failure after episode creation");
      };
      try {
        await assert.rejects(() => creativeService.handle(request), /injected approval failure after episode creation/);
      } finally {
        episodes.createEpisode = originalCreateEpisode;
      }
      await assertApprovalRolledBack(fixture);

      const originalReplaceShots = episodes.replaceShots.bind(episodes);
      episodes.replaceShots = async (...args: Parameters<EpisodeService["replaceShots"]>) => {
        await originalReplaceShots(...args);
        throw new Error("injected approval failure after shot replacement");
      };
      try {
        await assert.rejects(() => creativeService.handle(request), /injected approval failure after shot replacement/);
      } finally {
        episodes.replaceShots = originalReplaceShots;
      }
      await assertApprovalRolledBack(fixture);

      const originalSaveSession = creatorRepository.saveSession.bind(creatorRepository);
      creatorRepository.saveSession = async (...args: Parameters<CreatorRepository["saveSession"]>) => {
        await originalSaveSession(...args);
        throw new Error("injected approval failure after session persistence");
      };
      try {
        await assert.rejects(() => creativeService.handle(request), /injected approval failure after session persistence/);
      } finally {
        creatorRepository.saveSession = originalSaveSession;
      }
      await assertApprovalRolledBack(fixture);

      const reply = await creativeService.handle(request);
      assert.ok(reply);
      assert.match(reply.text, /Plan saved/);
      assert.deepEqual(await creativeService.handle(request), reply);
      const stored = await storedEpisodes(fixture);
      assert.equal(stored.length, 1);
      assert.equal(stored[0]!.status, RovelleEpisodeStatus.PREPRODUCTION);
      assert.equal(stored[0]!.shots.length, creativeResult.shots.length);
      assert.deepEqual(stored[0]!.shots.map((shot) => shot.sequence), [1]);
      assert.equal((stored[0]!.brief as Record<string, unknown>).script, creativeResult.script);
      assert.deepEqual((stored[0]!.brief as Record<string, unknown>).storyboard, creativeResult);
      assert.deepEqual(stored[0]!.canonPins.map((pin) => pin.canonVersionId), [fixture.canonVersionId]);
      await assertCanonUnchanged(fixture);
      await assertNoGenerationOrRenderRows(fixture);
      assert.equal(await receiptCount(fixture), 1);
    });

    test("concurrent approvals with different update IDs create one episode", async () => {
      const fixture = await createApprovalFixture();
      const [firstRequest, secondRequest] = [approvalRequest(fixture), approvalRequest(fixture)];

      const [first, second] = await Promise.all([
        creativeService.handle(firstRequest),
        creativeService.handle(secondRequest),
      ]);

      assert.ok(first && second);
      assert.deepEqual(second, first);
      const stored = await storedEpisodes(fixture);
      assert.equal(stored.length, 1);
      assert.equal(stored[0]!.shots.length, 1);
      assert.equal(await receiptCount(fixture), 2);
      const job = await prisma!.client.rovelleCreativeJob.findUniqueOrThrow({ where: { id: fixture.jobId! } });
      assert.equal(job.episodeId, stored[0]!.id);
      assert.ok(job.approvedAt);
    });

    test("same update replay and a second update using the consumed token return the saved reply", async () => {
      const fixture = await createApprovalFixture();
      const firstRequest = approvalRequest(fixture);
      const first = await creativeService.handle(firstRequest);
      assert.ok(first);

      assert.deepEqual(await creativeService.handle(firstRequest), first);
      const second = await creativeService.handle(approvalRequest(fixture));

      assert.deepEqual(second, first);
      assert.equal((await storedEpisodes(fixture)).length, 1);
      assert.equal(await prisma!.client.rovelleShot.count({ where: { episodeId: (await storedEpisodes(fixture))[0]!.id } }), 1);
      assert.equal(await receiptCount(fixture), 2);
    });
  },
);

async function createApprovalFixture(): Promise<ApprovalFixture> {
  const fixture: ApprovalFixture = {
    telegramUserId: String(randomInt(100_000_000, 999_999_999)),
    episodeIds: [],
    updateIds: [],
  };
  fixtures.push(fixture);
  activeFixture = fixture;
  const definition = { description: "Immutable approval test character." };
  const entity = await prisma!.client.rovelleCanonEntity.create({
    data: {
      code: `TEST_${randomUUID().slice(0, 8).toUpperCase()}`,
      displayName: "Approval Character",
      entityType: RovelleCanonEntityType.CHARACTER,
    },
  });
  fixture.canonEntityId = entity.id;
  const version = await prisma!.client.rovelleCanonVersion.create({
    data: {
      entityId: entity.id,
      version: 1,
      status: RovelleCanonVersionStatus.LOCKED,
      lockedAt: new Date(),
      definition,
    },
  });
  fixture.canonVersionId = version.id;
  const session = await prisma!.client.rovelleCreatorSession.create({
    data: { telegramUserId: fixture.telegramUserId, step: "CREATIVE_REVIEW", data: {} },
  });
  fixture.sessionId = session.id;
  const input: CreativeInput = {
    ...creativeInput,
    title: `Approval ${randomUUID().slice(0, 8)}`,
    canon: [{ entityId: entity.id, versionId: version.id, code: entity.code, definition }],
  };
  const job = await prisma!.client.$transaction((tx) => creativeRepository.createQueued(tx, {
    sessionId: session.id,
    telegramUserId: fixture.telegramUserId,
    chatId: fixture.telegramUserId,
    input,
  }));
  fixture.jobId = job.id;
  await prisma!.client.rovelleCreativeJob.update({
    where: { id: job.id },
    data: {
      status: RovelleCreativeJobStatus.SUCCEEDED,
      result: creativeResult as unknown as Prisma.InputJsonValue,
      completionMetadata: { instructionVersion: "storyboard-v1", sdkVersion: "test", model: "test", threadId: null, usage: null },
      completionHash: "a".repeat(64),
    },
  });
  const pageCount = renderCreativePages(input, creativeResult).length;
  await prisma!.client.rovelleCreatorSession.update({
    where: { id: session.id },
    data: {
      data: {
        creativeJobId: job.id,
        creativeInputRevision: input.inputRevision,
        creativeReviewProgress: {
          jobId: job.id,
          inputRevision: input.inputRevision,
          inputHash: job.inputHash,
          currentPage: pageCount,
          viewedPages: Array.from({ length: pageCount }, (_, index) => index + 1),
        },
      },
    },
  });
  const token = randomUUID();
  fixture.token = token;
  await creatorRepository.createAction({
    token,
    telegramUserId: fixture.telegramUserId,
    kind: "CREATIVE_APPROVE",
    payload: { jobId: job.id, inputRevision: input.inputRevision, inputHash: job.inputHash, page: pageCount },
    expiresAt: new Date(Date.now() + 60_000),
  });
  return fixture;
}

function approvalRequest(fixture: ApprovalFixture): CreatorTelegramRequest {
  const updateId = `${Date.now()}${++updateCounter}`;
  fixture.updateIds.push(updateId);
  return {
    telegramUserId: fixture.telegramUserId,
    chatId: fixture.telegramUserId,
    updateId,
    callbackToken: fixture.token!,
  };
}

async function storedEpisodes(fixture: ApprovalFixture) {
  return prisma!.client.rovelleEpisode.findMany({
    where: { id: { in: fixture.episodeIds } },
    include: { shots: { orderBy: { sequence: "asc" } }, canonPins: true },
  });
}

async function receiptCount(fixture: ApprovalFixture): Promise<number> {
  return prisma!.client.rovelleTelegramReceipt.count({
    where: { botId: testBotId, telegramUserId: fixture.telegramUserId },
  });
}

async function assertApprovalRolledBack(fixture: ApprovalFixture): Promise<void> {
  const client = prisma!.client;
  assert.deepEqual(await storedEpisodes(fixture), []);
  assert.equal(await client.rovelleShot.count({ where: { episodeId: { in: fixture.episodeIds } } }), 0);
  const job = await client.rovelleCreativeJob.findUniqueOrThrow({ where: { id: fixture.jobId! } });
  assert.equal(job.status, RovelleCreativeJobStatus.SUCCEEDED);
  assert.equal(job.episodeId, null);
  assert.equal(job.approvedAt, null);
  const action = await client.rovelleCreatorAction.findUniqueOrThrow({ where: { token: fixture.token! } });
  assert.equal(action.consumedAt, null);
  const session = await client.rovelleCreatorSession.findUniqueOrThrow({ where: { id: fixture.sessionId! } });
  assert.equal(session.step, "CREATIVE_REVIEW");
  assert.equal((session.data as Record<string, unknown>).creativeSavedPlan, undefined);
  assert.equal(await receiptCount(fixture), 0);
  await assertCanonUnchanged(fixture);
  await assertNoGenerationOrRenderRows(fixture);
}

async function assertCanonUnchanged(fixture: ApprovalFixture): Promise<void> {
  const version = await prisma!.client.rovelleCanonVersion.findUniqueOrThrow({
    where: { id: fixture.canonVersionId! },
  });
  assert.equal(version.status, RovelleCanonVersionStatus.LOCKED);
  assert.deepEqual(version.definition, { description: "Immutable approval test character." });
}

async function assertNoGenerationOrRenderRows(fixture: ApprovalFixture): Promise<void> {
  const client = prisma!.client;
  const shots = await client.rovelleShot.findMany({
    where: { episodeId: { in: fixture.episodeIds } },
    select: { id: true },
  });
  assert.equal(await client.rovelleShotGeneration.count({ where: { shotId: { in: shots.map((shot) => shot.id) } } }), 0);
  assert.equal(await client.rovelleRender.count({ where: { episodeId: { in: fixture.episodeIds } } }), 0);
}

async function cleanupFixture(fixture: ApprovalFixture): Promise<void> {
  const client = prisma!.client;
  const jobs = await client.rovelleCreativeJob.findMany({
    where: { telegramUserId: fixture.telegramUserId },
    select: { episodeId: true },
  });
  const episodeIds = [...new Set([
    ...fixture.episodeIds,
    ...jobs.flatMap((job) => job.episodeId ? [job.episodeId] : []),
  ])];
  await client.rovelleTelegramReceipt.deleteMany({ where: { botId: testBotId, telegramUserId: fixture.telegramUserId } });
  await client.rovelleCreatorAction.deleteMany({ where: { telegramUserId: fixture.telegramUserId } });
  await client.rovelleCreativeJob.deleteMany({ where: { telegramUserId: fixture.telegramUserId } });
  if (episodeIds.length) await client.rovelleEpisode.deleteMany({ where: { id: { in: episodeIds } } });
  if (fixture.canonVersionId) await client.rovelleCanonVersion.deleteMany({ where: { id: fixture.canonVersionId } });
  if (fixture.canonEntityId) await client.rovelleCanonEntity.deleteMany({ where: { id: fixture.canonEntityId } });
  await client.rovelleCreatorSession.deleteMany({ where: { telegramUserId: fixture.telegramUserId } });
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
