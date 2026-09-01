import * as assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
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
import type { RenderDto } from "../render/render-mapper";
import type { InternalRenderRecord } from "../render/render.repository";
import { RenderService } from "../render/render.service";
import {
  toFinalRenderReviewResultDto,
  toFinalRenderReviewDto,
} from "./final-review-mapper";
import type {
  FinalReviewEpisodeSnapshot,
  FinalReviewMutationResult,
  FinalReviewRepository,
} from "./final-review.repository";
import { FinalReviewService } from "./final-review.service";

const EPISODE_ID = "550e8400-e29b-41d4-a716-446655440000";
const RENDER_ID = "650e8400-e29b-41d4-a716-446655440000";
const REQUEST_ID = "750e8400-e29b-41d4-a716-446655440000";
const REVIEW_ID = "850e8400-e29b-41d4-a716-446655440000";
const AUDIO_ASSET_ID = "950e8400-e29b-41d4-a716-446655440000";
const OUTPUT_ASSET_ID = "a50e8400-e29b-41d4-a716-446655440000";

const renderSpec = {
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
    assetId: AUDIO_ASSET_ID,
    mediaType: "audio/mpeg",
    byteSize: "1",
    etag: null,
  },
  captions: null,
};

function episode(
  status: RovelleEpisodeStatus = RovelleEpisodeStatus.FINAL_REVIEW,
): FinalReviewEpisodeSnapshot {
  return { id: EPISODE_ID, status, approvedRenderId: null };
}

