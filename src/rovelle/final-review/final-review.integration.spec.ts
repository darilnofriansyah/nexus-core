import * as assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, afterEach, before, describe, test } from "node:test";
import { BadRequestException, ConflictException } from "@nestjs/common";
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
  RovelleShotStatus,
} from "../../generated/prisma/client";
import { AssetRepository } from "../assets/asset.repository";
import { AssetService } from "../assets/asset.service";
import type {
  R2PresignedRequest,
  R2StorageService,
} from "../assets/r2-storage.service";
import { FinalReviewQueueService } from "./final-review-queue.service";
import { FinalReviewRepository } from "./final-review.repository";
import { FinalReviewService } from "./final-review.service";
import { RenderRepository } from "../render/render.repository";
import { RenderService } from "../render/render.service";

const testDatabaseUrl = process.env.ROVELLE_TEST_DATABASE_URL;
const originalDatabaseUrl = process.env.DATABASE_URL;

class FakeR2Storage {
  readonly readAssetIds: string[] = [];

  assertConfigured(): void {}

  async createGetUrl(key: string): Promise<R2PresignedRequest> {
    this.readAssetIds.push(key.slice(key.lastIndexOf("/") + 1));
    return {
      method: "GET",
      url: `https://signed.invalid/read-${this.readAssetIds.at(-1)}`,
      headers: {},
      expiresAt: "2099-01-01T00:00:00.000Z",
    };
  }
}

