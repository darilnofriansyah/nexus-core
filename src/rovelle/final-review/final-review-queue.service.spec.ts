import * as assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  BadRequestException,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import {
  RovelleAssetStatus,
  RovelleAssetType,
  RovelleEpisodeStatus,
  RovelleRenderJobStatus,
  RovelleRenderProfile,
  RovelleRenderReviewDecision,
  RovelleRenderStatus,
  RovelleReviewerType,
  type RovelleRenderReview,
} from "../../generated/prisma/client";
import type { AssetReadUrlDto } from "../assets/dto/asset.dto";
import type { AssetService } from "../assets/asset.service";
import type { InternalRenderRecord } from "../render/render.repository";
import { toRenderDto, type RenderDto } from "../render/render-mapper";
import { toFinalRenderReviewDto } from "./final-review-mapper";

const EPISODE_ID = "550e8400-e29b-41d4-a716-446655440000";
const RENDER_ID = "650e8400-e29b-41d4-a716-446655440000";
const OUTPUT_ASSET_ID = "750e8400-e29b-41d4-a716-446655440000";
const REVIEW_ID = "850e8400-e29b-41d4-a716-446655440000";

type QueueEpisode = {
  id: string;
  code: string;
  title: string;
  status: RovelleEpisodeStatus;
  approvedRenderId: string | null;
};
type QueueCandidate = {
  episode: QueueEpisode;
  render: InternalRenderRecord;
  reviews: RovelleRenderReview[];
};
type ApprovedMaster = QueueCandidate;
type QueueItem = {
  episode: {
    id: string;
    code: string;
    title: string;
    status: "FINAL_REVIEW";
  };
  render: RenderDto;
  reviews: unknown[];
  preview: AssetReadUrlDto["download"];
};
type ApprovedMasterDto = {
  episode: {
    id: string;
    code: string;
    title: string;
    status: RovelleEpisodeStatus;
    approvedRenderId: string;
  };
  render: RenderDto;
  read: AssetReadUrlDto["download"];
};

type QueueRepository = {
  listFinalReviewCandidates(episodeId?: string): Promise<QueueCandidate[]>;
  findApprovedMaster(episodeId: string): Promise<ApprovedMaster | null>;
  episodeExists(episodeId: string): Promise<boolean>;
};
type QueueService = {
  listQueue(episodeId?: string): Promise<QueueItem[]>;
  getApprovedFinalMaster(episodeId: string): Promise<ApprovedMasterDto>;
};
type QueueServiceConstructor = new (
  repository: QueueRepository,
  assetService: AssetService,
) => QueueService;

function loadQueueService(): QueueServiceConstructor {
  return require("./final-review-queue.service").FinalReviewQueueService;
}

function episode(
  changes: Partial<QueueEpisode> = {},
): QueueEpisode {
  return {
    id: EPISODE_ID,
    code: "EP-001",
    title: "Episode one",
    status: RovelleEpisodeStatus.FINAL_REVIEW,
    approvedRenderId: null,
    ...changes,
  };
}

function render(
  changes: Partial<InternalRenderRecord> = {},
): InternalRenderRecord {
  return {
    id: RENDER_ID,
    clientRequestId: "950e8400-e29b-41d4-a716-446655440000",
    episodeId: EPISODE_ID,
    attempt: 1,
    profile: RovelleRenderProfile.VERTICAL_SHORT_V1,
    status: RovelleRenderStatus.COMPLETED,
    specVersion: 1,
    spec: {
      version: 1,
      profile: "VERTICAL_SHORT_V1",
      output: {
        container: "mp4",
        width: 1080,
        height: 1920,
        frameRate: 30,
        videoCodec: "libx264",
        pixelFormat: "yuv420p",
        audioCodec: "aac",
        audioSampleRate: 48000,
      },
      shots: [],
      audio: {
        assetId: "a50e8400-e29b-41d4-a716-446655440000",
        mediaType: "audio/mpeg",
        byteSize: "1",
        etag: null,
      },
      captions: null,
    },
    specHash: "a".repeat(64),
    outputAssetId: OUTPUT_ASSET_ID,
    completedAt: new Date("2026-08-29T01:00:00.000Z"),
    createdAt: new Date("2026-08-29T00:00:00.000Z"),
    updatedAt: new Date("2026-08-29T01:00:00.000Z"),
    outputAsset: {
      id: OUTPUT_ASSET_ID,
      episodeId: EPISODE_ID,
      assetType: RovelleAssetType.RENDER,
      status: RovelleAssetStatus.AVAILABLE,
      mediaType: "video/mp4",
      storageKey: "private/render.mp4",
      originalFilename: "render.mp4",
      byteSize: 42n,
      etag: "etag",
      createdAt: new Date("2026-08-29T00:00:00.000Z"),
      updatedAt: new Date("2026-08-29T01:00:00.000Z"),
    },
    jobs: [
      {
        id: "b50e8400-e29b-41d4-a716-446655440000",
        clientRequestId: "c50e8400-e29b-41d4-a716-446655440000",
        renderId: RENDER_ID,
        attempt: 1,
        status: RovelleRenderJobStatus.SUCCEEDED,
        availableAt: new Date("2026-08-29T00:00:00.000Z"),
        workerId: "worker-a",
        leaseToken: "secret-lease-token",
        claimedAt: null,
        heartbeatAt: null,
        leaseExpiresAt: null,
        startedAt: new Date("2026-08-29T00:01:00.000Z"),
        finishedAt: new Date("2026-08-29T00:02:00.000Z"),
        errorCode: null,
        errorMessage: null,
        createdAt: new Date("2026-08-29T00:00:00.000Z"),
        updatedAt: new Date("2026-08-29T00:02:00.000Z"),
      },
    ],
    ...changes,
  } as InternalRenderRecord;
}

