import * as assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  Prisma,
  RovelleAssetStatus,
  RovelleAssetType,
  RovelleEpisodeStatus,
  RovelleRenderJobStatus,
  RovelleRenderProfile,
  RovelleRenderReviewDecision,
  RovelleRenderStatus,
  RovelleReviewerType,
  type RovelleAsset,
  type RovelleRenderJob,
  type RovelleRenderReview,
} from "../../generated/prisma/client";
import { PrismaService } from "../../database/prisma.service";
import {
  FinalReviewRepository,
  type FinalReviewEpisodeSnapshot,
} from "./final-review.repository";
import type { InternalRenderRecord } from "../render/render.repository";

type EpisodeRecord = FinalReviewEpisodeSnapshot;
type FinalReviewRender = InternalRenderRecord & {
  episode: EpisodeRecord | null;
};
type ReviewWithRender = RovelleRenderReview & { render: FinalReviewRender };

type CandidateEpisode = EpisodeRecord & {
  code: string;
  title: string;
};
type CandidateRender = FinalReviewRender & {
  episode: CandidateEpisode;
  reviews: RovelleRenderReview[];
};
type CandidateRepository = {
  listFinalReviewCandidates(
    episodeId?: string,
  ): Promise<Array<{
    episode: CandidateEpisode;
    render: CandidateRender;
    reviews: RovelleRenderReview[];
  }>>;
};
type ApprovedMasterRepository = {
  findApprovedMaster(episodeId: string): Promise<{
    episode: CandidateEpisode;
    render: CandidateRender;
  } | null>;
  episodeExists(episodeId: string): Promise<boolean>;
};

type RepositoryCall = {
  operation: string;
  args: unknown;
  inTransaction: boolean;
};

type FakeState = {
  renders: FinalReviewRender[];
  episodes: EpisodeRecord[];
  reviews: RovelleRenderReview[];
};

type FakeOptions = {
  renders?: FinalReviewRender[];
  episodes?: EpisodeRecord[];
  reviews?: RovelleRenderReview[];
  omitRenderEpisode?: boolean;
  raceReview?: RovelleRenderReview | null;
  createErrors?: unknown[];
  transactionErrors?: unknown[];
  episodeUpdateCounts?: number[];
};

const EPISODE_ID = "550e8400-e29b-41d4-a716-446655440000";
const OTHER_EPISODE_ID = "650e8400-e29b-41d4-a716-446655440000";
const REQUEST_ID = "750e8400-e29b-41d4-a716-446655440000";
const OTHER_REQUEST_ID = "850e8400-e29b-41d4-a716-446655440000";
const RENDER_ID = "950e8400-e29b-41d4-a716-446655440000";
const OTHER_RENDER_ID = "a50e8400-e29b-41d4-a716-446655440000";
const OUTPUT_ASSET_ID = "b50e8400-e29b-41d4-a716-446655440000";
const REVIEW_ID = "c50e8400-e29b-41d4-a716-446655440000";
const OTHER_REVIEW_ID = "d50e8400-e29b-41d4-a716-446655440000";
const JOB_ID = "e50e8400-e29b-41d4-a716-446655440000";

function asset(changes: Partial<RovelleAsset> = {}): RovelleAsset {
  return {
    id: OUTPUT_ASSET_ID,
    episodeId: EPISODE_ID,
    assetType: RovelleAssetType.RENDER,
    status: RovelleAssetStatus.AVAILABLE,
    mediaType: "video/mp4",
    storageKey: "rovelle/private/render.mp4",
    originalFilename: "render.mp4",
    byteSize: 42n,
    etag: "etag-1",
    createdAt: new Date("2026-08-29T00:00:00.000Z"),
    updatedAt: new Date("2026-08-29T00:00:00.000Z"),
    ...changes,
  };
}

function job(changes: Partial<RovelleRenderJob> = {}): RovelleRenderJob {
  return {
    id: JOB_ID,
    clientRequestId: OTHER_REQUEST_ID,
    renderId: RENDER_ID,
    attempt: 1,
    status: RovelleRenderJobStatus.SUCCEEDED,
    availableAt: new Date("2026-08-29T00:00:00.000Z"),
    workerId: "render-worker",
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
    ...changes,
  };
}

function episode(
  changes: Partial<EpisodeRecord> = {},
): EpisodeRecord {
  return {
    id: EPISODE_ID,
    status: RovelleEpisodeStatus.FINAL_REVIEW,
    approvedRenderId: null,
    ...changes,
  };
}