describe(
  "Rovelle final render review disposable PostgreSQL integration",
  { skip: !testDatabaseUrl },
  () => {
    let prisma!: PrismaService;
    let renderService!: RenderService;
    let finalReviewService!: FinalReviewService;
    let queueService!: FinalReviewQueueService;
    let storage!: FakeR2Storage;

    before(async () => {
      process.env.DATABASE_URL = testDatabaseUrl;
      prisma = new PrismaService();
      storage = new FakeR2Storage();
      const renderRepository = new RenderRepository(prisma);
      renderService = new RenderService(renderRepository);
      const finalReviewRepository = new FinalReviewRepository(prisma);
      const assetService = new AssetService(
        new AssetRepository(prisma),
        storage as unknown as R2StorageService,
      );
      finalReviewService = new FinalReviewService(
        finalReviewRepository,
        renderService,
      );
      queueService = new FinalReviewQueueService(
        finalReviewRepository,
        assetService,
      );
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
      await prisma.client.rovelleRenderReview.deleteMany();
      await prisma.client.rovelleRenderJob.deleteMany();
      await prisma.client.rovelleEpisode.updateMany({
        data: { approvedRenderId: null },
      });
      await prisma.client.rovelleRender.deleteMany();
      await prisma.client.rovelleShot.updateMany({
        data: { approvedGenerationId: null },
      });
      await prisma.client.rovelleReview.deleteMany();
      await prisma.client.rovelleShotGeneration.deleteMany();
      await prisma.client.rovelleAsset.deleteMany();
      await prisma.client.rovelleShot.deleteMany();
      await prisma.client.rovelleEpisode.deleteMany();
    }

    test("builds the completed final-review fixture from real persisted state", async () => {
      const fixture = await createCompletedFixture();

      assert.equal(fixture.episode.status, RovelleEpisodeStatus.FINAL_REVIEW);
      assert.equal(fixture.episode.approvedRenderId, null);
      assert.equal(fixture.render.status, RovelleRenderStatus.COMPLETED);
      assert.equal(fixture.render.outputAsset.status, RovelleAssetStatus.AVAILABLE);
      assert.equal(fixture.render.outputAsset.assetType, RovelleAssetType.RENDER);
      assert.equal(fixture.render.outputAsset.mediaType, "video/mp4");
      assert.equal(fixture.render.outputAsset.byteSize, "9001");
      assert.equal(fixture.render.jobs[0]?.status, RovelleRenderJobStatus.SUCCEEDED);
    });

    test("appends reject then approve and makes approve idempotent", async () => {
      const fixture = await createCompletedFixture();
      const requestA = randomUUID();
      const requestB = randomUUID();

      const rejected = await finalReviewService.submitHumanReview(
        fixture.render.id,
        { requestId: requestA, decision: "REJECT", notes: "Needs another pass" },
      );
      assert.equal(rejected.review.decision, "REJECT");
      assert.equal(rejected.nextAction, null);
      assert.deepEqual(await episodeSnapshot(fixture.episode.id), {
        status: RovelleEpisodeStatus.FINAL_REVIEW,
        approvedRenderId: null,
      });

      const approved = await finalReviewService.submitHumanReview(
        fixture.render.id,
        { requestId: requestB, decision: "APPROVE" },
      );
      assert.equal(approved.review.decision, "APPROVE");
      assert.equal(approved.nextAction, null);
      assert.doesNotMatch(JSON.stringify(approved), /storageKey/i);
      assert.deepEqual(await episodeSnapshot(fixture.episode.id), {
        status: RovelleEpisodeStatus.PUBLISH_READY,
        approvedRenderId: fixture.render.id,
      });
      assert.deepEqual(await renderSnapshot(fixture.render.id), {
        status: RovelleRenderStatus.COMPLETED,
        outputStatus: RovelleAssetStatus.AVAILABLE,
        jobStatus: RovelleRenderJobStatus.SUCCEEDED,
      });

      const countsBeforeRepeat = await reviewWorkCounts();
      const episodeBeforeRepeat = await prisma.client.rovelleEpisode.findUniqueOrThrow({
        where: { id: fixture.episode.id },
        select: { status: true, approvedRenderId: true, updatedAt: true },
      });
      const readCallsBeforeRepeat = storage.readAssetIds.length;
      const repeated = await finalReviewService.submitHumanReview(
        fixture.render.id,
        { requestId: requestB, decision: "APPROVE" },
      );
      assert.equal(repeated.review.id, approved.review.id);
      assert.deepEqual(repeated, approved);
      assert.deepEqual(await reviewWorkCounts(), countsBeforeRepeat);
      assert.deepEqual(
        await prisma.client.rovelleEpisode.findUniqueOrThrow({
          where: { id: fixture.episode.id },
          select: { status: true, approvedRenderId: true, updatedAt: true },
        }),
        episodeBeforeRepeat,
      );
      assert.equal(storage.readAssetIds.length, readCallsBeforeRepeat);
      assert.equal(
        await prisma.client.rovelleRenderReview.count(),
        2,
      );
    });

    test("rejects a request UUID reused against another render", async () => {
      const first = await createCompletedFixture();
      const second = await createCompletedFixture();
      const requestA = randomUUID();
      const requestB = randomUUID();

      await finalReviewService.submitHumanReview(first.render.id, {
        requestId: requestA,
        decision: "REJECT",
      });
      await finalReviewService.submitHumanReview(first.render.id, {
        requestId: requestB,
        decision: "APPROVE",
      });

      await assert.rejects(
        () =>
          finalReviewService.submitHumanReview(second.render.id, {
            requestId: requestA,
            decision: "REJECT",
          }),
        ConflictException,
      );
      await assert.rejects(
        () =>
          finalReviewService.submitHumanReview(second.render.id, {
            requestId: requestB,
            decision: "APPROVE",
          }),
        ConflictException,
      );
      assert.equal(
        await prisma.client.rovelleRenderReview.count({
          where: { renderId: second.render.id },
        }),
        0,
      );
      assert.deepEqual(await episodeSnapshot(second.episode.id), {
        status: RovelleEpisodeStatus.FINAL_REVIEW,
        approvedRenderId: null,
      });
    });

    test("can intentionally approve an older completed render", async () => {
      const { first, second } = await createTwoCompletedRenders();

      const result = await finalReviewService.submitHumanReview(first.render.id, {
        requestId: randomUUID(),
        decision: "APPROVE",
      });

      assert.equal(result.render.id, first.render.id);
      assert.deepEqual(await episodeSnapshot(first.episode.id), {
        status: RovelleEpisodeStatus.PUBLISH_READY,
        approvedRenderId: first.render.id,
      });
      assert.deepEqual(await renderSnapshot(second.render.id), {
        status: RovelleRenderStatus.COMPLETED,
        outputStatus: RovelleAssetStatus.AVAILABLE,
        jobStatus: RovelleRenderJobStatus.SUCCEEDED,
      });
    });

    test("queues only the newest candidate, previews its output, and removes it after approval", async () => {
      const { first, second } = await createTwoCompletedRenders();
      await finalReviewService.submitHumanReview(second.render.id, {
        requestId: randomUUID(),
        decision: "REJECT",
      });
      storage.readAssetIds.length = 0;

      const queued = await queueService.listQueue(first.episode.id);
      assert.equal(queued.length, 1);
      assert.equal(queued[0]?.render.id, second.render.id);
      assert.equal(queued[0]?.render.attempt, 2);
      assert.equal(queued[0]?.preview.url, `https://signed.invalid/read-${second.render.outputAsset.id}`);
      assert.deepEqual(storage.readAssetIds, [second.render.outputAsset.id]);
      assert.equal(queued[0]?.reviews.length, 1);
      assert.equal(queued[0]?.reviews[0]?.decision, "REJECT");
      assert.doesNotMatch(JSON.stringify(queued[0]), /storageKey/i);

      await finalReviewService.submitHumanReview(second.render.id, {
        requestId: randomUUID(),
        decision: "APPROVE",
      });
      assert.deepEqual(await queueService.listQueue(first.episode.id), []);
    });

    test("resolves the approved final master from the episode pointer", async () => {
      const { first, second } = await createTwoCompletedRenders();
      await finalReviewService.submitHumanReview(first.render.id, {
        requestId: randomUUID(),
        decision: "APPROVE",
      });
      storage.readAssetIds.length = 0;

      const master = await queueService.getApprovedFinalMaster(first.episode.id);
      assert.equal(master.episode.approvedRenderId, first.render.id);
      assert.equal(master.render.id, first.render.id);
      assert.equal(master.read.url, `https://signed.invalid/read-${first.render.outputAsset.id}`);
      assert.deepEqual(storage.readAssetIds, [first.render.outputAsset.id]);
      assert.doesNotMatch(JSON.stringify(master), /storageKey/i);
      assert.notEqual(master.render.id, second.render.id);
    });

    test("records rerender without creating work, then reuses RenderService for the next render", async () => {
      const fixture = await createCompletedFixture();
      const countsBefore = await reviewWorkCounts();
      const result = await finalReviewService.submitHumanReview(fixture.render.id, {
        requestId: randomUUID(),
        decision: "RERENDER",
      });

      assert.equal(result.review.decision, "RERENDER");
      assert.doesNotMatch(JSON.stringify(result), /storageKey/i);
      assert.deepEqual(result.nextAction, {
        type: "CREATE_RENDER",
        endpoint: `/api/rovelle/episodes/${fixture.episode.id}/renders`,
        defaults: {
          audioAssetId: fixture.audio.id,
          captionAssetId: fixture.captions.id,
        },
      });
      const countsAfter = await reviewWorkCounts();
      assert.equal(countsAfter.reviews, countsBefore.reviews + 1);
      assert.deepEqual(
        {
          renders: countsAfter.renders,
          jobs: countsAfter.jobs,
          renderAssets: countsAfter.renderAssets,
        },
        {
          renders: countsBefore.renders,
          jobs: countsBefore.jobs,
          renderAssets: countsBefore.renderAssets,
        },
      );
      assert.deepEqual(await episodeSnapshot(fixture.episode.id), {
        status: RovelleEpisodeStatus.GENERATION_APPROVED,
        approvedRenderId: null,
      });
      assert.deepEqual(await renderSnapshot(fixture.render.id), {
        status: RovelleRenderStatus.COMPLETED,
        outputStatus: RovelleAssetStatus.AVAILABLE,
        jobStatus: RovelleRenderJobStatus.SUCCEEDED,
      });

      const next = await renderService.createRender(fixture.episode.id, {
        requestId: randomUUID(),
        audioAssetId: fixture.audio.id,
        captionAssetId: fixture.captions.id,
      });
      assert.equal(next.attempt, 2);
      assert.equal(next.status, RovelleRenderStatus.QUEUED);
      assert.equal(next.outputAsset.status, RovelleAssetStatus.RESERVED);
      assert.equal(next.jobs.length, 1);
      assert.equal(next.jobs[0]?.status, RovelleRenderJobStatus.QUEUED);
      assert.deepEqual(await episodeSnapshot(fixture.episode.id), {
        status: RovelleEpisodeStatus.RENDERING,
        approvedRenderId: null,
      });
      assert.equal(await prisma.client.rovelleRender.count(), 2);
      assert.equal(await prisma.client.rovelleRenderJob.count(), 2);
      assert.equal(
        await prisma.client.rovelleAsset.count({ where: { assetType: RovelleAssetType.RENDER } }),
        2,
      );

      await completeRender(next.id);
      await prisma.client.rovelleEpisode.update({
        where: { id: fixture.episode.id },
        data: { status: RovelleEpisodeStatus.FINAL_REVIEW },
      });
      await finalReviewService.submitHumanReview(next.id, {
        requestId: randomUUID(),
        decision: "APPROVE",
      });
      assert.deepEqual(await episodeSnapshot(fixture.episode.id), {
        status: RovelleEpisodeStatus.PUBLISH_READY,
        approvedRenderId: next.id,
      });
      assert.equal(
        await prisma.client.rovelleRenderReview.count({
          where: { renderId: fixture.render.id },
        }),
        1,
      );
    });

    test("rejects every non-reviewable render or episode state without mutation", async () => {
      const cases: Array<{
        name: string;
        mutate: (renderId: string, episodeId: string) => Promise<void>;
      }> = [
        {
          name: "queued render",
          mutate: async (renderId) => {
            await prisma.client.rovelleRender.update({
              where: { id: renderId },
              data: { status: RovelleRenderStatus.QUEUED },
            });
          },
        },
        {
          name: "running render",
          mutate: async (renderId) => {
            await prisma.client.rovelleRender.update({
              where: { id: renderId },
              data: { status: RovelleRenderStatus.RUNNING },
            });
          },
        },
        {
          name: "failed render",
          mutate: async (renderId) => {
            await prisma.client.rovelleRender.update({
              where: { id: renderId },
              data: { status: RovelleRenderStatus.FAILED },
            });
          },
        },
        {
          name: "reserved output",
          mutate: async (renderId) => {
            const render = await prisma.client.rovelleRender.findUniqueOrThrow({ where: { id: renderId } });
            await prisma.client.rovelleAsset.update({
              where: { id: render.outputAssetId },
              data: { status: RovelleAssetStatus.RESERVED, byteSize: null },
            });
          },
        },
        {
          name: "wrong asset type",
          mutate: async (renderId) => {
            const render = await prisma.client.rovelleRender.findUniqueOrThrow({ where: { id: renderId } });
            await prisma.client.rovelleAsset.update({
              where: { id: render.outputAssetId },
              data: { assetType: RovelleAssetType.SOURCE },
            });
          },
        },
        {
          name: "non-video output",
          mutate: async (renderId) => {
            const render = await prisma.client.rovelleRender.findUniqueOrThrow({ where: { id: renderId } });
            await prisma.client.rovelleAsset.update({
              where: { id: render.outputAssetId },
              data: { mediaType: "text/plain" },
            });
          },
        },
        {
          name: "episode not in final review",
          mutate: async (_renderId, episodeId) => {
            await prisma.client.rovelleEpisode.update({
              where: { id: episodeId },
              data: { status: RovelleEpisodeStatus.GENERATION_APPROVED },
            });
          },
        },
      ];

      for (const invalidCase of cases) {
        const fixture = await createCompletedFixture();
        await invalidCase.mutate(fixture.render.id, fixture.episode.id);
        await assert.rejects(
          () =>
            finalReviewService.submitHumanReview(fixture.render.id, {
              requestId: randomUUID(),
              decision: "APPROVE",
            }),
          BadRequestException,
          invalidCase.name,
        );
        assert.equal(
          await prisma.client.rovelleRenderReview.count({
            where: { renderId: fixture.render.id },
          }),
          0,
        );
        assert.equal(
          (await prisma.client.rovelleEpisode.findUniqueOrThrow({ where: { id: fixture.episode.id } })).approvedRenderId,
          null,
        );
        await cleanRovelleTables();
      }
    });

    test("closes the workflow at PUBLISH_READY but keeps old approval idempotent", async () => {
      const fixture = await createCompletedFixture();
      const requestId = randomUUID();
      const approved = await finalReviewService.submitHumanReview(fixture.render.id, {
        requestId,
        decision: "APPROVE",
      });
      const before = await reviewWorkCounts();

      for (const decision of ["REJECT", "RERENDER", "APPROVE"] as const) {
        await assert.rejects(
          () =>
            finalReviewService.submitHumanReview(fixture.render.id, {
              requestId: randomUUID(),
              decision,
            }),
          BadRequestException,
        );
      }
      const repeated = await finalReviewService.submitHumanReview(fixture.render.id, {
        requestId,
        decision: "APPROVE",
      });
      assert.equal(repeated.review.id, approved.review.id);
      assert.deepEqual(await reviewWorkCounts(), before);
      assert.deepEqual(await episodeSnapshot(fixture.episode.id), {
        status: RovelleEpisodeStatus.PUBLISH_READY,
        approvedRenderId: fixture.render.id,
      });
    });

    async function createCompletedFixture() {
      const episode = await prisma.client.rovelleEpisode.create({
        data: {
          code: `FR-${randomUUID().replaceAll("-", "").slice(0, 20)}`,
          title: "Final review integration episode",
          status: RovelleEpisodeStatus.GENERATION_APPROVED,
        },
      });
      const shot = await prisma.client.rovelleShot.create({
        data: {
          episodeId: episode.id,
          sequence: 1,
          direction: "A character crosses a meadow.",
          targetDurationSeconds: 5,
          status: RovelleShotStatus.APPROVED,
        },
      });
      const generationAsset = await prisma.client.rovelleAsset.create({
        data: {
          episodeId: episode.id,
          assetType: RovelleAssetType.GENERATION,
          status: RovelleAssetStatus.AVAILABLE,
          mediaType: "video/mp4",
          storageKey: `integration/generation/${randomUUID()}`,
          byteSize: 1200n,
          etag: "generation-etag",
        },
      });
      const generation = await prisma.client.rovelleShotGeneration.create({
        data: {
          clientRequestId: randomUUID(),
          shotId: shot.id,
          attempt: 1,
          provider: RovelleGenerationProvider.RUNWARE,
          modality: RovelleGenerationModality.VIDEO,
          profile: RovelleGenerationProfile.PRODUCTION,
          model: "integration-model",
          providerTaskId: randomUUID(),
          prompt: "A character crosses a meadow.",
          request: { prompt: "A character crosses a meadow." },
          status: RovelleGenerationStatus.COMPLETED,
          outputAssetId: generationAsset.id,
          estimatedCostUsd: "0.100000",
          pricingSource: "integration-test",
          completedAt: new Date(),
        },
      });
      await prisma.client.rovelleShot.update({
        where: { id: shot.id },
        data: { approvedGenerationId: generation.id },
      });
      const audio = await prisma.client.rovelleAsset.create({
        data: {
          episodeId: episode.id,
          assetType: RovelleAssetType.AUDIO_MASTER,
          status: RovelleAssetStatus.AVAILABLE,
          mediaType: "audio/mpeg",
          storageKey: `integration/audio/${randomUUID()}`,
          byteSize: 3456n,
          etag: "audio-etag",
        },
      });
      const captions = await prisma.client.rovelleAsset.create({
        data: {
          episodeId: episode.id,
          assetType: RovelleAssetType.CAPTION,
          status: RovelleAssetStatus.AVAILABLE,
          mediaType: "text/vtt",
          storageKey: `integration/caption/${randomUUID()}`,
          byteSize: 789n,
          etag: "caption-etag",
        },
      });
      const render = await renderService.createRender(episode.id, {
        requestId: randomUUID(),
        audioAssetId: audio.id,
        captionAssetId: captions.id,
      });
      await prisma.client.rovelleRenderJob.update({
        where: { id: render.jobs[0]!.id },
        data: { status: RovelleRenderJobStatus.SUCCEEDED, finishedAt: new Date() },
      });
      await prisma.client.rovelleAsset.update({
        where: { id: render.outputAsset.id },
        data: {
          status: RovelleAssetStatus.AVAILABLE,
          byteSize: 9001n,
          etag: "render-etag",
        },
      });
      await prisma.client.rovelleRender.update({
        where: { id: render.id },
        data: { status: RovelleRenderStatus.COMPLETED, completedAt: new Date() },
      });
      const finalEpisode = await prisma.client.rovelleEpisode.update({
        where: { id: episode.id },
        data: { status: RovelleEpisodeStatus.FINAL_REVIEW },
      });
      return {
        episode: finalEpisode,
        render: await renderService.getRender(render.id),
        audio,
        captions,
      };
    }

    async function completeRender(renderId: string): Promise<void> {
      const render = await prisma.client.rovelleRender.findUniqueOrThrow({
        where: { id: renderId },
        include: { jobs: true },
      });
      await prisma.client.rovelleRenderJob.update({
        where: { id: render.jobs[0]!.id },
        data: { status: RovelleRenderJobStatus.SUCCEEDED, finishedAt: new Date() },
      });
      await prisma.client.rovelleAsset.update({
        where: { id: render.outputAssetId },
        data: {
          status: RovelleAssetStatus.AVAILABLE,
          byteSize: 9002n,
          etag: "render-etag-next",
        },
      });
      await prisma.client.rovelleRender.update({
        where: { id: render.id },
        data: { status: RovelleRenderStatus.COMPLETED, completedAt: new Date() },
      });
    }

    async function createTwoCompletedRenders() {
      const first = await createCompletedFixture();
      await prisma.client.rovelleEpisode.update({
        where: { id: first.episode.id },
        data: { status: RovelleEpisodeStatus.GENERATION_APPROVED },
      });
      const secondRender = await renderService.createRender(first.episode.id, {
        requestId: randomUUID(),
        audioAssetId: first.audio.id,
        captionAssetId: first.captions.id,
      });
      await completeRender(secondRender.id);
      const episode = await prisma.client.rovelleEpisode.update({
        where: { id: first.episode.id },
        data: { status: RovelleEpisodeStatus.FINAL_REVIEW },
      });
      return {
        first,
        second: {
          ...first,
          episode,
          render: await renderService.getRender(secondRender.id),
        },
      };
    }

    async function episodeSnapshot(episodeId: string) {
      return prisma.client.rovelleEpisode.findUniqueOrThrow({
        where: { id: episodeId },
        select: { status: true, approvedRenderId: true },
      });
    }

    async function renderSnapshot(renderId: string) {
      const render = await prisma.client.rovelleRender.findUniqueOrThrow({
        where: { id: renderId },
        include: { outputAsset: true, jobs: { orderBy: { attempt: "asc" } } },
      });
      return {
        status: render.status,
        outputStatus: render.outputAsset.status,
        jobStatus: render.jobs[0]?.status,
      };
    }

    async function reviewWorkCounts() {
      return {
        reviews: await prisma.client.rovelleRenderReview.count(),
        renders: await prisma.client.rovelleRender.count(),
        jobs: await prisma.client.rovelleRenderJob.count(),
        renderAssets: await prisma.client.rovelleAsset.count({
          where: { assetType: RovelleAssetType.RENDER },
        }),
      };
    }
  },
);
