import { Injectable } from "@nestjs/common";
import {
  Prisma,
  RovelleAssetStatus,
  RovelleAssetType,
  RovelleGenerationStatus,
  RovelleReviewDecision,
  RovelleReviewerType,
  RovelleShotStatus,
  type RovelleReview,
} from "../../generated/prisma/client";
import { PrismaService } from "../../database/prisma.service";
import { deriveGenerationStageStatus } from "./generation-stage-state";

const GENERATION_INCLUDE = {
  shot: { include: { episode: true } },
  outputAsset: true,
} satisfies Prisma.RovelleShotGenerationInclude;

const REVIEWABLE_SHOT_STATUSES: RovelleShotStatus[] = [
  RovelleShotStatus.REVIEW_REQUIRED,
  RovelleShotStatus.APPROVED,
];

type ReviewWithGeneration = Prisma.RovelleReviewGetPayload<{
  include: { generation: { include: typeof GENERATION_INCLUDE } };
}>;

export type GenerationReviewMutationResult =
  | {
      status: "reviewed" | "existing";
      review: RovelleReview;
      generation: { id: string; status: RovelleGenerationStatus };
      shot: {
        id: string;
        status: RovelleShotStatus;
        approvedGenerationId: string | null;
      };
      episode: { id: string; status: string };
    }
  | { status: "not_found" }
  | { status: "request_conflict" }
  | { status: "generation_not_reviewable" }
  | { status: "output_not_available" }
  | { status: "invalid_shot_state" };

class ReviewStateChangedError extends Error {}

@Injectable()
export class GenerationReviewRepository {
  constructor(private readonly prisma: PrismaService) {}

  async submitHumanReview(input: {
    clientRequestId: string;
    generationId: string;
    decision: RovelleReviewDecision;
    notes: string | null;
  }): Promise<GenerationReviewMutationResult> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.prisma.client.$transaction(
          (tx) => this.submitInTransaction(tx, input),
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
      } catch (error) {
        if (error instanceof ReviewStateChangedError) {
          return { status: "invalid_shot_state" };
        }
        if (isUniqueConstraintError(error)) {
          const existing = await this.findByRequestId(input.clientRequestId);
          if (existing)
            return this.existingResult(existing, input.generationId);
        }
        if (attempt < 2 && isSerializableTransactionError(error)) continue;
        throw error;
      }
    }
  }

  private async submitInTransaction(
    tx: Prisma.TransactionClient,
    input: {
      clientRequestId: string;
      generationId: string;
      decision: RovelleReviewDecision;
      notes: string | null;
    },
  ): Promise<GenerationReviewMutationResult> {
    const existing = await tx.rovelleReview.findUnique({
      where: { clientRequestId: input.clientRequestId },
      include: { generation: { include: GENERATION_INCLUDE } },
    });
    if (existing) return this.existingResult(existing, input.generationId);

    const generation = await tx.rovelleShotGeneration.findUnique({
      where: { id: input.generationId },
      include: GENERATION_INCLUDE,
    });
    if (!generation) return { status: "not_found" };
    if (generation.status !== RovelleGenerationStatus.COMPLETED) {
      return { status: "generation_not_reviewable" };
    }
    if (!isReviewableOutput(generation))
      return { status: "output_not_available" };
    if (!REVIEWABLE_SHOT_STATUSES.includes(generation.shot.status)) {
      return { status: "invalid_shot_state" };
    }

    const review = await tx.rovelleReview.create({
      data: {
        clientRequestId: input.clientRequestId,
        generationId: generation.id,
        reviewerType: RovelleReviewerType.HUMAN,
        decision: input.decision,
        notes: input.notes,
      },
    });

    if (input.decision !== RovelleReviewDecision.REJECT) {
      const changed = await tx.rovelleShot.updateMany({
        where: {
          id: generation.shotId,
          status: { in: REVIEWABLE_SHOT_STATUSES },
        },
        data:
          input.decision === RovelleReviewDecision.APPROVE
            ? {
                status: RovelleShotStatus.APPROVED,
                approvedGenerationId: generation.id,
              }
            : {
                status: RovelleShotStatus.READY_TO_GENERATE,
                approvedGenerationId: null,
              },
      });
      if (changed.count !== 1) throw new ReviewStateChangedError();
    }

    const shots = await tx.rovelleShot.findMany({
      where: { episodeId: generation.shot.episodeId },
      select: { status: true },
    });
    const status = deriveGenerationStageStatus({
      totalShots: shots.length,
      pendingShots: shots.filter(
        (shot) =>
          shot.status === RovelleShotStatus.READY_TO_GENERATE ||
          shot.status === RovelleShotStatus.GENERATING,
      ).length,
      approvedShots: shots.filter(
        (shot) => shot.status === RovelleShotStatus.APPROVED,
      ).length,
    });
    const episode = await tx.rovelleEpisode.updateMany({
      where: { id: generation.shot.episodeId },
      data: { status },
    });
    if (episode.count !== 1) throw new ReviewStateChangedError();

    return this.reviewedResult(review, generation.id, tx);
  }

  private async reviewedResult(
    review: RovelleReview,
    generationId: string,
    tx: Prisma.TransactionClient,
  ): Promise<GenerationReviewMutationResult> {
    const persisted = await tx.rovelleReview.findUnique({
      where: { id: review.id },
      include: { generation: { include: GENERATION_INCLUDE } },
    });
    if (!persisted || persisted.generationId !== generationId) {
      throw new ReviewStateChangedError();
    }
    return this.toResult("reviewed", persisted);
  }

  private async findByRequestId(
    clientRequestId: string,
  ): Promise<ReviewWithGeneration | null> {
    return this.prisma.client.rovelleReview.findUnique({
      where: { clientRequestId },
      include: { generation: { include: GENERATION_INCLUDE } },
    });
  }

  private existingResult(
    review: ReviewWithGeneration,
    generationId: string,
  ): GenerationReviewMutationResult {
    if (review.generationId !== generationId)
      return { status: "request_conflict" };
    return this.toResult("existing", review);
  }

  private toResult(
    status: "reviewed" | "existing",
    record: ReviewWithGeneration,
  ): GenerationReviewMutationResult {
    const { generation, ...review } = record;
    return {
      status,
      review,
      generation: { id: generation.id, status: generation.status },
      shot: {
        id: generation.shot.id,
        status: generation.shot.status,
        approvedGenerationId: generation.shot.approvedGenerationId,
      },
      episode: {
        id: generation.shot.episode.id,
        status: generation.shot.episode.status,
      },
    };
  }
}

function isReviewableOutput(generation: {
  outputAssetId: string;
  shot: { episodeId: string };
  outputAsset: {
    id: string;
    episodeId: string | null;
    assetType: RovelleAssetType;
    status: RovelleAssetStatus;
    mediaType: string;
    byteSize: bigint | null;
  } | null;
}): boolean {
  const asset = generation.outputAsset;
  return (
    !!asset &&
    asset.id === generation.outputAssetId &&
    asset.episodeId === generation.shot.episodeId &&
    asset.assetType === RovelleAssetType.GENERATION &&
    asset.status === RovelleAssetStatus.AVAILABLE &&
    asset.mediaType.startsWith("video/") &&
    asset.byteSize !== null
  );
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  );
}

function isSerializableTransactionError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2034"
  );
}
