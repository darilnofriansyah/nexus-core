import * as assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, afterEach, before, describe, test } from "node:test";
import { BadRequestException } from "@nestjs/common";
import { PrismaService } from "../../database/prisma.service";
import {
  RovelleAssetStatus,
  RovelleAssetType,
  RovelleEpisodeStatus,
  RovelleGenerationModality,
  RovelleGenerationProfile,
  RovelleGenerationProvider,
  RovelleGenerationStatus,
  RovelleRenderJobStatus,
  RovelleRenderStatus,
  RovelleReviewDecision,
  RovelleReviewerType,
  RovelleShotStatus,
} from "../../generated/prisma/client";
import { hashRenderSpec } from "./render-spec";
import { RenderRepository } from "./render.repository";
import { RenderService } from "./render.service";

const testDatabaseUrl = process.env.ROVELLE_TEST_DATABASE_URL;
const originalDatabaseUrl = process.env.DATABASE_URL;

describe(
  "Rovelle durable render queue integration",
  { skip: !testDatabaseUrl },
  () => {
    let prisma!: PrismaService;
    let service!: RenderService;

    before(async () => {
      process.env.DATABASE_URL = testDatabaseUrl;
      prisma = new PrismaService();
      service = new RenderService(new RenderRepository(prisma));
      await cleanRovelleTables();
    });

    afterEach(cleanRovelleTables);

    after(async () => {
      await prisma?.onModuleDestroy();
      if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = originalDatabaseUrl;
    });

    async function cleanRovelleTables(): Promise<void> {
      if (!prisma) return;
      await prisma.client.rovelleRenderJob.deleteMany();
      await prisma.client.rovelleRender.deleteMany();
      await prisma.client.rovelleReview.deleteMany();
      await prisma.client.rovelleShot.updateMany({
        data: { approvedGenerationId: null },
      });
      await prisma.client.rovelleShotGeneration.deleteMany();
      await prisma.client.rovelleAsset.deleteMany();
      await prisma.client.rovelleShot.deleteMany();
      await prisma.client.rovelleEpisode.deleteMany();
    }

    async function createAsset(input: {
      episodeId?: string;
      assetType: RovelleAssetType;
      mediaType: string;
      byteSize: bigint;
      etag: string;
      suffix: string;
    }) {
      return prisma.client.rovelleAsset.create({
        data: {
          episodeId: input.episodeId,
          assetType: input.assetType,
          status: RovelleAssetStatus.AVAILABLE,
          mediaType: input.mediaType,
          storageKey: `integration/${input.suffix}/${randomUUID()}`,
          byteSize: input.byteSize,
          etag: input.etag,
        },
      });
    }

    async function createFixture() {
      const episode = await prisma.client.rovelleEpisode.create({
        data: {
          code: `RENDER-${randomUUID().replaceAll("-", "").slice(0, 20)}`,
          title: "Render integration episode",
          status: RovelleEpisodeStatus.GENERATION_APPROVED,
        },
      });
      const shots = await Promise.all(
        [
          { sequence: 1, duration: 4 },
          { sequence: 2, duration: 7 },
        ].map((shot) =>
          prisma.client.rovelleShot.create({
            data: {
              episodeId: episode.id,
              sequence: shot.sequence,
              direction: `Shot ${shot.sequence} direction`,
              targetDurationSeconds: shot.duration,
              status: RovelleShotStatus.APPROVED,
            },
          }),
        ),
      );
      const videos = await Promise.all(
        shots.map((shot, index) =>
          createAsset({
            episodeId: episode.id,
            assetType: RovelleAssetType.GENERATION,
            mediaType: "video/mp4",
            byteSize: BigInt(1000 + index * 111),
            etag: `video-etag-${index + 1}`,
            suffix: `video-${index + 1}`,
          }),
        ),
      );
      const generations = await Promise.all(
        shots.map((shot, index) =>
          prisma.client.rovelleShotGeneration.create({
            data: {
              clientRequestId: randomUUID(),
              shotId: shot.id,
              attempt: 1,
              provider: RovelleGenerationProvider.RUNWARE,
              modality: RovelleGenerationModality.VIDEO,
              profile: RovelleGenerationProfile.PRODUCTION,
              model: "integration-model",
              providerTaskId: randomUUID(),
              prompt: `integration prompt ${index + 1}`,
              request: { prompt: `integration prompt ${index + 1}` },
              status: RovelleGenerationStatus.COMPLETED,
              outputAssetId: videos[index].id,
              estimatedCostUsd: "0.250000",
              pricingSource: "integration-test",
              completedAt: new Date(),
            },
          }),
        ),
      );
      await Promise.all(
        generations.map((generation) =>
          prisma.client.rovelleReview.create({
            data: {
              clientRequestId: randomUUID(),
              generationId: generation.id,
              reviewerType: RovelleReviewerType.HUMAN,
              decision: RovelleReviewDecision.APPROVE,
              notes: "Approved for render integration test",
            },
          }),
        ),
      );
      await Promise.all(
        shots.map((shot, index) =>
          prisma.client.rovelleShot.update({
            where: { id: shot.id },
            data: {
              approvedGenerationId: generations[index].id,
              status: RovelleShotStatus.APPROVED,
            },
          }),
        ),
      );
      const audio = await createAsset({
        episodeId: episode.id,
        assetType: RovelleAssetType.AUDIO_MASTER,
        mediaType: "audio/mpeg",
        byteSize: 3456n,
        etag: "audio-etag-1",
        suffix: "audio",
      });
      const captions = await createAsset({
        episodeId: episode.id,
        assetType: RovelleAssetType.CAPTION,
        mediaType: "text/vtt",
        byteSize: 789n,
        etag: "caption-etag-1",
        suffix: "caption",
      });
      return { episode, shots, videos, generations, audio, captions };
    }

    async function expectBadRequest(action: () => Promise<unknown>): Promise<void> {
      await assert.rejects(action, BadRequestException);
    }

    async function assertNoRenderCreated(episodeId: string): Promise<void> {
      assert.equal(await prisma.client.rovelleRender.count(), 0);
      assert.equal(await prisma.client.rovelleRenderJob.count(), 0);
      assert.equal(
        await prisma.client.rovelleAsset.count({
          where: { assetType: RovelleAssetType.RENDER },
        }),
        0,
      );
      assert.equal(
        (await prisma.client.rovelleEpisode.findUniqueOrThrow({ where: { id: episodeId } })).status,
        RovelleEpisodeStatus.GENERATION_APPROVED,
      );
    }

    test("enqueues an immutable approved render atomically", async () => {
      const fixture = await createFixture();
      const requestId = randomUUID();
      const created = await service.createRender(fixture.episode.id, {
        requestId,
        audioAssetId: fixture.audio.id,
        captionAssetId: fixture.captions.id,
      });

      assert.equal(
        (await prisma.client.rovelleEpisode.findUniqueOrThrow({ where: { id: fixture.episode.id } })).status,
        RovelleEpisodeStatus.RENDERING,
      );
      assert.equal(created.attempt, 1);
      assert.equal(created.profile, "VERTICAL_SHORT_V1");
      assert.equal(created.status, RovelleRenderStatus.QUEUED);
      assert.equal(created.specVersion, 1);
      assert.match(created.specHash, /^[0-9a-f]{64}$/);
      assert.equal(created.outputAsset.assetType, RovelleAssetType.RENDER);
      assert.equal(created.outputAsset.status, RovelleAssetStatus.RESERVED);
      assert.equal(created.outputAsset.mediaType, "video/mp4");
      assert.equal(created.outputAsset.episodeId, fixture.episode.id);
      assert.equal(created.jobs.length, 1);
      assert.equal(created.jobs[0].attempt, 1);
      assert.equal(created.jobs[0].status, RovelleRenderJobStatus.QUEUED);
      assert.equal(created.jobs[0].workerId, null);
      const queuedJob = await prisma.client.rovelleRenderJob.findUniqueOrThrow({
        where: { id: created.jobs[0].id },
      });
      assert.equal(queuedJob.leaseToken, null);
      assert.equal(created.jobs[0].claimedAt, null);
      assert.equal(created.jobs[0].heartbeatAt, null);
      assert.equal(created.jobs[0].leaseExpiresAt, null);
      assert.equal(created.jobs[0].startedAt, null);
      assert.equal(created.jobs[0].finishedAt, null);

      assert.deepEqual(
        created.spec.shots.map((shot) => shot.sequence),
        [1, 2],
      );
      assert.deepEqual(
        created.spec.shots.map((shot, index) => ({
          shotId: shot.shotId,
          generationId: shot.generationId,
          targetDurationSeconds: shot.targetDurationSeconds,
          video: shot.video,
          expectedShotId: fixture.shots[index].id,
          expectedGenerationId: fixture.generations[index].id,
          expectedVideoId: fixture.videos[index].id,
        })),
        fixture.shots.map((shot, index) => ({
          shotId: shot.id,
          generationId: fixture.generations[index].id,
          targetDurationSeconds: shot.targetDurationSeconds,
          video: {
            assetId: fixture.videos[index].id,
            mediaType: "video/mp4",
            byteSize: String(1000 + index * 111),
            etag: `video-etag-${index + 1}`,
          },
          expectedShotId: shot.id,
          expectedGenerationId: fixture.generations[index].id,
          expectedVideoId: fixture.videos[index].id,
        })),
      );
      assert.deepEqual(created.spec.audio, {
        assetId: fixture.audio.id,
        mediaType: "audio/mpeg",
        byteSize: "3456",
        etag: "audio-etag-1",
      });
      assert.deepEqual(created.spec.captions, {
        assetId: fixture.captions.id,
        mediaType: "text/vtt",
        byteSize: "789",
        etag: "caption-etag-1",
        format: "WEBVTT",
      });
      assert.deepEqual(created.spec.output, {
        container: "mp4",
        width: 1080,
        height: 1920,
        frameRate: 30,
        videoCodec: "libx264",
        pixelFormat: "yuv420p",
        audioCodec: "aac",
        audioSampleRate: 48000,
      });
      assert.doesNotMatch(JSON.stringify(created.spec), /storageKey|url|secret|token/i);
      assert.equal("storageKey" in created.outputAsset, false);
      assert.equal(created.specHash, hashRenderSpec(created.spec));
    });

    test("makes create idempotent and rejects a new request while rendering", async () => {
      const fixture = await createFixture();
      const request = {
        requestId: randomUUID(),
        audioAssetId: fixture.audio.id,
        captionAssetId: fixture.captions.id,
      };
      const first = await service.createRender(fixture.episode.id, request);
      const repeat = await service.createRender(fixture.episode.id, request);
      assert.equal(repeat.id, first.id);
      assert.equal(await prisma.client.rovelleRender.count(), 1);
      assert.equal(await prisma.client.rovelleRenderJob.count(), 1);
      assert.equal(
        await prisma.client.rovelleAsset.count({ where: { assetType: RovelleAssetType.RENDER } }),
        1,
      );

      await expectBadRequest(() =>
        service.createRender(fixture.episode.id, {
          ...request,
          requestId: randomUUID(),
        }),
      );
      assert.equal(await prisma.client.rovelleRender.count(), 1);
      assert.equal(await prisma.client.rovelleRenderJob.count(), 1);
    });

    test("rejects every non-authoritative approval or source fixture without writes", async () => {
      const cases = [
        {
          name: "shot review required",
          mutate: async (fixture: Awaited<ReturnType<typeof createFixture>>) => {
            await prisma.client.rovelleShot.update({
              where: { id: fixture.shots[0].id },
              data: { status: RovelleShotStatus.REVIEW_REQUIRED },
            });
          },
        },
        {
          name: "approved pointer null",
          mutate: async (fixture: Awaited<ReturnType<typeof createFixture>>) => {
            await prisma.client.rovelleShot.update({
              where: { id: fixture.shots[0].id },
              data: { approvedGenerationId: null },
            });
          },
        },
        {
          name: "approved generation belongs to another shot",
          mutate: async (fixture: Awaited<ReturnType<typeof createFixture>>) => {
            await prisma.client.rovelleShot.update({
              where: { id: fixture.shots[1].id },
              data: { approvedGenerationId: null },
            });
            await prisma.client.rovelleShot.update({
              where: { id: fixture.shots[0].id },
              data: { approvedGenerationId: fixture.generations[1].id },
            });
          },
        },
        {
          name: "approved generation failed",
          mutate: async (fixture: Awaited<ReturnType<typeof createFixture>>) => {
            await prisma.client.rovelleShotGeneration.update({
              where: { id: fixture.generations[0].id },
              data: { status: RovelleGenerationStatus.FAILED },
            });
          },
        },
        {
          name: "approved output reserved",
          mutate: async (fixture: Awaited<ReturnType<typeof createFixture>>) => {
            await prisma.client.rovelleAsset.update({
              where: { id: fixture.videos[0].id },
              data: { status: RovelleAssetStatus.RESERVED },
            });
          },
        },
        {
          name: "approved output belongs to another episode",
          mutate: async (fixture: Awaited<ReturnType<typeof createFixture>>) => {
            const otherEpisode = await prisma.client.rovelleEpisode.create({
              data: {
                code: `OTHER-${randomUUID().replaceAll("-", "").slice(0, 20)}`,
                title: "Other episode",
              },
            });
            await prisma.client.rovelleAsset.update({
              where: { id: fixture.videos[0].id },
              data: { episodeId: otherEpisode.id },
            });
          },
        },
        {
          name: "wrong audio",
          mutate: async (fixture: Awaited<ReturnType<typeof createFixture>>) => {
            fixture.audio = await createAsset({
              assetType: RovelleAssetType.AUDIO_MASTER,
              mediaType: "audio/mpeg",
              byteSize: 22n,
              etag: "wrong-audio",
              suffix: "wrong-audio",
            });
          },
        },
        {
          name: "missing audio",
          mutate: async (fixture: Awaited<ReturnType<typeof createFixture>>) => {
            fixture.audio = { ...fixture.audio, id: randomUUID() };
          },
        },
        {
          name: "wrong caption media type",
          mutate: async (fixture: Awaited<ReturnType<typeof createFixture>>) => {
            await prisma.client.rovelleAsset.update({
              where: { id: fixture.captions.id },
              data: { mediaType: "text/plain" },
            });
          },
        },
      ] as const;

      for (const invalidCase of cases) {
        const fixture = await createFixture();
        await invalidCase.mutate(fixture);
        await expectBadRequest(() =>
          service.createRender(fixture.episode.id, {
            requestId: randomUUID(),
            audioAssetId: fixture.audio.id,
            captionAssetId: fixture.captions.id,
          }),
        );
        await assertNoRenderCreated(fixture.episode.id);
        await cleanRovelleTables();
      }
    });

    test("preserves failed render history and makes retry idempotent", async () => {
      const fixture = await createFixture();
      const created = await service.createRender(fixture.episode.id, {
        requestId: randomUUID(),
        audioAssetId: fixture.audio.id,
        captionAssetId: fixture.captions.id,
      });
      const originalSpec = created.spec;
      const originalHash = created.specHash;
      const firstJob = created.jobs[0];
      await prisma.client.rovelleRenderJob.update({
        where: { id: firstJob.id },
        data: {
          status: RovelleRenderJobStatus.FAILED,
          finishedAt: new Date(),
          errorCode: "RENDER_FAILED",
          errorMessage: "safe integration failure summary",
        },
      });
      await prisma.client.rovelleRender.update({
        where: { id: created.id },
        data: { status: RovelleRenderStatus.FAILED },
      });

      const retryRequestId = randomUUID();
      const retried = await service.retryRender(created.id, { requestId: retryRequestId });
      assert.equal(retried.id, created.id);
      assert.deepEqual(retried.spec, originalSpec);
      assert.equal(retried.specHash, originalHash);
      assert.equal(retried.outputAsset.id, created.outputAsset.id);
      assert.equal(retried.status, RovelleRenderStatus.QUEUED);
      assert.equal(retried.jobs.length, 2);
      assert.equal(retried.jobs[0].status, RovelleRenderJobStatus.FAILED);
      assert.equal(retried.jobs[0].errorMessage, "safe integration failure summary");
      assert.equal(retried.jobs[1].attempt, 2);
      assert.equal(retried.jobs[1].status, RovelleRenderJobStatus.QUEUED);
      assert.equal(retried.jobs[1].workerId, null);
      assert.equal(
        (await prisma.client.rovelleAsset.findUniqueOrThrow({ where: { id: created.outputAsset.id } })).status,
        RovelleAssetStatus.RESERVED,
      );
      assert.equal(
        (await prisma.client.rovelleEpisode.findUniqueOrThrow({ where: { id: fixture.episode.id } })).status,
        RovelleEpisodeStatus.RENDERING,
      );

      const repeat = await service.retryRender(created.id, { requestId: retryRequestId });
      assert.equal(repeat.id, created.id);
      assert.equal(await prisma.client.rovelleRenderJob.count(), 2);
      await assert.rejects(
        () => service.retryRender(created.id, { requestId: randomUUID() }),
        BadRequestException,
      );
      assert.equal(await prisma.client.rovelleRenderJob.count(), 2);
    });
  },
);