function render(
  changes: Partial<FinalReviewRender> = {},
): FinalReviewRender {
  return {
    id: RENDER_ID,
    clientRequestId: OTHER_REQUEST_ID,
    episodeId: EPISODE_ID,
    attempt: 1,
    profile: RovelleRenderProfile.VERTICAL_SHORT_V1,
    status: RovelleRenderStatus.COMPLETED,
    specVersion: 1,
    spec: { version: 1, hash: "unchanged" },
    specHash: "a".repeat(64),
    outputAssetId: OUTPUT_ASSET_ID,
    completedAt: new Date("2026-08-29T00:02:00.000Z"),
    createdAt: new Date("2026-08-29T00:00:00.000Z"),
    updatedAt: new Date("2026-08-29T00:02:00.000Z"),
    outputAsset: asset(),
    jobs: [job()],
    episode: episode(),
    ...changes,
  } as FinalReviewRender;
}

function review(
  changes: Partial<RovelleRenderReview> = {},
): RovelleRenderReview {
  return {
    id: REVIEW_ID,
    clientRequestId: REQUEST_ID,
    renderId: RENDER_ID,
    reviewerType: RovelleReviewerType.HUMAN,
    decision: RovelleRenderReviewDecision.REJECT,
    notes: "Needs another pass.",
    createdAt: new Date("2026-08-29T00:03:00.000Z"),
    ...changes,
  };
}

function input(
  changes: Partial<Parameters<FinalReviewRepository["submitHumanReview"]>[0]> = {},
) {
  return {
    clientRequestId: REQUEST_ID,
    renderId: RENDER_ID,
    decision: RovelleRenderReviewDecision.APPROVE,
    notes: "Approved by human reviewer.",
    ...changes,
  };
}

function createFake(options: FakeOptions = {}) {
  const initialRender = render();
  const state: FakeState = {
    renders: options.renders ?? [initialRender],
    episodes: options.episodes ?? [episode()],
    reviews: options.reviews ?? [],
  };
  const calls: RepositoryCall[] = [];
  const committedWrites: string[] = [];
  const rolledBackWrites: string[] = [];
  const createErrors = [...(options.createErrors ?? [])];
  const transactionErrors = [...(options.transactionErrors ?? [])];
  const episodeUpdateCounts = [...(options.episodeUpdateCounts ?? [])];
  let inTransaction = false;
  let transactionCount = 0;
  let stagedWrites: string[] = [];

  const record = (operation: string, args: unknown) =>
    calls.push({ operation, args, inTransaction });
  const write = (operation: string) => stagedWrites.push(operation);
  const findEpisode = (id: string) => state.episodes.find((value) => value.id === id) ?? null;
  const findRender = (id: string) => state.renders.find((value) => value.id === id) ?? null;
  const withCurrentEpisode = (value: FinalReviewRender): FinalReviewRender => ({
    ...value,
    episode: options.omitRenderEpisode ? null : findEpisode(value.episodeId),
  });
  const reviewWithRender = (value: RovelleRenderReview): ReviewWithRender => ({
    ...value,
    render: withCurrentEpisode(findRender(value.renderId)!),
  });

  const transactionClient = {
    rovelleRenderReview: {
      findUnique: async (args: unknown) => {
        record("tx.review.findUnique", args);
        const where = (args as { where: Record<string, string> }).where;
        const found = "clientRequestId" in where
          ? state.reviews.find((value) => value.clientRequestId === where.clientRequestId)
          : state.reviews.find((value) => value.id === where.id);
        return found ? reviewWithRender(found) : null;
      },
      create: async (args: unknown) => {
        record("tx.review.create", args);
        const error = createErrors.shift();
        if (error !== undefined) throw error;
        const data = (args as { data: Record<string, unknown> }).data;
        const created = {
          id: `review-${state.reviews.length + 1}`,
          clientRequestId: data.clientRequestId,
          renderId: data.renderId,
          reviewerType: data.reviewerType,
          decision: data.decision,
          notes: data.notes,
          createdAt: new Date("2026-08-29T00:04:00.000Z"),
        } as RovelleRenderReview;
        state.reviews.push(created);
        write("review");
        return created;
      },
    },
    rovelleRender: {
      findUnique: async (args: unknown) => {
        record("tx.render.findUnique", args);
        const id = (args as { where: { id: string } }).where.id;
        const found = findRender(id);
        return found ? withCurrentEpisode(found) : null;
      },
    },
    rovelleEpisode: {
      findUnique: async (args: unknown) => {
        record("tx.episode.findUnique", args);
        const id = (args as { where: { id: string } }).where.id;
        const found = findEpisode(id);
        return found ? { ...found } : null;
      },
      updateMany: async (args: unknown) => {
        record("tx.episode.updateMany", args);
        const data = (args as { data: Partial<EpisodeRecord> }).data;
        const where = (args as { where: { id: string; status: RovelleEpisodeStatus } }).where;
        const count = episodeUpdateCounts.shift() ?? 1;
        if (count === 1) {
          const found = findEpisode(where.id);
          if (found && found.status === where.status) {
            Object.assign(found, data);
          }
        }
        write("episode");
        return { count };
      },
    },
  };

  const client = {
    $transaction: async <T>(
      callback: (tx: typeof transactionClient) => Promise<T>,
      transactionOptions: unknown,
    ): Promise<T> => {
      record("$transaction", transactionOptions);
      transactionCount += 1;
      const transactionError = transactionErrors.shift();
      if (transactionError !== undefined) throw transactionError;

      const snapshot = structuredClone(state);
      inTransaction = true;
      stagedWrites = [];
      try {
        const result = await callback(transactionClient);
        committedWrites.push(...stagedWrites);
        return result;
      } catch (error) {
        state.renders = snapshot.renders;
        state.episodes = snapshot.episodes;
        state.reviews = snapshot.reviews;
        rolledBackWrites.push(...stagedWrites);
        throw error;
      } finally {
        inTransaction = false;
      }
    },
    rovelleRenderReview: {
      findUnique: async (args: unknown) => {
        record("client.review.findUnique", args);
        if (options.raceReview) return reviewWithRender(options.raceReview);
        const where = (args as { where: { clientRequestId?: string; id?: string } }).where;
        const found = where.clientRequestId
          ? state.reviews.find((value) => value.clientRequestId === where.clientRequestId)
          : state.reviews.find((value) => value.id === where.id);
        return found ? reviewWithRender(found) : null;
      },
      findMany: async (args: unknown) => {
        record("client.review.findMany", args);
        return [...state.reviews].sort(
          (left, right) =>
            left.createdAt.getTime() - right.createdAt.getTime() ||
            left.id.localeCompare(right.id),
        );
      },
    },
  };

  return {
    repository: new FinalReviewRepository({ client } as unknown as PrismaService),
    calls,
    state,
    committedWrites,
    rolledBackWrites,
    get transactionCount() {
      return transactionCount;
    },
  };
}