function render(): InternalRenderRecord {
  return {
    id: RENDER_ID,
    clientRequestId: REQUEST_ID,
    episodeId: EPISODE_ID,
    attempt: 1,
    profile: RovelleRenderProfile.VERTICAL_SHORT_V1,
    status: RovelleRenderStatus.COMPLETED,
    specVersion: 1,
    spec: renderSpec,
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
      updatedAt: new Date("2026-08-29T00:00:00.000Z"),
    },
    jobs: [
      {
        id: "b50e8400-e29b-41d4-a716-446655440000",
        clientRequestId: REQUEST_ID,
        renderId: RENDER_ID,
        attempt: 1,
        status: RovelleRenderJobStatus.SUCCEEDED,
        availableAt: new Date("2026-08-29T00:00:00.000Z"),
        workerId: null,
        leaseToken: null,
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
  } as InternalRenderRecord;
}

function review(
  changes: Partial<RovelleRenderReview> = {},
): RovelleRenderReview {
  return {
    id: REVIEW_ID,
    clientRequestId: REQUEST_ID,
    renderId: RENDER_ID,
    reviewerType: RovelleReviewerType.HUMAN,
    decision: RovelleRenderReviewDecision.RERENDER,
    notes: "Needs another pass.",
    createdAt: new Date("2026-08-29T02:00:00.000Z"),
    ...changes,
  };
}

function mutation(
  status: "reviewed" | "existing" = "reviewed",
  decision: RovelleRenderReviewDecision = RovelleRenderReviewDecision.RERENDER,
  episodeStatus: RovelleEpisodeStatus = RovelleEpisodeStatus.GENERATION_APPROVED,
): FinalReviewMutationResult {
  return {
    status,
    review: review({ decision }),
    render: render(),
    episode: episode(episodeStatus),
  };
}

type SuccessfulMutation = Extract<
  FinalReviewMutationResult,
  { status: "reviewed" | "existing" }
>;

function successfulMutation(
  result: FinalReviewMutationResult,
): SuccessfulMutation {
  if (result.status !== "reviewed" && result.status !== "existing") {
    throw new Error("expected a successful final review mutation");
  }
  return result;
}

type SubmitInput = Parameters<FinalReviewRepository["submitHumanReview"]>[0];

class StubFinalReviewRepository {
  submitResult: FinalReviewMutationResult = mutation();
  submitInputs: SubmitInput[] = [];
  listedReviews: RovelleRenderReview[] = [];
  listCalls: string[] = [];

  async submitHumanReview(
    input: SubmitInput,
  ): Promise<FinalReviewMutationResult> {
    this.submitInputs.push(input);
    return this.submitResult;
  }

  async listRenderReviews(renderId: string): Promise<RovelleRenderReview[]> {
    this.listCalls.push(renderId);
    return this.listedReviews;
  }
}

class StubRenderService {
  events: string[] = [];
  missing = false;
  createCalls = 0;

  async getRender(renderId: string): Promise<RenderDto> {
    this.events.push(`get:${renderId}`);
    if (this.missing) throw new NotFoundException("Rovelle render not found");
    return {} as RenderDto;
  }

  async createRender(): Promise<RenderDto> {
    this.createCalls += 1;
    return {} as RenderDto;
  }
}

function createService() {
  const repository = new StubFinalReviewRepository();
  const renderService = new StubRenderService();
  const service = new FinalReviewService(
    repository as unknown as FinalReviewRepository,
    renderService as unknown as RenderService,
  );
  return { repository, renderService, service };
}

describe("Rovelle final review service", () => {
  test("normalizes and delegates a review request, then maps the reviewed result", async () => {
    const { repository, renderService, service } = createService();
    repository.submitResult = mutation(
      "reviewed",
      RovelleRenderReviewDecision.RERENDER,
    );

    const result = await service.submitHumanReview(RENDER_ID, {
      requestId: `  ${REQUEST_ID} `,
      decision: "RERENDER",
      notes: "  Needs another pass.  ",
    });

    assert.deepEqual(repository.submitInputs, [
      {
        clientRequestId: REQUEST_ID,
        renderId: RENDER_ID,
        decision: RovelleRenderReviewDecision.RERENDER,
        notes: "Needs another pass.",
      },
    ]);

    await service.submitHumanReview(RENDER_ID, {
      requestId: REQUEST_ID,
      decision: "APPROVE",
    });
    assert.equal(repository.submitInputs[1]?.notes, null);
    assert.deepEqual(
      result,
      toFinalRenderReviewResultDto({
        review: successfulMutation(repository.submitResult).review,
        render: successfulMutation(repository.submitResult).render,
        episode: successfulMutation(repository.submitResult).episode,
      }),
    );
    assert.deepEqual(renderService.events, []);
  });

  test("maps reviewed and idempotent existing outcomes through the same result mapper", async () => {
    for (const status of ["reviewed", "existing"] as const) {
      const { repository, service } = createService();
      repository.submitResult = mutation(
        status,
        RovelleRenderReviewDecision.APPROVE,
        RovelleEpisodeStatus.PUBLISH_READY,
      );

      assert.deepEqual(
        await service.submitHumanReview(RENDER_ID, {
          requestId: REQUEST_ID,
          decision: "APPROVE",
        }),
        toFinalRenderReviewResultDto({
          review: successfulMutation(repository.submitResult).review,
          render: successfulMutation(repository.submitResult).render,
          episode: successfulMutation(repository.submitResult).episode,
        }),
      );
    }
  });

  test("maps every repository error outcome to its existing-style Nest exception", async () => {
    const cases: Array<[
      FinalReviewMutationResult["status"],
      typeof NotFoundException | typeof ConflictException | typeof BadRequestException,
      string,
    ]> = [
      ["not_found", NotFoundException, "Rovelle render not found"],
      [
        "request_conflict",
        ConflictException,
        "Final review request ID was already used for another render",
      ],
      [
        "render_not_reviewable",
        BadRequestException,
        "Only completed renders can receive final review",
      ],
      [
        "output_not_available",
        BadRequestException,
        "Render output is not available for final review",
      ],
      [
        "invalid_episode_state",
        BadRequestException,
        "Episode is not awaiting final render review",
      ],
    ];

    for (const [status, exception, message] of cases) {
      const { repository, service } = createService();
      repository.submitResult = { status } as FinalReviewMutationResult;

      await assert.rejects(
        () =>
          service.submitHumanReview(RENDER_ID, {
            requestId: REQUEST_ID,
            decision: "APPROVE",
          }),
        (error: unknown) =>
          error instanceof exception && (error as Error).message === message,
      );
    }
  });

  test("maps approve, reject, and rerender outcomes without creating a render", async () => {
    const cases = [
      {
        decision: RovelleRenderReviewDecision.APPROVE,
        episodeStatus: RovelleEpisodeStatus.PUBLISH_READY,
        nextAction: null,
      },
      {
        decision: RovelleRenderReviewDecision.REJECT,
        episodeStatus: RovelleEpisodeStatus.FINAL_REVIEW,
        nextAction: null,
      },
      {
        decision: RovelleRenderReviewDecision.RERENDER,
        episodeStatus: RovelleEpisodeStatus.GENERATION_APPROVED,
        nextAction: {
          type: "CREATE_RENDER",
          endpoint: `/api/rovelle/episodes/${EPISODE_ID}/renders`,
          defaults: { audioAssetId: AUDIO_ASSET_ID, captionAssetId: null },
        },
      },
    ] as const;

    for (const item of cases) {
      const { repository, renderService, service } = createService();
      repository.submitResult = mutation(
        "reviewed",
        item.decision,
        item.episodeStatus,
      );

      const result = await service.submitHumanReview(RENDER_ID, {
        requestId: REQUEST_ID,
        decision: item.decision,
      });

      assert.equal(result.review.decision, item.decision);
      assert.deepEqual(result.nextAction, item.nextAction);
      assert.equal(renderService.createCalls, 0);
    }
  });

  test("verifies the render before mapping repository review history in chronological order", async () => {
    const { repository, renderService, service } = createService();
    const first = review({
      id: "c50e8400-e29b-41d4-a716-446655440000",
      createdAt: new Date("2026-08-29T02:00:00.000Z"),
    });
    const second = review({
      id: "d50e8400-e29b-41d4-a716-446655440000",
      createdAt: new Date("2026-08-29T03:00:00.000Z"),
    });
    repository.listedReviews = [first, second];

    assert.deepEqual(await service.listRenderReviews(RENDER_ID), [
      toFinalRenderReviewDto(first),
      toFinalRenderReviewDto(second),
    ]);
    assert.deepEqual(renderService.events, [`get:${RENDER_ID}`]);
    assert.deepEqual(repository.listCalls, [RENDER_ID]);
  });

  test("does not list history when render existence verification fails", async () => {
    const { repository, renderService, service } = createService();
    renderService.missing = true;

    await assert.rejects(
      () => service.listRenderReviews(RENDER_ID),
      (error: unknown) =>
        error instanceof NotFoundException &&
        (error as Error).message === "Rovelle render not found",
    );
    assert.deepEqual(repository.listCalls, []);
  });
});
