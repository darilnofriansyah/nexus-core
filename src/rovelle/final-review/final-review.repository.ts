import { Injectable } from "@nestjs/common";
import {
  Prisma,
  RovelleAssetStatus,
  RovelleAssetType,
  RovelleEpisodeStatus,
  RovelleRenderReviewDecision,
  RovelleRenderStatus,
  RovelleReviewerType,
  type RovelleRenderReview,
} from "../../generated/prisma/client";
import { PrismaService } from "../../database/prisma.service";
import type { InternalRenderRecord } from "../render/render.repository";

const RENDER_INCLUDE = {
  episode: {
    select: {
      id: true,
      status: true,
      approvedRenderId: true,
    },
  },
  outputAsset: true,
  jobs: { orderBy: { attempt: "asc" as const } },
} satisfies Prisma.RovelleRenderInclude;

const CANDIDATE_RENDER_INCLUDE = {
  episode: {
    select: {
      id: true,
      code: true,
      title: true,
      status: true,
      approvedRenderId: true,
    },
  },
  outputAsset: true,
  jobs: { orderBy: { attempt: "asc" as const } },
  reviews: {
    orderBy: [{ createdAt: "asc" as const }, { id: "asc" as const }],
  },
} satisfies Prisma.RovelleRenderInclude;

type FinalReviewRenderRecord = Prisma.RovelleRenderGetPayload<{
  include: typeof RENDER_INCLUDE;
}>;

type ReviewWithRender = Prisma.RovelleRenderReviewGetPayload<{
  include: { render: { include: typeof RENDER_INCLUDE } };
}>;

type FinalReviewCandidateRenderRecord = Prisma.RovelleRenderGetPayload<{
  include: typeof CANDIDATE_RENDER_INCLUDE;
}>;

export type FinalReviewEpisodeSnapshot = {
  id: string;
  status: RovelleEpisodeStatus;
  approvedRenderId: string | null;
};

export type FinalReviewCandidateRecord = {
  episode: {
    id: string;
    code: string;
    title: string;
    status: RovelleEpisodeStatus;
  };
  render: InternalRenderRecord;
  reviews: RovelleRenderReview[];
};

export type ApprovedMasterRecord = {
  episode: {
    id: string;
    code: string;
    title: string;
    status: RovelleEpisodeStatus;
    approvedRenderId: string;
  };
  render: InternalRenderRecord;
};

export type FinalReviewMutationResult =
  | {
      status: "reviewed";
      review: RovelleRenderReview;
      render: InternalRenderRecord;
      episode: FinalReviewEpisodeSnapshot;
    }
  | {
      status: "existing";
      review: RovelleRenderReview;
      render: InternalRenderRecord;
      episode: FinalReviewEpisodeSnapshot;
    }
  | { status: "not_found" }
  | { status: "request_conflict" }
  | { status: "render_not_reviewable" }
  | { status: "output_not_available" }
  | { status: "invalid_episode_state" };

class FinalReviewStateChangedError extends Error {}

@Injectable()
export class FinalReviewRepository {
  constructor(private readonly prisma: PrismaService) {}