function callsFor(calls: RepositoryCall[], operation: string) {
  return calls.filter((call) => call.operation === operation);
}

function reviewCallData(call: RepositoryCall): Record<string, unknown> {
  return (call.args as { data: Record<string, unknown> }).data;
}

function candidateRender(
  changes: Partial<CandidateRender> & {
    episode: CandidateEpisode;
  },
): CandidateRender {
  const { episode: candidateEpisode, ...renderChanges } = changes;
  return {
    ...render({
      episode: candidateEpisode,
      episodeId: candidateEpisode.id,
      ...renderChanges,
    }),
    reviews: [],
    ...changes,
  } as CandidateRender;
}

function createCandidateFake(renders: CandidateRender[]) {
  const calls: RepositoryCall[] = [];
  const client = {
    rovelleRender: {
      findMany: async (args: unknown) => {
        calls.push({ operation: "client.render.findMany", args, inTransaction: false });
        return renders;
      },
    },
  };

  return {
    repository: new FinalReviewRepository({ client } as unknown as PrismaService),
    calls,
  };
}

function createApprovedMasterFake(options: {
  episode: CandidateEpisode | null;
  approvedRender: CandidateRender | null;
}) {
  const calls: RepositoryCall[] = [];
  const client = {
    rovelleEpisode: {
      findUnique: async (args: unknown) => {
        calls.push({ operation: "client.episode.findUnique", args, inTransaction: false });
        if ("include" in (args as object)) {
          if (!options.episode) return null;
          return {
            ...options.episode,
            approvedRender: options.approvedRender,
          };
        }
        return options.episode ? { id: options.episode.id } : null;
      },
    },
  };

  return {
    repository: new FinalReviewRepository({ client } as unknown as PrismaService),
    calls,
  };
}

