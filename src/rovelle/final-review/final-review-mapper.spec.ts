import * as assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { RovelleRenderReview } from "../../generated/prisma/client";
import {
  toRenderDto,
  type RenderDto,
} from "../render/render-mapper";
import type { RenderSpecV1 } from "../render/render-spec";
import {
  toFinalRenderReviewDto,
  toFinalRenderReviewResultDto,
} from "./final-review-mapper";

type RenderRecord = Parameters<typeof toRenderDto>[0];

const REVIEW_ID = "550e8400-e29b-41d4-a716-446655440000";
const REVIEW_REQUEST_ID = "650e8400-e29b-41d4-a716-446655440000";
const RENDER_ID = "750e8400-e29b-41d4-a716-446655440000";
const RENDER_REQUEST_ID = "850e8400-e29b-41d4-a716-446655440000";
const EPISODE_ID = "950e8400-e29b-41d4-a716-446655440000";
const AUDIO_ASSET_ID = "a50e8400-e29b-41d4-a716-446655440000";
const CAPTION_ASSET_ID = "b50e8400-e29b-41d4-a716-446655440000";
const OUTPUT_ASSET_ID = "c50e8400-e29b-41d4-a716-446655440000";

const spec: RenderSpecV1 = {
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
  captions: {
    assetId: CAPTION_ASSET_ID,
    mediaType: "text/vtt",
    byteSize: "2",
    etag: null,
    format: "WEBVTT",
  },
};

const review = {
  id: REVIEW_ID,
  clientRequestId: REVIEW_REQUEST_ID,
  renderId: RENDER_ID,
  reviewerType: "AI",
  decision: "RERENDER",
  notes: "Needs a cleaner opening frame.",
  createdAt: new Date("2026-08-29T02:00:00.000Z"),
} as unknown as RovelleRenderReview;

const render = {
  id: RENDER_ID,
  clientRequestId: RENDER_REQUEST_ID,
  episodeId: EPISODE_ID,
  attempt: 1,
  profile: "VERTICAL_SHORT_V1",
  status: "COMPLETED",
  specVersion: 1,
  spec,
  specHash: "a".repeat(64),
  outputAssetId: OUTPUT_ASSET_ID,
  completedAt: new Date("2026-08-29T02:01:00.000Z"),
  createdAt: new Date("2026-08-29T01:00:00.000Z"),
  updatedAt: new Date("2026-08-29T02:01:00.000Z"),
  outputAsset: {
    id: OUTPUT_ASSET_ID,
    episodeId: EPISODE_ID,
    assetType: "RENDER",
    status: "AVAILABLE",
    mediaType: "video/mp4",
    storageKey: "private/render.mp4",
    originalFilename: "render.mp4",
    byteSize: 42n,
    etag: "asset-etag",
    createdAt: new Date("2026-08-29T01:00:00.000Z"),
    updatedAt: new Date("2026-08-29T01:01:00.000Z"),
  },
  jobs: [
    {
      id: "d50e8400-e29b-41d4-a716-446655440000",
      clientRequestId: "e50e8400-e29b-41d4-a716-446655440000",
      renderId: RENDER_ID,
      attempt: 1,
      status: "SUCCEEDED",
      availableAt: new Date("2026-08-29T01:00:00.000Z"),
      workerId: "worker-a",
      leaseToken: "secret-lease-token",
      claimedAt: null,
      heartbeatAt: null,
      leaseExpiresAt: null,
      startedAt: null,
      finishedAt: null,
      errorCode: null,
      errorMessage: null,
      createdAt: new Date("2026-08-29T01:00:00.000Z"),
      updatedAt: new Date("2026-08-29T01:00:00.000Z"),
    },
  ],
} as unknown as RenderRecord;

describe("Rovelle final render review mapping", () => {
  test("maps the public review DTO with ISO date and HUMAN reviewer type", () => {
    assert.deepEqual(toFinalRenderReviewDto(review), {
      id: REVIEW_ID,
      requestId: REVIEW_REQUEST_ID,
      renderId: RENDER_ID,
      reviewerType: "HUMAN",
      decision: "RERENDER",
      notes: "Needs a cleaner opening frame.",
      createdAt: "2026-08-29T02:00:00.000Z",
    });
  });

  test("reuses render mapping and derives a rerender action from the persisted spec", () => {
    const mapped = toFinalRenderReviewResultDto({
      review,
      render,
      episode: { id: EPISODE_ID },
    });

    assert.deepEqual(mapped.nextAction, {
      type: "CREATE_RENDER",
      endpoint: `/api/rovelle/episodes/${EPISODE_ID}/renders`,
      defaults: {
        audioAssetId: AUDIO_ASSET_ID,
        captionAssetId: CAPTION_ASSET_ID,
      },
    });
    assert.equal(mapped.render.spec, spec);
    assert.equal("storageKey" in mapped.render.outputAsset, false);
    assert.equal("leaseToken" in mapped.render.jobs[0]!, false);
    assert.equal(mapped.render.createdAt, "2026-08-29T01:00:00.000Z");
  });

  test("returns no next action for approval or rejection", () => {
    for (const decision of ["APPROVE", "REJECT"] as const) {
      const mapped = toFinalRenderReviewResultDto({
        review: { ...review, decision },
        render,
        episode: { id: EPISODE_ID },
      });

      assert.equal(mapped.nextAction, null);
    }
  });

  test("maps a render with no captions to a null caption default", () => {
    const mapped = toFinalRenderReviewResultDto({
      review,
      render: {
        ...render,
        spec: { ...spec, captions: null },
      } as unknown as RenderRecord,
      episode: { id: EPISODE_ID },
    });

    assert.equal(mapped.nextAction?.defaults.captionAssetId, null);
  });

  test("keeps the result render publicly typed", () => {
    const mapped: { render: RenderDto } = toFinalRenderReviewResultDto({
      review,
      render,
      episode: { id: EPISODE_ID },
    });

    assert.equal(mapped.render.id, RENDER_ID);
  });
});