  async submitHumanReview(input: {
    clientRequestId: string;
    renderId: string;
    decision: RovelleRenderReviewDecision;
    notes: string | null;
  }): Promise<FinalReviewMutationResult> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.prisma.client.$transaction(
          async (tx) => this.submitInTransaction(tx, input),
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
      } catch (error) {
        if (error instanceof FinalReviewStateChangedError) {
          return { status: "invalid_episode_state" };
        }
        if (isUniqueConstraintError(error)) {
          const existing = await this.findReviewByRequestId(input.clientRequestId);
          if (existing) {
            if (existing.renderId !== input.renderId) {
              return { status: "request_conflict" };
            }
            const episode = existing.render.episode ??
              await this.findEpisodeById(existing.render.episodeId);
            if (!episode) throw new FinalReviewStateChangedError();
            return this.existingResult(existing, episode);
          }
        }
        if (attempt < 2 && isSerializableTransactionError(error)) continue;
        throw error;
      }
    }
  }

  async listRenderReviews(renderId: string): Promise<RovelleRenderReview[]> {
    return this.prisma.client.rovelleRenderReview.findMany({
      where: { renderId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
  }

  async listFinalReviewCandidates(
    episodeId?: string,
  ): Promise<FinalReviewCandidateRecord[]> {
    const renders = await this.prisma.client.rovelleRender.findMany({
      where: {
        ...(episodeId === undefined ? {} : { episodeId }),
        episode: { status: RovelleEpisodeStatus.FINAL_REVIEW },
        status: RovelleRenderStatus.COMPLETED,
        outputAsset: {
          status: RovelleAssetStatus.AVAILABLE,
          assetType: RovelleAssetType.RENDER,
          mediaType: { startsWith: "video/" },
        },
      },
      include: CANDIDATE_RENDER_INCLUDE,
      orderBy: [{ episodeId: "asc" }, { attempt: "desc" }, { id: "asc" }],
    });

    const selected = new Map<string, FinalReviewCandidateRenderRecord>();
    for (const render of renders) {
      if (!isValidFinalReviewRender(render)) continue;

      const current = selected.get(render.episodeId);
      if (
        current === undefined ||
        render.attempt > current.attempt ||
        (render.attempt === current.attempt && render.id < current.id)
      ) {
        selected.set(render.episodeId, render);
      }
    }

    return [...selected.values()]
      .sort(
        (left, right) =>
          left.episode.code.localeCompare(right.episode.code) ||
          left.episode.id.localeCompare(right.episode.id),
      )
      .map((render) => {
        const { episode, reviews, ...internalRender } = render;
        return {
          episode,
          render: internalRender,
          reviews: [...reviews].sort(compareReviews),
        };
      });
  }

  async findApprovedMaster(
    episodeId: string,
  ): Promise<ApprovedMasterRecord | null> {
    const episode = await this.prisma.client.rovelleEpisode.findUnique({
      where: { id: episodeId },
      include: {
        approvedRender: { include: RENDER_INCLUDE },
      },
    });

    if (!episode || !episode.approvedRenderId || !episode.approvedRender) {
      return null;
    }

    const render = episode.approvedRender;
    if (
      render.id !== episode.approvedRenderId ||
      render.episodeId !== episode.id ||
      !isValidApprovedMasterRender(render)
    ) {
      return null;
    }

    return {
      episode: {
        id: episode.id,
        code: episode.code,
        title: episode.title,
        status: episode.status,
        approvedRenderId: episode.approvedRenderId,
      },
      render,
    };
  }

  async episodeExists(episodeId: string): Promise<boolean> {
    const episode = await this.prisma.client.rovelleEpisode.findUnique({
      where: { id: episodeId },
      select: { id: true },
    });
    return episode !== null;
  }

  private async submitInTransaction(
    tx: Prisma.TransactionClient,
    input: {
      clientRequestId: string;
      renderId: string;
      decision: RovelleRenderReviewDecision;
      notes: string | null;
    },
  ): Promise<FinalReviewMutationResult> {
    const existing = await tx.rovelleRenderReview.findUnique({
      where: { clientRequestId: input.clientRequestId },
      include: { render: { include: RENDER_INCLUDE } },
    });
    if (existing) {
      if (existing.renderId !== input.renderId) {
        return { status: "request_conflict" };
      }
      const episode = existing.render.episode ??
        await this.reloadEpisode(tx, existing.render.episodeId);
      if (!episode) throw new FinalReviewStateChangedError();
      return this.existingResult(existing, episode);
    }

    const render = await tx.rovelleRender.findUnique({
      where: { id: input.renderId },
      include: RENDER_INCLUDE,
    });
    if (!render) return { status: "not_found" };
    if (render.status !== RovelleRenderStatus.COMPLETED) {
      return { status: "render_not_reviewable" };
    }
    if (!isReviewableOutput(render)) {
      return { status: "output_not_available" };
    }

    const episode = render.episode ??
      await this.reloadEpisode(tx, render.episodeId);
    if (!episode || episode.status !== RovelleEpisodeStatus.FINAL_REVIEW) {
      return { status: "invalid_episode_state" };
    }

    const review = await tx.rovelleRenderReview.create({
      data: {
        clientRequestId: input.clientRequestId,
        renderId: render.id,
        reviewerType: RovelleReviewerType.HUMAN,
        decision: input.decision,
        notes: input.notes,
      },
    });

    if (input.decision === RovelleRenderReviewDecision.REJECT) {
      const snapshot = await this.reloadEpisode(tx, render.episodeId);
      if (!snapshot) throw new FinalReviewStateChangedError();
      return { status: "reviewed", review, render, episode: snapshot };
    }

    const transition = input.decision === RovelleRenderReviewDecision.APPROVE
      ? {
          approvedRenderId: render.id,
          status: RovelleEpisodeStatus.PUBLISH_READY,
        }
      : {
          approvedRenderId: null,
          status: RovelleEpisodeStatus.GENERATION_APPROVED,
        };
    const updated = await tx.rovelleEpisode.updateMany({
      where: {
        id: render.episodeId,
        status: RovelleEpisodeStatus.FINAL_REVIEW,
      },
      data: transition,
    });
    if (updated.count !== 1) throw new FinalReviewStateChangedError();

    const snapshot = await this.reloadEpisode(tx, render.episodeId);
    if (!snapshot) throw new FinalReviewStateChangedError();
    return { status: "reviewed", review, render, episode: snapshot };
  }

  private async reloadEpisode(
    tx: Prisma.TransactionClient,
    id: string,
  ): Promise<FinalReviewEpisodeSnapshot | null> {
    return tx.rovelleEpisode.findUnique({
      where: { id },
      select: { id: true, status: true, approvedRenderId: true },
    });
  }

  private async findReviewByRequestId(
    clientRequestId: string,
  ): Promise<ReviewWithRender | null> {
    return this.prisma.client.rovelleRenderReview.findUnique({
      where: { clientRequestId },
      include: { render: { include: RENDER_INCLUDE } },
    });
  }

  private async findEpisodeById(
    id: string,
  ): Promise<FinalReviewEpisodeSnapshot | null> {
    return this.prisma.client.rovelleEpisode.findUnique({
      where: { id },
      select: { id: true, status: true, approvedRenderId: true },
    });
  }

  private existingResult(
    existing: ReviewWithRender,
    episode: FinalReviewEpisodeSnapshot,
  ): FinalReviewMutationResult {
    const { render, ...review } = existing;
    return {
      status: "existing",
      review,
      render,
      episode,
    };
  }
}

function isReviewableOutput(render: FinalReviewRenderRecord): boolean {
  const output = render.outputAsset;
  if (!output) return false;
  return (
    output.id === render.outputAssetId &&
    output.episodeId === render.episodeId &&
    output.status === RovelleAssetStatus.AVAILABLE &&
    output.assetType === RovelleAssetType.RENDER &&
    typeof output.mediaType === "string" &&
    output.mediaType.startsWith("video/") &&
    output.byteSize !== null &&
    output.byteSize !== undefined
  );
}

function isValidFinalReviewRender(render: {
  id: string;
  episodeId: string;
  outputAssetId: string;
  status: RovelleRenderStatus;
  episode: { id: string; status: RovelleEpisodeStatus } | null;
  outputAsset: {
    id: string;
    episodeId: string | null;
    status: RovelleAssetStatus;
    assetType: RovelleAssetType;
    mediaType: string;
    byteSize: bigint | null;
  } | null;
}): boolean {
  return isValidRenderForEpisodeStatuses(render, [RovelleEpisodeStatus.FINAL_REVIEW]);
}

function isValidApprovedMasterRender(render: {
  id: string;
  episodeId: string;
  outputAssetId: string;
  status: RovelleRenderStatus;
  episode: { id: string; status: RovelleEpisodeStatus } | null;
  outputAsset: {
    id: string;
    episodeId: string | null;
    status: RovelleAssetStatus;
    assetType: RovelleAssetType;
    mediaType: string;
    byteSize: bigint | null;
  } | null;
}): boolean {
  return isValidRenderForEpisodeStatuses(render, [
    RovelleEpisodeStatus.FINAL_REVIEW,
    RovelleEpisodeStatus.PUBLISH_READY,
    RovelleEpisodeStatus.PUBLISHING,
    RovelleEpisodeStatus.PUBLISHED,
  ]);
}

function isValidRenderForEpisodeStatuses(
  render: {
    id: string;
    episodeId: string;
    outputAssetId: string;
    status: RovelleRenderStatus;
    episode: { id: string; status: RovelleEpisodeStatus } | null;
    outputAsset: {
      id: string;
      episodeId: string | null;
      status: RovelleAssetStatus;
      assetType: RovelleAssetType;
      mediaType: string;
      byteSize: bigint | null;
    } | null;
  },
  episodeStatuses: readonly RovelleEpisodeStatus[],
): boolean {
  const output = render.outputAsset;
  return (
    render.episode !== null &&
    render.episode.id === render.episodeId &&
    episodeStatuses.includes(render.episode.status) &&
    render.status === RovelleRenderStatus.COMPLETED &&
    output !== null &&
    output.id === render.outputAssetId &&
    output.episodeId === render.episodeId &&
    output.status === RovelleAssetStatus.AVAILABLE &&
    output.assetType === RovelleAssetType.RENDER &&
    typeof output.mediaType === "string" &&
    output.mediaType.startsWith("video/") &&
    output.byteSize !== null
  );
}

function compareReviews(
  left: RovelleRenderReview,
  right: RovelleRenderReview,
): number {
  return left.createdAt.getTime() - right.createdAt.getTime() ||
    left.id.localeCompare(right.id);
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "P2002"
  );
}

function isSerializableTransactionError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  if ("code" in error && error.code === "P2034") return true;
  if (!("cause" in error)) return false;

  const cause = error.cause;
  return (
    typeof cause === "object" &&
    cause !== null &&
    "originalCode" in cause &&
    cause.originalCode === "40001"
  );
}
