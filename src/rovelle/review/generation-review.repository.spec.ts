import * as assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  RovelleAssetStatus,
  RovelleAssetType,
  RovelleEpisodeStatus,
  RovelleGenerationStatus,
  RovelleReviewDecision,
  RovelleShotStatus,
} from "../../generated/prisma/client";
import { PrismaService } from "../../database/prisma.service";
import { GenerationReviewRepository } from "./generation-review.repository";

const EPISODE_ID = "550e8400-e29b-41d4-a716-446655440000";
const SHOT_ID = "650e8400-e29b-41d4-a716-446655440000";
const GENERATION_ID = "750e8400-e29b-41d4-a716-446655440000";
const OTHER_GENERATION_ID = "850e8400-e29b-41d4-a716-446655440000";
const REQUEST_ID = "950e8400-e29b-41d4-a716-446655440000";
const OTHER_REQUEST_ID = "a50e8400-e29b-41d4-a716-446655440000";

function createRepository(
  options: {
    generationStatus?: RovelleGenerationStatus;
    outputStatus?: RovelleAssetStatus;
  } = {},
) {
  const state = {
    episode: { id: EPISODE_ID, status: RovelleEpisodeStatus.REVIEW_REQUIRED },
    shot: {
      id: SHOT_ID,
      episodeId: EPISODE_ID,
      status: RovelleShotStatus.REVIEW_REQUIRED,
      approvedGenerationId: null as string | null,
    },
    generations: [
      {
        id: GENERATION_ID,
        shotId: SHOT_ID,
        status: options.generationStatus ?? RovelleGenerationStatus.COMPLETED,
        outputAssetId: "a50e8400-e29b-41d4-a716-446655440000",
        outputAsset: {
          id: "a50e8400-e29b-41d4-a716-446655440000",
          episodeId: EPISODE_ID,
          assetType: RovelleAssetType.GENERATION,
          status: options.outputStatus ?? RovelleAssetStatus.AVAILABLE,
          mediaType: "video/mp4",
          byteSize: 42n,
        },
      },
      {
        id: OTHER_GENERATION_ID,
        shotId: SHOT_ID,
        status: RovelleGenerationStatus.COMPLETED,
        outputAssetId: "b50e8400-e29b-41d4-a716-446655440000",
        outputAsset: {
          id: "b50e8400-e29b-41d4-a716-446655440000",
          episodeId: EPISODE_ID,
          assetType: RovelleAssetType.GENERATION,
          status: RovelleAssetStatus.AVAILABLE,
          mediaType: "video/mp4",
          byteSize: 42n,
        },
      },
    ],
    reviews: [] as Array<{
      id: string;
      clientRequestId: string;
      generationId: string;
      decision: RovelleReviewDecision;
      notes: string | null;
      reviewerType: "HUMAN";
      createdAt: Date;
    }>,
  };
  let reviewId = 0;

  const generation = (id: string) => {
    const found = state.generations.find((value) => value.id === id);
    if (!found) return null;
    return {
      ...found,
      shot: { ...state.shot, episode: { ...state.episode } },
    };
  };
  const review = (requestId: string) =>
    state.reviews.find((value) => value.clientRequestId === requestId) ?? null;
  const tx = {
    rovelleReview: {
      findUnique: async ({
        where,
      }: {
        where: { clientRequestId?: string; id?: string };
      }) => {
        const found = where.clientRequestId
          ? review(where.clientRequestId)
          : (state.reviews.find((value) => value.id === where.id) ?? null);
        return found
          ? { ...found, generation: generation(found.generationId) }
          : null;
      },
      create: async ({
        data,
      }: {
        data: Omit<(typeof state.reviews)[number], "id" | "createdAt">;
      }) => {
        const created = {
          ...data,
          id: `review-${++reviewId}`,
          createdAt: new Date(),
        };
        state.reviews.push(created);
        return created;
      },
    },
    rovelleShotGeneration: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        generation(where.id),
    },
    rovelleShot: {
      updateMany: async ({
        where,
        data,
      }: {
        where: { id: string; status: { in: RovelleShotStatus[] } };
        data: Partial<typeof state.shot>;
      }) => {
        if (
          where.id !== state.shot.id ||
          !where.status.in.includes(state.shot.status)
        )
          return { count: 0 };
        Object.assign(state.shot, data);
        return { count: 1 };
      },
      findMany: async () => [{ id: state.shot.id, status: state.shot.status }],
    },
    rovelleEpisode: {
      updateMany: async ({
        where,
        data,
      }: {
        where: { id: string; status?: RovelleEpisodeStatus };
        data: Partial<typeof state.episode>;
      }) => {
        if (
          where.id !== state.episode.id ||
          (where.status !== undefined && where.status !== state.episode.status)
        )
          return { count: 0 };
        Object.assign(state.episode, data);
        return { count: 1 };
      },
    },
  };
  const prisma = {
    client: {
      $transaction: async <T>(callback: (client: typeof tx) => Promise<T>) =>
        callback(tx),
      rovelleReview: tx.rovelleReview,
    },
  } as unknown as PrismaService;

  return { repository: new GenerationReviewRepository(prisma), state };
}