function review(
  changes: Partial<RovelleRenderReview> = {},
): RovelleRenderReview {
  return {
    id: REVIEW_ID,
    clientRequestId: "d50e8400-e29b-41d4-a716-446655440000",
    renderId: RENDER_ID,
    reviewerType: RovelleReviewerType.HUMAN,
    decision: RovelleRenderReviewDecision.REJECT,
    notes: "Needs another pass.",
    createdAt: new Date("2026-08-29T02:00:00.000Z"),
    ...changes,
  };
}

class StubRepository {
  candidates: QueueCandidate[] = [];
  approved: ApprovedMaster | null = null;
  exists = true;
  candidateCalls: Array<string | undefined> = [];
  approvedCalls: string[] = [];
  existsCalls: string[] = [];

  async listFinalReviewCandidates(episodeId?: string): Promise<QueueCandidate[]> {
    this.candidateCalls.push(episodeId);
    return this.candidates;
  }

  async findApprovedMaster(episodeId: string): Promise<ApprovedMaster | null> {
    this.approvedCalls.push(episodeId);
    return this.approved;
  }

  async episodeExists(episodeId: string): Promise<boolean> {
    this.existsCalls.push(episodeId);
    return this.exists;
  }
}

class StubAssetService {
  reads: string[] = [];
  failure: Error | null = null;
  descriptor: AssetReadUrlDto["download"] = {
    method: "GET",
    url: "https://signed.example/read",
    headers: {},
    expiresAt: "2026-08-29T03:00:00.000Z",
  };

  async createReadUrl(id: string): Promise<AssetReadUrlDto> {
    this.reads.push(id);
    if (this.failure) throw this.failure;
    return { asset: {} as AssetReadUrlDto["asset"], download: this.descriptor };
  }
}

function createService() {
  const repository = new StubRepository();
  const assetService = new StubAssetService();
  const service = new (loadQueueService())(
    repository,
    assetService as unknown as AssetService,
  );
  return { repository, assetService, service };
}

function candidate(
  changes: Partial<QueueCandidate> = {},
): QueueCandidate {
  const selectedEpisode = changes.episode ?? episode();
  return {
    episode: selectedEpisode,
    render: changes.render ?? render({ episodeId: selectedEpisode.id }),
    reviews: changes.reviews ?? [],
  };
}

