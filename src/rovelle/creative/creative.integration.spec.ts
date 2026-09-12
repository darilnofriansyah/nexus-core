import * as assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, afterEach, before, describe, test } from "node:test";
import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { PrismaService } from "../../database/prisma.service";
import { RovelleCreativeJobStatus } from "../../generated/prisma/client";
import { creativeInput, creativeResult } from "./creative.fixture";
import { CreativeRepository } from "./creative.repository";
import { hashCreativeValue } from "./creative-validation";
import type { CreativeCompletion, CreativeInput } from "./dto/creative.dto";

const testDatabaseUrl = process.env.ROVELLE_TEST_DATABASE_URL;
const originalDatabaseUrl = process.env.DATABASE_URL;

describe("Rovelle creative job persistence", () => {
  let prisma!: PrismaService;
  let repository!: CreativeRepository;
  const sessionIds: string[] = [];
  const jobIds: string[] = [];
  const episodeIds: string[] = [];

  before(async () => {
    if (!testDatabaseUrl) {
      throw new Error(
        "ROVELLE_TEST_DATABASE_URL must point to a verified disposable database",
      );
    }
    process.env.DATABASE_URL = testDatabaseUrl;
    prisma = new PrismaService();
    repository = new CreativeRepository(prisma);
  });

  afterEach(async () => {
    if (!prisma) return;

    await prisma.client.rovelleCreativeJob.deleteMany({
      where: { id: { in: jobIds.splice(0) } },
    });
    await prisma.client.rovelleCreatorSession.deleteMany({
      where: { id: { in: sessionIds.splice(0) } },
    });
    await prisma.client.rovelleEpisode.deleteMany({
      where: { id: { in: episodeIds.splice(0) } },
    });
  });

  after(async () => {
    await prisma?.onModuleDestroy();

    if (originalDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = originalDatabaseUrl;
    }
  });

  async function createFixture(inputOverrides: Partial<CreativeInput> = {}) {
    const telegramUserId = `test-${randomUUID().slice(0, 20)}`;
    const session = await prisma.client.rovelleCreatorSession.create({
      data: {
        telegramUserId,
        step: "CREATIVE_REVIEW",
        data: {},
      },
    });
    sessionIds.push(session.id);

    const input = { ...creativeInput, ...inputOverrides };
    const job = await prisma.client.$transaction((tx) =>
      repository.createQueued(tx, {
        sessionId: session.id,
        telegramUserId,
        chatId: telegramUserId,
        input,
      }),
    );
    jobIds.push(job.id);
    return { input, job, telegramUserId, session };
  }

  function completion(
    claim: Extract<
      Awaited<ReturnType<CreativeRepository["claim"]>>,
      { claimed: true }
    >,
    input: CreativeInput,
    overrides: Partial<CreativeCompletion> = {},
  ): CreativeCompletion {
    return {
      attemptToken: claim.attemptToken,
      inputHash: hashCreativeValue(input),
      status: "COMPLETED",
      metadata: {
        instructionVersion: "storyboard-v1",
        sdkVersion: "0.154.0",
        model: "gpt-5.6-luna",
        threadId: null,
        usage: null,
      },
      result: creativeResult,
      ...overrides,
    } as CreativeCompletion;
  }

  test("concurrent claims produce exactly one successful lease", async () => {
    const { job } = await createFixture();
    const now = new Date("2026-09-11T12:00:00.000Z");

    const claims = await Promise.all([
      repository.claim(job.id, now),
      repository.claim(job.id, now),
    ]);

    assert.equal(claims.filter((claim) => claim.claimed).length, 1);
    const claimed = claims.find((claim) => claim.claimed);
    assert.ok(claimed?.claimed);
    assert.match(claimed.attemptToken, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(
      (
        await prisma.client.rovelleCreativeJob.findUniqueOrThrow({
          where: { id: job.id },
        })
      ).status,
      RovelleCreativeJobStatus.RUNNING,
    );
  });

  test("rejects unknown job IDs instead of reporting claimable work", async () => {
    const unknownJobId = randomUUID();

    await assert.rejects(
      () =>
        repository.claim(unknownJobId, new Date("2026-09-11T12:00:00.000Z")),
      NotFoundException,
    );
    await assert.rejects(
      () =>
        repository.complete(
          unknownJobId,
          {} as CreativeCompletion,
          new Date("2026-09-11T12:00:00.000Z"),
        ),
      NotFoundException,
    );
  });

  test("one creator cannot create two active jobs or claim a job twice", async () => {
    const telegramUserId = `test-${randomUUID().slice(0, 20)}`;
    const session = await prisma.client.rovelleCreatorSession.create({
      data: { telegramUserId, step: "CREATIVE_REVIEW", data: {} },
    });
    sessionIds.push(session.id);
    const createJob = (input: CreativeInput) =>
      prisma.client.$transaction((tx) =>
        repository.createQueued(tx, {
          sessionId: session.id,
          telegramUserId,
          chatId: telegramUserId,
          input,
        }),
      );
    const created = await Promise.allSettled([
      createJob(creativeInput),
      createJob({ ...creativeInput, inputRevision: 2 }),
    ]);
    assert.equal(
      created.filter((result) => result.status === "fulfilled").length,
      1,
    );
    assert.equal(
      created.filter((result) => result.status === "rejected").length,
      1,
    );
    const job = created.find((result) => result.status === "fulfilled")?.value;
    assert.ok(job);
    jobIds.push(job.id);

    const now = new Date("2026-09-11T12:00:00.000Z");
    const first = await repository.claim(job.id, now);
    assert.equal(first.claimed, true);
    assert.deepEqual(await repository.claim(job.id, now), {
      claimed: false,
    });
  });

  test("stores a normalized input hash and replays identical completion", async () => {
    const input = { ...creativeInput, title: "  Sharing  " };
    const fixture = await createFixture(input);
    assert.equal("attemptTokenHash" in fixture.job, false);
    const claim = await repository.claim(
      fixture.job.id,
      new Date("2026-09-11T12:00:00.000Z"),
    );
    assert.ok(claim.claimed);

    const first = await repository.complete(
      fixture.job.id,
      completion(claim, claim.input),
      new Date("2026-09-11T12:01:00.000Z"),
    );
    const replay = await repository.complete(
      fixture.job.id,
      completion(claim, claim.input),
      new Date("2026-09-11T12:02:00.000Z"),
    );

    assert.deepEqual(replay, first);
    const stored = await prisma.client.rovelleCreativeJob.findUniqueOrThrow({
      where: { id: fixture.job.id },
    });
    assert.equal(
      stored.inputHash,
      hashCreativeValue({ ...creativeInput, title: "Sharing" }),
    );
    assert.equal(stored.status, RovelleCreativeJobStatus.SUCCEEDED);
    assert.deepEqual(stored.completionResponse, first.reply);
    assert.equal("attemptTokenHash" in first, false);
  });

  test("rejects a wrong token and conflicting completion replay", async () => {
    const fixture = await createFixture();
    const claim = await repository.claim(
      fixture.job.id,
      new Date("2026-09-11T12:00:00.000Z"),
    );
    assert.ok(claim.claimed);
    const original = completion(claim, fixture.input);
    await repository.complete(
      fixture.job.id,
      original,
      new Date("2026-09-11T12:01:00.000Z"),
    );

    await assert.rejects(
      () =>
        repository.complete(
          fixture.job.id,
          {
            ...original,
            attemptToken: `${original.attemptToken[0] === "A" ? "B" : "A"}${original.attemptToken.slice(1)}`,
          },
          new Date("2026-09-11T12:02:00.000Z"),
        ),
      ForbiddenException,
    );
    const conflicting = {
      ...original,
      result: {
        ...creativeResult,
        script: "A different script.",
      },
    } as CreativeCompletion;
    await assert.rejects(
      () =>
        repository.complete(
          fixture.job.id,
          conflicting,
          new Date("2026-09-11T12:03:00.000Z"),
        ),
      ConflictException,
    );
    await assert.rejects(
      () =>
        repository.complete(
          fixture.job.id,
          { ...original, inputHash: "0".repeat(64) },
          new Date("2026-09-11T12:03:30.000Z"),
        ),
      ConflictException,
    );
  });

  test("moves an expired running lease to unknown and accepts retained completion", async () => {
    const fixture = await createFixture();
    const claim = await repository.claim(
      fixture.job.id,
      new Date("2026-09-11T12:00:00.000Z"),
    );
    assert.ok(claim.claimed);

    assert.deepEqual(
      await repository.listQueued(new Date("2026-09-11T12:10:01.000Z")),
      [],
    );
    assert.equal(
      (
        await prisma.client.rovelleCreativeJob.findUniqueOrThrow({
          where: { id: fixture.job.id },
        })
      ).status,
      RovelleCreativeJobStatus.OUTCOME_UNKNOWN,
    );

    const result = await repository.complete(
      fixture.job.id,
      completion(claim, fixture.input),
      new Date("2026-09-11T12:11:00.000Z"),
    );
    assert.equal(result.chatId, fixture.telegramUserId);
    assert.equal(
      (
        await prisma.client.rovelleCreativeJob.findUniqueOrThrow({
          where: { id: fixture.job.id },
        })
      ).status,
      RovelleCreativeJobStatus.SUCCEEDED,
    );
  });

  test("does not apply a retained completion after supersession", async () => {
    const fixture = await createFixture();
    const claim = await repository.claim(
      fixture.job.id,
      new Date("2026-09-11T12:00:00.000Z"),
    );
    assert.ok(claim.claimed);
    await prisma.client.rovelleCreativeJob.update({
      where: { id: fixture.job.id },
      data: {
        status: RovelleCreativeJobStatus.OUTCOME_UNKNOWN,
        supersededAt: new Date("2026-09-11T12:05:00.000Z"),
        leaseExpiresAt: null,
      },
    });

    await assert.rejects(
      () =>
        repository.complete(
          fixture.job.id,
          completion(claim, fixture.input),
          new Date("2026-09-11T12:11:00.000Z"),
        ),
      ConflictException,
    );
    assert.equal(
      (
        await prisma.client.rovelleCreativeJob.findUniqueOrThrow({
          where: { id: fixture.job.id },
        })
      ).status,
      RovelleCreativeJobStatus.OUTCOME_UNKNOWN,
    );
  });

  test("lists at most twenty queued jobs in oldest-first order", async () => {
    const fixtures = [];
    for (let index = 0; index < 21; index += 1) {
      fixtures.push(await createFixture({ title: `Sharing ${index}` }));
    }

    const listed = await repository.listQueued(
      new Date("2026-09-11T12:00:00.000Z"),
    );
    assert.equal(listed.length, 20);
    assert.deepEqual(
      listed.map(({ id }) => id),
      fixtures.slice(0, 20).map(({ job }) => job.id),
    );
  });
});