describe("generation review repository", () => {
  test("approves a completed available generation and points its shot at it", async () => {
    const { repository, state } = createRepository();

    const result = await repository.submitHumanReview({
      clientRequestId: REQUEST_ID,
      generationId: GENERATION_ID,
      decision: RovelleReviewDecision.APPROVE,
      notes: "Approved",
    });

    assert.equal(result.status, "reviewed");
    assert.equal(state.reviews.length, 1);
    assert.equal(state.shot.status, RovelleShotStatus.APPROVED);
    assert.equal(state.shot.approvedGenerationId, GENERATION_ID);
    assert.equal(
      state.episode.status,
      RovelleEpisodeStatus.GENERATION_APPROVED,
    );
  });

  test("refuses non-completed or unavailable generations without appending a review", async () => {
    for (const options of [
      { generationStatus: RovelleGenerationStatus.PROCESSING },
      { outputStatus: RovelleAssetStatus.RESERVED },
    ]) {
      const { repository, state } = createRepository(options);
      const result = await repository.submitHumanReview({
        clientRequestId: REQUEST_ID,
        generationId: GENERATION_ID,
        decision: RovelleReviewDecision.REJECT,
        notes: null,
      });

      assert.notEqual(result.status, "reviewed");
      assert.equal(state.reviews.length, 0);
    }
  });

  test("replays a duplicate request without another state mutation", async () => {
    const { repository, state } = createRepository();
    const input = {
      clientRequestId: REQUEST_ID,
      generationId: GENERATION_ID,
      decision: RovelleReviewDecision.APPROVE,
      notes: null,
    };

    await repository.submitHumanReview(input);
    const replay = await repository.submitHumanReview(input);

    assert.equal(replay.status, "existing");
    assert.equal(state.reviews.length, 1);
    assert.equal(state.shot.approvedGenerationId, GENERATION_ID);
  });

  test("rejects a request id reused by another generation", async () => {
    const { repository, state } = createRepository();
    await repository.submitHumanReview({
      clientRequestId: REQUEST_ID,
      generationId: GENERATION_ID,
      decision: RovelleReviewDecision.REJECT,
      notes: null,
    });

    const result = await repository.submitHumanReview({
      clientRequestId: REQUEST_ID,
      generationId: OTHER_GENERATION_ID,
      decision: RovelleReviewDecision.REJECT,
      notes: null,
    });

    assert.deepEqual(result, { status: "request_conflict" });
    assert.equal(state.reviews.length, 1);
  });

  test("replaces an approved shot pointer when another completed generation is approved", async () => {
    const { repository, state } = createRepository();
    await repository.submitHumanReview({
      clientRequestId: REQUEST_ID,
      generationId: GENERATION_ID,
      decision: RovelleReviewDecision.APPROVE,
      notes: null,
    });

    const result = await repository.submitHumanReview({
      clientRequestId: OTHER_REQUEST_ID,
      generationId: OTHER_GENERATION_ID,
      decision: RovelleReviewDecision.APPROVE,
      notes: "Use this take instead",
    });

    assert.equal(result.status, "reviewed");
    assert.equal(state.shot.status, RovelleShotStatus.APPROVED);
    assert.equal(state.shot.approvedGenerationId, OTHER_GENERATION_ID);
    assert.equal(state.reviews.length, 2);
  });

  test("regenerate readies only the selected shot and does not create work", async () => {
    const { repository, state } = createRepository();
    await repository.submitHumanReview({
      clientRequestId: OTHER_REQUEST_ID,
      generationId: GENERATION_ID,
      decision: RovelleReviewDecision.APPROVE,
      notes: null,
    });

    const result = await repository.submitHumanReview({
      clientRequestId: REQUEST_ID,
      generationId: GENERATION_ID,
      decision: RovelleReviewDecision.REGENERATE,
      notes: "Try again",
    });

    assert.equal(result.status, "reviewed");
    assert.equal(state.shot.status, RovelleShotStatus.READY_TO_GENERATE);
    assert.equal(state.shot.approvedGenerationId, null);
    assert.equal(state.generations.length, 2);
  });
});