describe("Rovelle final review queue service", () => {
  test("maps queue candidates with one ephemeral preview and review history", async () => {
    const { repository, assetService, service } = createService();
    const selectedRender = render();
    const selectedReview = review();
    repository.candidates = [
      candidate({
        render: selectedRender,
        reviews: [selectedReview],
      }),
    ];

    const result = await service.listQueue();

    assert.equal(result.length, 1);
    assert.deepEqual(result[0]?.episode, {
      id: EPISODE_ID,
      code: "EP-001",
      title: "Episode one",
      status: "FINAL_REVIEW",
    });
    assert.deepEqual(result[0]?.render, toRenderDto(selectedRender));
    assert.deepEqual(result[0]?.reviews, [toFinalRenderReviewDto(selectedReview)]);
    assert.deepEqual(result[0]?.preview, assetService.descriptor);
    assert.deepEqual(assetService.reads, [OUTPUT_ASSET_ID]);
    assert.equal("storageKey" in (result[0]?.render.outputAsset ?? {}), false);
    assert.equal("leaseToken" in ((result[0]?.render.jobs ?? [])[0] ?? {}), false);
    assert.deepEqual(repository.candidateCalls, [undefined]);
    assert.equal("preview" in repository.candidates[0]!, false);
  });

  test("creates exactly one ephemeral preview per queue candidate", async () => {
    const { repository, assetService, service } = createService();
    const secondEpisodeId = "850e8400-e29b-41d4-a716-446655440000";
    const secondAssetId = "950e8400-e29b-41d4-a716-446655440000";
    const secondBaseRender = render();
    const secondRender = render({
      id: "a50e8400-e29b-41d4-a716-446655440000",
      episodeId: secondEpisodeId,
      outputAssetId: secondAssetId,
      outputAsset: {
        ...secondBaseRender.outputAsset,
        id: secondAssetId,
        episodeId: secondEpisodeId,
      },
    });
    repository.candidates = [
      candidate(),
      candidate({
        episode: episode({
          id: secondEpisodeId,
          code: "EP-002",
          title: "Episode two",
        }),
        render: secondRender,
      }),
    ];

    const result = await service.listQueue();

    assert.equal(result.length, 2);
    assert.deepEqual(assetService.reads, [OUTPUT_ASSET_ID, secondAssetId]);
    assert.deepEqual(result.map((item) => item.preview), [
      assetService.descriptor,
      assetService.descriptor,
    ]);
  });

  test("passes an optional episode filter to the candidate repository", async () => {
    const { repository, service } = createService();

    await service.listQueue(EPISODE_ID);

    assert.deepEqual(repository.candidateCalls, [EPISODE_ID]);
  });

  test("propagates R2 failures without a local or legacy URL fallback", async () => {
    const { repository, assetService, service } = createService();
    repository.candidates = [candidate()];
    assetService.failure = new ServiceUnavailableException("R2 unavailable");

    await assert.rejects(
      () => service.listQueue(),
      (error: unknown) =>
        error instanceof ServiceUnavailableException &&
        (error as Error).message === "R2 unavailable",
    );
    assert.deepEqual(assetService.reads, [OUTPUT_ASSET_ID]);
  });

  test("returns the exact approved pointer with an ephemeral read descriptor", async () => {
    const { repository, assetService, service } = createService();
    const approvedEpisode = episode({
      status: RovelleEpisodeStatus.PUBLISHED,
      approvedRenderId: RENDER_ID,
    });
    repository.approved = candidate({
      episode: approvedEpisode,
      render: render({ id: RENDER_ID, attempt: 1 }),
    });

    const result = await service.getApprovedFinalMaster(EPISODE_ID);

    assert.deepEqual(result.episode, {
      id: EPISODE_ID,
      code: "EP-001",
      title: "Episode one",
      status: RovelleEpisodeStatus.PUBLISHED,
      approvedRenderId: RENDER_ID,
    });
    assert.equal(result.render.id, RENDER_ID);
    assert.equal(result.render.attempt, 1);
    assert.deepEqual(result.read, assetService.descriptor);
    assert.deepEqual(assetService.reads, [OUTPUT_ASSET_ID]);
    assert.equal("storageKey" in (result.render.outputAsset ?? {}), false);
    assert.equal("leaseToken" in ((result.render.jobs ?? [])[0] ?? {}), false);
    assert.equal("upload" in result, false);
    assert.deepEqual(repository.approvedCalls, [EPISODE_ID]);
  });

  test("allows approved-master reads after publication state advances", async () => {
    for (const status of [
      RovelleEpisodeStatus.PUBLISH_READY,
      RovelleEpisodeStatus.PUBLISHING,
      RovelleEpisodeStatus.PUBLISHED,
    ]) {
      const { repository, service } = createService();
      repository.approved = candidate({
        episode: episode({ status, approvedRenderId: RENDER_ID }),
      });

      const result = await service.getApprovedFinalMaster(EPISODE_ID);

      assert.equal(result.episode.status, status);
      assert.equal(result.episode.approvedRenderId, RENDER_ID);
    }
  });

  test("distinguishes a missing episode from an existing episode without an approved master", async () => {
    const missing = createService();
    missing.repository.exists = false;
    await assert.rejects(
      () => missing.service.getApprovedFinalMaster(EPISODE_ID),
      (error: unknown) =>
        error instanceof NotFoundException &&
        (error as Error).message === "Rovelle episode not found",
    );

    const noMaster = createService();
    noMaster.repository.exists = true;
    await assert.rejects(
      () => noMaster.service.getApprovedFinalMaster(EPISODE_ID),
      (error: unknown) =>
        error instanceof BadRequestException &&
        (error as Error).message ===
          "Episode does not have an approved final render",
    );
    assert.deepEqual(missing.assetService.reads, []);
    assert.deepEqual(noMaster.assetService.reads, []);
  });

  test("keeps the queue decision-driven", async () => {
    const { repository, service } = createService();
    repository.candidates = [
      candidate({
        reviews: [review({ decision: RovelleRenderReviewDecision.REJECT })],
      }),
    ];
    assert.equal((await service.listQueue()).length, 1);

    for (const status of [
      RovelleEpisodeStatus.GENERATION_APPROVED,
      RovelleEpisodeStatus.PUBLISH_READY,
    ]) {
      repository.candidates = [candidate({ episode: episode({ status }) })];
      assert.deepEqual(await service.listQueue(), []);
    }
  });
});