describe("Rovelle final review repository", () => {
  test("uses a serializable transaction and resolves an existing request first", async () => {
    const existing = review();
    const fake = createFake({
      reviews: [existing],
      episodes: [episode({ status: RovelleEpisodeStatus.PUBLISH_READY })],
    });

    const result = await fake.repository.submitHumanReview(input());

    assert.equal(result.status, "existing");
    assert.equal(fake.transactionCount, 1);
    assert.deepEqual(fake.calls[0], {
      operation: "$transaction",
      args: { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      inTransaction: false,
    });
    assert.equal(fake.calls[1]?.operation, "tx.review.findUnique");
    assert.equal(callsFor(fake.calls, "tx.review.create").length, 0);
    assert.equal(callsFor(fake.calls, "tx.episode.updateMany").length, 0);
    assert.equal(fake.state.reviews.length, 1);
    if (result.status === "existing") {
      assert.equal(result.review.id, existing.id);
      assert.equal(result.render.id, RENDER_ID);
      assert.equal(result.episode.status, RovelleEpisodeStatus.PUBLISH_READY);
    }
  });

  test("returns request_conflict before loading or mutating a different render", async () => {
    const fake = createFake({
      reviews: [review({ renderId: OTHER_RENDER_ID })],
      renders: [render(), render({ id: OTHER_RENDER_ID, episodeId: OTHER_EPISODE_ID })],
      episodes: [episode(), episode({ id: OTHER_EPISODE_ID })],
    });

    const result = await fake.repository.submitHumanReview(input());

    assert.deepEqual(result, { status: "request_conflict" });
    assert.equal(callsFor(fake.calls, "tx.render.findUnique").length, 0);
    assert.equal(callsFor(fake.calls, "tx.review.create").length, 0);
    assert.equal(fake.state.reviews.length, 1);
  });

  test("keeps an existing request idempotent after generation approval", async () => {
    const fake = createFake({
      reviews: [review()],
      episodes: [episode({ status: RovelleEpisodeStatus.GENERATION_APPROVED })],
    });

    const result = await fake.repository.submitHumanReview(
      input({ decision: RovelleRenderReviewDecision.RERENDER }),
    );

    assert.equal(result.status, "existing");
    assert.equal(fake.state.episodes[0]?.status, RovelleEpisodeStatus.GENERATION_APPROVED);
    assert.equal(fake.state.reviews.length, 1);
    assert.equal(callsFor(fake.calls, "tx.episode.updateMany").length, 0);
  });

  test("returns not_found when a new request names no render", async () => {
    const fake = createFake({ renders: [] });

    assert.deepEqual(
      await fake.repository.submitHumanReview(input()),
      { status: "not_found" },
    );
    assert.equal(callsFor(fake.calls, "tx.review.create").length, 0);
  });

  test("loads episode state by render episodeId when the render relation is absent", async () => {
    const fake = createFake({ omitRenderEpisode: true });

    const result = await fake.repository.submitHumanReview(input());

    assert.equal(result.status, "reviewed");
    assert.equal(fake.state.episodes[0]?.approvedRenderId, RENDER_ID);
    assert.equal(callsFor(fake.calls, "tx.episode.findUnique").length, 2);
  });

  test("maps every non-completed render to render_not_reviewable", async () => {
    for (const status of [
      RovelleRenderStatus.QUEUED,
      RovelleRenderStatus.RUNNING,
      RovelleRenderStatus.FAILED,
    ]) {
      const fake = createFake({ renders: [render({ status })] });

      assert.deepEqual(
        await fake.repository.submitHumanReview(input()),
        { status: "render_not_reviewable" },
      );
      assert.equal(callsFor(fake.calls, "tx.review.create").length, 0);
    }
  });

  test("maps every invalid output asset to output_not_available", async () => {
    const invalidOutputs: Array<Partial<RovelleAsset>> = [
      { id: "wrong-output-id" },
      { episodeId: OTHER_EPISODE_ID },
      { status: RovelleAssetStatus.RESERVED },
      { assetType: RovelleAssetType.GENERATION },
      { mediaType: "audio/mpeg" },
      { mediaType: null as unknown as string },
      { byteSize: null },
      { byteSize: undefined as unknown as bigint },
    ];

    for (const changes of invalidOutputs) {
      const fake = createFake({
        renders: [render({ outputAsset: asset(changes) })],
      });

      assert.deepEqual(
        await fake.repository.submitHumanReview(input()),
        { status: "output_not_available" },
      );
      assert.equal(callsFor(fake.calls, "tx.review.create").length, 0);
    }
  });

  test("maps a missing output relation to output_not_available", async () => {
    const fake = createFake({
      renders: [render({ outputAsset: null as unknown as RovelleAsset })],
    });

    assert.deepEqual(
      await fake.repository.submitHumanReview(input()),
      { status: "output_not_available" },
    );
    assert.equal(callsFor(fake.calls, "tx.review.create").length, 0);
  });

  test("requires FINAL_REVIEW for every new decision", async () => {
    for (const status of [
      RovelleEpisodeStatus.PUBLISH_READY,
      RovelleEpisodeStatus.GENERATION_APPROVED,
      RovelleEpisodeStatus.RENDERING,
    ]) {
      const fake = createFake({ episodes: [episode({ status })] });

      for (const decision of [
        RovelleRenderReviewDecision.APPROVE,
        RovelleRenderReviewDecision.REJECT,
        RovelleRenderReviewDecision.RERENDER,
      ]) {
        assert.deepEqual(
          await fake.repository.submitHumanReview(input({ decision })),
          { status: "invalid_episode_state" },
        );
      }
      assert.equal(fake.state.reviews.length, 0);
    }
  });

  test("approves the render's own episode without mutating render inputs", async () => {
    const original = structuredClone(render());
    const fake = createFake();

    const result = await fake.repository.submitHumanReview(input());

    assert.equal(result.status, "reviewed");
    assert.equal(fake.state.episodes[0]?.status, RovelleEpisodeStatus.PUBLISH_READY);
    assert.equal(fake.state.episodes[0]?.approvedRenderId, RENDER_ID);
    assert.equal(fake.state.reviews.length, 1);
    assert.deepEqual(fake.state.renders[0], original);
    assert.deepEqual(reviewCallData(callsFor(fake.calls, "tx.review.create")[0]!), {
      clientRequestId: REQUEST_ID,
      renderId: RENDER_ID,
      reviewerType: RovelleReviewerType.HUMAN,
      decision: RovelleRenderReviewDecision.APPROVE,
      notes: "Approved by human reviewer.",
    });
    assert.deepEqual(
      (callsFor(fake.calls, "tx.episode.updateMany")[0]?.args as { where: unknown; data: unknown }),
      {
        where: { id: EPISODE_ID, status: RovelleEpisodeStatus.FINAL_REVIEW },
        data: {
          approvedRenderId: RENDER_ID,
          status: RovelleEpisodeStatus.PUBLISH_READY,
        },
      },
    );
    assert.equal(callsFor(fake.calls, "tx.render.create").length, 0);
    assert.equal(callsFor(fake.calls, "tx.renderJob.create").length, 0);
    assert.equal(callsFor(fake.calls, "tx.asset.create").length, 0);
    if (result.status === "reviewed") {
      assert.equal(result.render.status, RovelleRenderStatus.COMPLETED);
      assert.equal(result.render.outputAsset.status, RovelleAssetStatus.AVAILABLE);
      assert.equal(result.render.specHash, original.specHash);
      assert.deepEqual(result.render.spec, original.spec);
      assert.deepEqual(result.episode, {
        id: EPISODE_ID,
        status: RovelleEpisodeStatus.PUBLISH_READY,
        approvedRenderId: RENDER_ID,
      });
    }
  });

  test("approves an explicitly selected older completed render", async () => {
    const older = render({ id: RENDER_ID, attempt: 1 });
    const latest = render({
      id: OTHER_RENDER_ID,
      attempt: 2,
      episodeId: EPISODE_ID,
      outputAsset: asset({ id: "f50e8400-e29b-41d4-a716-446655440000" }),
      jobs: [job({ id: "125e8400-e29b-41d4-a716-446655440000", renderId: OTHER_RENDER_ID })],
    });
    const fake = createFake({ renders: [older, latest] });

    const result = await fake.repository.submitHumanReview(input({ renderId: RENDER_ID }));

    assert.equal(result.status, "reviewed");
    assert.equal(fake.state.episodes[0]?.approvedRenderId, RENDER_ID);
    assert.equal(fake.state.renders[1]?.status, RovelleRenderStatus.COMPLETED);
    assert.equal(fake.state.renders[1]?.specHash, latest.specHash);
  });

  test("appends rejects while leaving FINAL_REVIEW and the render unchanged", async () => {
    const original = structuredClone(render());
    const fake = createFake();

    const first = await fake.repository.submitHumanReview(
      input({ decision: RovelleRenderReviewDecision.REJECT }),
    );
    const second = await fake.repository.submitHumanReview(
      input({
        clientRequestId: OTHER_REQUEST_ID,
        decision: RovelleRenderReviewDecision.REJECT,
        notes: null,
      }),
    );

    assert.equal(first.status, "reviewed");
    assert.equal(second.status, "reviewed");
    assert.equal(fake.state.reviews.length, 2);
    assert.equal(fake.state.episodes[0]?.status, RovelleEpisodeStatus.FINAL_REVIEW);
    assert.equal(fake.state.episodes[0]?.approvedRenderId, null);
    assert.deepEqual(fake.state.renders[0], original);
    assert.equal(callsFor(fake.calls, "tx.episode.updateMany").length, 0);
  });

  test("allows approval after a rejection and retains both audit rows", async () => {
    const fake = createFake();

    await fake.repository.submitHumanReview(
      input({ decision: RovelleRenderReviewDecision.REJECT }),
    );
    const result = await fake.repository.submitHumanReview(
      input({
        clientRequestId: OTHER_REQUEST_ID,
        decision: RovelleRenderReviewDecision.APPROVE,
      }),
    );

    assert.equal(result.status, "reviewed");
    assert.equal(fake.state.reviews.length, 2);
    assert.equal(fake.state.episodes[0]?.status, RovelleEpisodeStatus.PUBLISH_READY);
    assert.equal(fake.state.episodes[0]?.approvedRenderId, RENDER_ID);
  });

  test("rerenders through the episode transition without creating a render or job", async () => {
    const original = structuredClone(render());
    const fake = createFake();

    const result = await fake.repository.submitHumanReview(
      input({ decision: RovelleRenderReviewDecision.RERENDER }),
    );

    assert.equal(result.status, "reviewed");
    assert.equal(fake.state.episodes[0]?.status, RovelleEpisodeStatus.GENERATION_APPROVED);
    assert.equal(fake.state.episodes[0]?.approvedRenderId, null);
    assert.deepEqual(fake.state.renders[0], original);
    assert.equal(fake.state.reviews.length, 1);
    assert.equal(callsFor(fake.calls, "tx.render.create").length, 0);
    assert.equal(callsFor(fake.calls, "tx.renderJob.create").length, 0);
    assert.equal(callsFor(fake.calls, "tx.asset.create").length, 0);
    assert.deepEqual(
      (callsFor(fake.calls, "tx.episode.updateMany")[0]?.args as { where: unknown; data: unknown }),
      {
        where: { id: EPISODE_ID, status: RovelleEpisodeStatus.FINAL_REVIEW },
        data: {
          approvedRenderId: null,
          status: RovelleEpisodeStatus.GENERATION_APPROVED,
        },
      },
    );
  });

  test("maps a clientRequestId unique race to existing for the same render", async () => {
    const fake = createFake({
      createErrors: [{ code: "P2002" }],
      raceReview: review(),
    });

    const result = await fake.repository.submitHumanReview(input());

    assert.equal(result.status, "existing");
    assert.equal(callsFor(fake.calls, "client.review.findUnique").length, 1);
    assert.equal(fake.state.reviews.length, 0);
    assert.equal(fake.committedWrites.length, 0);
    assert.equal(fake.rolledBackWrites.includes("review"), false);
  });

  test("maps a clientRequestId unique race to request_conflict for another render", async () => {
    const other = render({ id: OTHER_RENDER_ID });
    const fake = createFake({
      createErrors: [{ code: "P2002" }],
      raceReview: review({ renderId: OTHER_RENDER_ID }),
      renders: [render(), other],
    });

    const result = await fake.repository.submitHumanReview(input());

    assert.deepEqual(result, { status: "request_conflict" });
    assert.equal(fake.state.reviews.length, 0);
    assert.equal(fake.committedWrites.length, 0);
  });

  test("rolls back the review when the guarded episode transition loses a race", async () => {
    const fake = createFake({ episodeUpdateCounts: [0] });

    const result = await fake.repository.submitHumanReview(input());

    assert.deepEqual(result, { status: "invalid_episode_state" });
    assert.equal(fake.state.reviews.length, 0);
    assert.equal(fake.committedWrites.length, 0);
    assert.equal(fake.rolledBackWrites.includes("review"), true);
  });

  test("retries serializable transaction failures with the same first lookup", async () => {
    const fake = createFake({ transactionErrors: [{ code: "P2034" }] });

    const result = await fake.repository.submitHumanReview(input());

    assert.equal(result.status, "reviewed");
    assert.equal(fake.transactionCount, 2);
    const lookups = callsFor(fake.calls, "tx.review.findUnique");
    assert.equal(lookups.length, 1);
    assert.equal(fake.calls.filter((call) => call.operation === "$transaction").length, 2);
  });

  test("lists reviews chronologically by createdAt then id", async () => {
    const first = review({
      id: OTHER_REVIEW_ID,
      createdAt: new Date("2026-08-29T00:05:00.000Z"),
    });
    const second = review({
      id: REVIEW_ID,
      createdAt: new Date("2026-08-29T00:04:00.000Z"),
    });
    const sameTime = review({
      id: "050e8400-e29b-41d4-a716-446655440000",
      createdAt: second.createdAt,
    });
    const fake = createFake({ reviews: [first, second, sameTime] });

    const result = await fake.repository.listRenderReviews(RENDER_ID);

    assert.deepEqual(result.map((value) => value.id), [
      sameTime.id,
      second.id,
      first.id,
    ]);
    assert.deepEqual(callsFor(fake.calls, "client.review.findMany")[0]?.args, {
      where: { renderId: RENDER_ID },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
  });

  test("returns an empty list for a valid render with no reviews", async () => {
    const fake = createFake();

    assert.deepEqual(await fake.repository.listRenderReviews(RENDER_ID), []);
  });

  test("lists only the highest valid completed render per FINAL_REVIEW episode", async () => {
    const firstEpisode: CandidateEpisode = {
      ...episode({ id: EPISODE_ID }),
      code: "EP-001",
      title: "First episode",
    };
    const secondEpisode: CandidateEpisode = {
      ...episode({ id: OTHER_EPISODE_ID }),
      code: "EP-002",
      title: "Second episode",
    };
    const finalButInvalidEpisode: CandidateEpisode = {
      ...episode({ id: "b50e8400-e29b-41d4-a716-446655440000" }),
      code: "EP-003",
      title: "No valid render",
    };
    const publishedEpisode: CandidateEpisode = {
      ...episode({
        id: "c50e8400-e29b-41d4-a716-446655440000",
        status: RovelleEpisodeStatus.PUBLISH_READY,
      }),
      code: "EP-000",
      title: "Already approved",
    };
    const firstAttempt = candidateRender({
      id: RENDER_ID,
      attempt: 1,
      episode: firstEpisode,
      reviews: [review({ createdAt: new Date("2026-08-29T00:03:00.000Z") })],
    });
    const latestAttempt = candidateRender({
      id: OTHER_RENDER_ID,
      attempt: 2,
      episode: firstEpisode,
      outputAssetId: "d50e8400-e29b-41d4-a716-446655440000",
      outputAsset: asset({ id: "d50e8400-e29b-41d4-a716-446655440000" }),
      reviews: [
        review({
          id: OTHER_REVIEW_ID,
          renderId: OTHER_RENDER_ID,
          createdAt: new Date("2026-08-29T00:05:00.000Z"),
        }),
        review({
          id: REVIEW_ID,
          renderId: OTHER_RENDER_ID,
          createdAt: new Date("2026-08-29T00:04:00.000Z"),
        }),
      ],
    });
    const secondEpisodeRender = candidateRender({
      id: "e50e8400-e29b-41d4-a716-446655440000",
      episodeId: OTHER_EPISODE_ID,
      attempt: 4,
      episode: secondEpisode,
      outputAssetId: "f50e8400-e29b-41d4-a716-446655440000",
      outputAsset: asset({
        id: "f50e8400-e29b-41d4-a716-446655440000",
        episodeId: OTHER_EPISODE_ID,
      }),
    });
    const invalidOnlyRender = candidateRender({
      id: "050e8400-e29b-41d4-a716-446655440000",
      episodeId: finalButInvalidEpisode.id,
      episode: finalButInvalidEpisode,
      outputAsset: asset({
        id: "150e8400-e29b-41d4-a716-446655440000",
        episodeId: finalButInvalidEpisode.id,
        status: RovelleAssetStatus.RESERVED,
      }),
    });
    const publishedRender = candidateRender({
      id: "250e8400-e29b-41d4-a716-446655440000",
      episodeId: publishedEpisode.id,
      episode: publishedEpisode,
      outputAsset: asset({
        id: "350e8400-e29b-41d4-a716-446655440000",
        episodeId: publishedEpisode.id,
      }),
    });
    const fake = createCandidateFake([
      latestAttempt,
      firstAttempt,
      secondEpisodeRender,
      invalidOnlyRender,
      publishedRender,
    ]);

    const result = await (
      fake.repository as unknown as CandidateRepository
    ).listFinalReviewCandidates();

    assert.deepEqual(
      result.map(({ episode, render: selected }) => [
        episode.code,
        selected.id,
        selected.attempt,
      ]),
      [
        ["EP-001", OTHER_RENDER_ID, 2],
        ["EP-002", "e50e8400-e29b-41d4-a716-446655440000", 4],
      ],
    );
    assert.deepEqual(result[0]?.reviews.map(({ id }) => id), [
      REVIEW_ID,
      OTHER_REVIEW_ID,
    ]);
  });

  test("keeps the highest valid completed render when newer attempts are invalid", async () => {
    const selectedEpisode: CandidateEpisode = {
      ...episode({ id: EPISODE_ID }),
      code: "EP-001",
      title: "Uses older valid render",
    };
    const validOlder = candidateRender({
      id: RENDER_ID,
      attempt: 1,
      episode: selectedEpisode,
    });
    const failedNewer = candidateRender({
      id: OTHER_RENDER_ID,
      attempt: 2,
      episode: selectedEpisode,
      status: RovelleRenderStatus.FAILED,
      outputAsset: asset({ id: "150e8400-e29b-41d4-a716-446655440000" }),
    });
    const queuedNewest = candidateRender({
      id: "250e8400-e29b-41d4-a716-446655440000",
      attempt: 3,
      episode: selectedEpisode,
      status: RovelleRenderStatus.QUEUED,
      outputAsset: asset({ id: "350e8400-e29b-41d4-a716-446655440000" }),
    });
    const fake = createCandidateFake([queuedNewest, failedNewer, validOlder]);

    const result = await (
      fake.repository as unknown as CandidateRepository
    ).listFinalReviewCandidates();

    assert.deepEqual(result.map(({ render: selected }) => selected.id), [RENDER_ID]);
  });

  test("filters candidate lookup to one episode without widening render validity", async () => {
    const selectedEpisode: CandidateEpisode = {
      ...episode({ id: EPISODE_ID }),
      code: "EP-001",
      title: "Selected episode",
    };
    const fake = createCandidateFake([
      candidateRender({ episode: selectedEpisode }),
    ]);

    await (
      fake.repository as unknown as CandidateRepository
    ).listFinalReviewCandidates(EPISODE_ID);

    assert.deepEqual(
      (fake.calls[0]?.args as { where: unknown }).where,
      {
        episode: { status: RovelleEpisodeStatus.FINAL_REVIEW },
        episodeId: EPISODE_ID,
        status: RovelleRenderStatus.COMPLETED,
        outputAsset: {
          status: RovelleAssetStatus.AVAILABLE,
          assetType: RovelleAssetType.RENDER,
          mediaType: { startsWith: "video/" },
        },
      },
    );
  });

  test("omits final-review episodes whose completed outputs are invalid", async () => {
    const invalidEpisode: CandidateEpisode = {
      ...episode({ id: EPISODE_ID }),
      code: "EP-001",
      title: "Invalid output",
    };
    const invalidOutputs: Array<Partial<RovelleAsset>> = [
      { id: "wrong-output-id" },
      { episodeId: OTHER_EPISODE_ID },
      { status: RovelleAssetStatus.RESERVED },
      { assetType: RovelleAssetType.GENERATION },
      { mediaType: "audio/mpeg" },
      { mediaType: null as unknown as string },
      { byteSize: null },
    ];

    for (const outputChanges of invalidOutputs) {
      const fake = createCandidateFake([
        candidateRender({
          episode: invalidEpisode,
          outputAsset: asset(outputChanges),
        }),
      ]);

      assert.deepEqual(
        await (
          fake.repository as unknown as CandidateRepository
        ).listFinalReviewCandidates(),
        [],
      );
    }
  });

  test("resolves the exact approved render pointer instead of the latest attempt", async () => {
    const approvedEpisode: CandidateEpisode = {
      ...episode({ approvedRenderId: RENDER_ID }),
      code: "EP-001",
      title: "Approved episode",
    };
    const approvedRender = candidateRender({
      id: RENDER_ID,
      attempt: 1,
      episode: approvedEpisode,
    });
    const latestRender = candidateRender({
      id: OTHER_RENDER_ID,
      attempt: 2,
      episode: approvedEpisode,
      outputAsset: asset({ id: "150e8400-e29b-41d4-a716-446655440000" }),
    });
    const fake = createApprovedMasterFake({
      episode: approvedEpisode,
      approvedRender,
    });

    const result = await (
      fake.repository as unknown as ApprovedMasterRepository
    ).findApprovedMaster(EPISODE_ID);

    assert.equal(result?.render.id, RENDER_ID);
    assert.equal(result?.render.attempt, 1);
    assert.equal(result?.episode.approvedRenderId, RENDER_ID);
    assert.equal(
      fake.calls.some((call) => call.operation === "client.render.findMany"),
      false,
    );
    void latestRender;
  });

  test("returns null when an episode or approved pointer is missing", async () => {
    const selectedEpisode: CandidateEpisode = {
      ...episode({ id: EPISODE_ID }),
      code: "EP-001",
      title: "No approved render",
    };
    const missing = createApprovedMasterFake({
      episode: null,
      approvedRender: null,
    });
    const noPointer = createApprovedMasterFake({
      episode: selectedEpisode,
      approvedRender: null,
    });

    assert.equal(
      await (
        missing.repository as unknown as ApprovedMasterRepository
      ).findApprovedMaster(EPISODE_ID),
      null,
    );
    assert.equal(
      await (
        noPointer.repository as unknown as ApprovedMasterRepository
      ).findApprovedMaster(EPISODE_ID),
      null,
    );
  });

  test("returns null for an approved pointer with an invalid render or output", async () => {
    const approvedEpisode: CandidateEpisode = {
      ...episode({ approvedRenderId: RENDER_ID }),
      code: "EP-001",
      title: "Invalid approved render",
    };
    const invalidRenders: CandidateRender[] = [
      candidateRender({
        id: OTHER_RENDER_ID,
        episode: approvedEpisode,
      }),
      candidateRender({
        id: RENDER_ID,
        episode: { ...approvedEpisode, id: OTHER_EPISODE_ID },
      }),
      candidateRender({
        id: RENDER_ID,
        episode: approvedEpisode,
        status: RovelleRenderStatus.FAILED,
      }),
      candidateRender({
        id: RENDER_ID,
        episode: approvedEpisode,
        outputAsset: asset({ status: RovelleAssetStatus.RESERVED }),
      }),
      candidateRender({
        id: RENDER_ID,
        episode: approvedEpisode,
        outputAsset: asset({ assetType: RovelleAssetType.GENERATION }),
      }),
      candidateRender({
        id: RENDER_ID,
        episode: approvedEpisode,
        outputAsset: asset({ mediaType: "audio/mpeg" }),
      }),
      candidateRender({
        id: RENDER_ID,
        episode: approvedEpisode,
        outputAsset: asset({ byteSize: null }),
      }),
    ];

    for (const approvedRender of invalidRenders) {
      const fake = createApprovedMasterFake({
        episode: approvedEpisode,
        approvedRender,
      });

      assert.equal(
        await (
          fake.repository as unknown as ApprovedMasterRepository
        ).findApprovedMaster(EPISODE_ID),
        null,
      );
    }
  });
});
