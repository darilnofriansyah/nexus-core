import { BadRequestException, Injectable } from "@nestjs/common";
import {
  Prisma,
  RovelleAssetStatus,
  RovelleAssetType,
  RovelleEpisodeStatus,
  RovelleGenerationModality,
  RovelleGenerationProvider,
  RovelleGenerationStatus,
  RovelleShotGeneration,
  RovelleShotStatus,
  type RovelleAsset,
} from "../../generated/prisma/client";
import { PrismaService } from "../../database/prisma.service";
import { assertAssetId } from "../assets/asset-validation";
import {
  actualGenerationSpend,
  committedGenerationSpend,
} from "../review/generation-cost";
import { getGenerationProfile } from "./generation-profile";
import type { GenerationProfile } from "./dto/generation.dto";

const URL_PATTERN = /(?:\b[a-z][a-z\d+.-]*:(?=\S)|\/\/)/i;

const GENERATION_BUDGET_MUTABLE_EPISODE_STATUSES = [
  RovelleEpisodeStatus.DRAFT,
  RovelleEpisodeStatus.BRIEF_APPROVED,
  RovelleEpisodeStatus.PREPRODUCTION,
  RovelleEpisodeStatus.READY_TO_GENERATE,
  RovelleEpisodeStatus.GENERATING,
  RovelleEpisodeStatus.REVIEW_REQUIRED,
];

export type InternalGenerationRecord = RovelleShotGeneration;

export type GenerationWithOutputAsset = InternalGenerationRecord & {
  outputAsset: Pick<RovelleAsset, "storageKey">;
};

export type CreateGenerationAttemptResult =
  | { status: "created"; generation: InternalGenerationRecord }
  | { status: "existing"; generation: InternalGenerationRecord }
  | {
      status: "budget_exceeded";
      budgetUsd: Prisma.Decimal;
      committedUsd: Prisma.Decimal;
      requestedEstimateUsd: Prisma.Decimal;
      projectedUsd: Prisma.Decimal;
    }
  | { status: "not_found" }
  | { status: "invalid_shot_state" }
  | { status: "invalid_episode_state" };

export type MarkSubmittedResult =
  | { status: "submitted"; generation: InternalGenerationRecord }
  | { status: "already_terminal"; generation: InternalGenerationRecord }
  | { status: "not_found" }
  | { status: "invalid_state" };

export type MarkSubmissionFailedResult =
  | { status: "submission_failed"; generation: InternalGenerationRecord }
  | { status: "not_found" }
  | { status: "invalid_state" };

export type GenerationMutationResult =
  | { status: "updated"; generation: InternalGenerationRecord }
  | { status: "already_terminal"; generation: InternalGenerationRecord }
  | { status: "not_found" };

export interface CreateGenerationAttemptInput {
  clientRequestId: string;
  shotId: string;
  episodeId: string;
  providerTaskId: string;
  outputAssetId: string;
  outputStorageKey: string;
  profile: GenerationProfile;
  model: string;
  prompt: string;
  sanitizedRequest: Prisma.InputJsonValue;
  estimatedCostUsd: Prisma.Decimal;
  pricingSource: string;
}

class SubmissionStateChangedError extends Error {}
class GenerationTransitionChangedError extends Error {}

@Injectable()
export class GenerationRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findByClientRequestId(
    requestId: string,
  ): Promise<InternalGenerationRecord | null> {
    return this.prisma.client.rovelleShotGeneration.findUnique({
      where: { clientRequestId: requestId },
    });
  }

  async findById(id: string): Promise<InternalGenerationRecord | null> {
    return this.prisma.client.rovelleShotGeneration.findUnique({
      where: { id },
    });
  }

  async findByProviderTaskId(
    providerTaskId: string,
  ): Promise<GenerationWithOutputAsset | null> {
    return this.prisma.client.rovelleShotGeneration.findUnique({
      where: { providerTaskId },
      include: { outputAsset: { select: { storageKey: true } } },
    });
  }

  async listForShot(shotId: string): Promise<InternalGenerationRecord[]> {
    return this.prisma.client.rovelleShotGeneration.findMany({
      where: { shotId },
      orderBy: { attempt: "asc" },
    });
  }

  async getEpisodeCostSummary(episodeId: string): Promise<{
    episodeId: string;
    budgetUsd: Prisma.Decimal | null;
    actualSpentUsd: Prisma.Decimal;
    committedUsd: Prisma.Decimal;
  } | null> {
    const episode = await this.prisma.client.rovelleEpisode.findUnique({
      where: { id: episodeId },
      select: { id: true, generationBudgetUsd: true },
    });
    if (!episode) return null;

    const attempts = await this.prisma.client.rovelleShotGeneration.findMany({
      where: { shot: { episodeId } },
      select: {
        status: true,
        estimatedCostUsd: true,
        actualCostUsd: true,
      },
    });
    return {
      episodeId: episode.id,
      budgetUsd: episode.generationBudgetUsd,
      actualSpentUsd: actualGenerationSpend(attempts),
      committedUsd: committedGenerationSpend(attempts),
    };
  }

  async setEpisodeGenerationBudget(
    episodeId: string,
    budgetUsd: Prisma.Decimal | null,
  ): Promise<"updated" | "not_found" | "invalid_state"> {
    const updated = await this.prisma.client.rovelleEpisode.updateMany({
      where: {
        id: episodeId,
        status: { in: GENERATION_BUDGET_MUTABLE_EPISODE_STATUSES },
      },
      data: { generationBudgetUsd: budgetUsd },
    });
    if (updated.count === 1) return "updated";

    const episode = await this.prisma.client.rovelleEpisode.findUnique({
      where: { id: episodeId },
      select: { id: true },
    });
    return episode ? "invalid_state" : "not_found";
  }

  async createAttempt(
    input: CreateGenerationAttemptInput,
  ): Promise<CreateGenerationAttemptResult> {
    const sanitizedRequest = normalizeSanitizedRequest(
      input.sanitizedRequest,
      input.profile,
    );

    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.prisma.client.$transaction(
          async (tx) => {
            const existing = await tx.rovelleShotGeneration.findUnique({
              where: { clientRequestId: input.clientRequestId },
            });
            if (existing) return { status: "existing", generation: existing };

            const shot = await tx.rovelleShot.findUnique({
              where: { id: input.shotId },
              include: { episode: true },
            });
            if (!shot || shot.episodeId !== input.episodeId) {
              return { status: "not_found" };
            }
            if (shot.status !== RovelleShotStatus.READY_TO_GENERATE) {
              return { status: "invalid_shot_state" };
            }
            if (!isGenerationEpisode(shot.episode.status)) {
              return { status: "invalid_episode_state" };
            }

            const attempts = await tx.rovelleShotGeneration.findMany({
              where: { shot: { episodeId: input.episodeId } },
              select: {
                status: true,
                estimatedCostUsd: true,
                actualCostUsd: true,
              },
            });
            const committedUsd = committedGenerationSpend(attempts);
            const budgetUsd = shot.episode.generationBudgetUsd;
            if (budgetUsd !== null) {
              const projectedUsd = committedUsd.plus(input.estimatedCostUsd);
              if (projectedUsd.gt(budgetUsd)) {
                return {
                  status: "budget_exceeded",
                  budgetUsd,
                  committedUsd,
                  requestedEstimateUsd: input.estimatedCostUsd,
                  projectedUsd,
                };
              }
            }

            const latest = await tx.rovelleShotGeneration.aggregate({
              where: { shotId: input.shotId },
              _max: { attempt: true },
            });
            const attempt = (latest._max.attempt ?? 0) + 1;

            await tx.rovelleAsset.create({
              data: {
                id: input.outputAssetId,
                episodeId: input.episodeId,
                assetType: RovelleAssetType.GENERATION,
                status: RovelleAssetStatus.RESERVED,
                mediaType: "video/mp4",
                storageKey: input.outputStorageKey,
                originalFilename: null,
              },
            });
            const generation = await tx.rovelleShotGeneration.create({
              data: {
                clientRequestId: input.clientRequestId,
                shotId: input.shotId,
                attempt,
                provider: RovelleGenerationProvider.RUNWARE,
                modality: RovelleGenerationModality.VIDEO,
                profile: input.profile,
                model: input.model,
                providerTaskId: input.providerTaskId,
                prompt: input.prompt,
                request: sanitizedRequest,
                status: RovelleGenerationStatus.CREATED,
                outputAssetId: input.outputAssetId,
                estimatedCostUsd: input.estimatedCostUsd,
                pricingSource: input.pricingSource,
              },
            });

            return { status: "created", generation };
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          const existing = await this.findByClientRequestId(
            input.clientRequestId,
          );
          if (existing) return { status: "existing", generation: existing };
          throw error;
        }
        if (attempt < 2 && isSerializableTransactionError(error)) continue;
        throw error;
      }
    }
  }

  async markSubmitted(generationId: string): Promise<MarkSubmittedResult> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.prisma.client.$transaction(
          async (tx) => {
            const generation = await tx.rovelleShotGeneration.findUnique({
              where: { id: generationId },
              include: { shot: { include: { episode: true } } },
            });
            if (!generation) return { status: "not_found" };
            if (isSubmissionRaceSafeGeneration(generation.status)) {
              return { status: "already_terminal", generation };
            }
            if (
              generation.status !== RovelleGenerationStatus.CREATED ||
              generation.shot.status !== RovelleShotStatus.READY_TO_GENERATE ||
              !isGenerationEpisode(generation.shot.episode.status)
            ) {
              return { status: "invalid_state" };
            }

            const submitted = await tx.rovelleShotGeneration.updateMany({
              where: {
                id: generationId,
                status: RovelleGenerationStatus.CREATED,
              },
              data: {
                status: RovelleGenerationStatus.SUBMITTED,
                submittedAt: new Date(),
              },
            });
            const shot = await tx.rovelleShot.updateMany({
              where: {
                id: generation.shotId,
                status: RovelleShotStatus.READY_TO_GENERATE,
              },
              data: { status: RovelleShotStatus.GENERATING },
            });
            if (submitted.count !== 1 || shot.count !== 1) {
              throw new SubmissionStateChangedError();
            }

            const episode = await tx.rovelleEpisode.updateMany({
              where: {
                id: generation.shot.episodeId,
                status: generation.shot.episode.status,
              },
              data: { status: RovelleEpisodeStatus.GENERATING },
            });
            if (episode.count !== 1) throw new SubmissionStateChangedError();

            const reloaded = await tx.rovelleShotGeneration.findUnique({
              where: { id: generationId },
            });
            if (!reloaded) throw new SubmissionStateChangedError();
            return { status: "submitted", generation: reloaded };
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
      } catch (error) {
        if (error instanceof SubmissionStateChangedError) {
          const current = await this.findById(generationId);
          if (current && isSubmissionRaceSafeGeneration(current.status)) {
            return { status: "already_terminal", generation: current };
          }
          return { status: "invalid_state" };
        }
        if (attempt < 2 && isSerializableTransactionError(error)) continue;
        throw error;
      }
    }
  }

  async markProcessing(
    providerTaskId: string,
  ): Promise<GenerationMutationResult> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.prisma.client.$transaction(
          async (tx) => {
            const generation = await tx.rovelleShotGeneration.findUnique({
              where: { providerTaskId },
              include: { shot: { include: { episode: true } } },
            });
            if (!generation) return { status: "not_found" };
            if (
              generation.status === RovelleGenerationStatus.PROCESSING ||
              isTerminalGeneration(generation.status)
            ) {
              return { status: "already_terminal", generation };
            }

            const updated = await tx.rovelleShotGeneration.updateMany({
              where: {
                providerTaskId,
                status: {
                  in: [
                    RovelleGenerationStatus.CREATED,
                    RovelleGenerationStatus.SUBMITTED,
                  ],
                },
              },
              data: { status: RovelleGenerationStatus.PROCESSING },
            });
            if (updated.count !== 1) {
              const current = await tx.rovelleShotGeneration.findUnique({
                where: { providerTaskId },
              });
              if (!current) return { status: "not_found" };
              if (
                current.status === RovelleGenerationStatus.PROCESSING ||
                isTerminalGeneration(current.status)
              ) {
                return { status: "already_terminal", generation: current };
              }
              throw new GenerationTransitionChangedError();
            }

            await tx.rovelleShot.updateMany({
              where: {
                id: generation.shotId,
                status: {
                  in: [
                    RovelleShotStatus.READY_TO_GENERATE,
                    RovelleShotStatus.GENERATING,
                  ],
                },
              },
              data: { status: RovelleShotStatus.GENERATING },
            });
            await tx.rovelleEpisode.updateMany({
              where: {
                id: generation.shot.episodeId,
                status: {
                  in: [
                    RovelleEpisodeStatus.READY_TO_GENERATE,
                    RovelleEpisodeStatus.GENERATING,
                  ],
                },
              },
              data: { status: RovelleEpisodeStatus.GENERATING },
            });

            const reloaded = await tx.rovelleShotGeneration.findUnique({
              where: { id: generation.id },
            });
            if (!reloaded) throw new GenerationTransitionChangedError();
            return { status: "updated", generation: reloaded };
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
      } catch (error) {
        if (error instanceof GenerationTransitionChangedError) {
          if (attempt < 2) continue;
          throw error;
        }
        if (attempt < 2 && isSerializableTransactionError(error)) continue;
        throw error;
      }
    }
  }

  async completeGeneration(
    providerTaskId: string,
    input: {
      providerOutputId: string | null;
      actualCostUsd: Prisma.Decimal | null;
      byteSize: bigint;
      etag: string | null;
    },
  ): Promise<GenerationMutationResult> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.prisma.client.$transaction(
          async (tx) => {
            const generation = await tx.rovelleShotGeneration.findUnique({
              where: { providerTaskId },
              include: { shot: { include: { episode: true } } },
            });
            if (!generation) return { status: "not_found" };
            if (isTerminalGeneration(generation.status)) {
              return { status: "already_terminal", generation };
            }
            if (!isPreTerminalGeneration(generation.status)) {
              return { status: "not_found" };
            }

            const outputAsset = await tx.rovelleAsset.findUnique({
              where: { id: generation.outputAssetId },
            });
            if (
              !outputAsset ||
              outputAsset.id !== generation.outputAssetId ||
              outputAsset.episodeId !== generation.shot.episodeId ||
              outputAsset.status !== RovelleAssetStatus.RESERVED
            ) {
              return { status: "not_found" };
            }

            const asset = await tx.rovelleAsset.updateMany({
              where: {
                id: generation.outputAssetId,
                status: RovelleAssetStatus.RESERVED,
              },
              data: {
                status: RovelleAssetStatus.AVAILABLE,
                byteSize: input.byteSize,
                etag: input.etag,
              },
            });
            if (asset.count !== 1) return { status: "not_found" };

            const completed = await tx.rovelleShotGeneration.updateMany({
              where: {
                providerTaskId,
                status: preTerminalGenerationStatuses(),
              },
              data: {
                status: RovelleGenerationStatus.COMPLETED,
                actualCostUsd: input.actualCostUsd,
                completedAt: new Date(),
              },
            });
            if (completed.count !== 1) {
              throw new GenerationTransitionChangedError();
            }

            await this.reconcileEpisode(
              tx,
              generation.shot.episodeId,
              generation.shotId,
              RovelleShotStatus.REVIEW_REQUIRED,
            );

            const reloaded = await tx.rovelleShotGeneration.findUnique({
              where: { id: generation.id },
            });
            if (!reloaded) throw new GenerationTransitionChangedError();
            return { status: "updated", generation: reloaded };
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
      } catch (error) {
        if (error instanceof GenerationTransitionChangedError) {
          if (attempt < 2) continue;
          throw error;
        }
        if (attempt < 2 && isSerializableTransactionError(error)) continue;
        throw error;
      }
    }
  }

  async failGeneration(
    providerTaskId: string,
    input: {
      errorCode: string;
      errorMessage: string;
      actualCostUsd: Prisma.Decimal | null;
    },
  ): Promise<GenerationMutationResult> {
    const errorCode = normalizeErrorCode(input.errorCode);
    const errorMessage = normalizeErrorMessage(input.errorMessage);

    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.prisma.client.$transaction(
          async (tx) => {
            const generation = await tx.rovelleShotGeneration.findUnique({
              where: { providerTaskId },
              include: { shot: { include: { episode: true } } },
            });
            if (!generation) return { status: "not_found" };
            if (isTerminalGeneration(generation.status)) {
              return { status: "already_terminal", generation };
            }
            if (!isPreTerminalGeneration(generation.status)) {
              return { status: "not_found" };
            }

            const failed = await tx.rovelleShotGeneration.updateMany({
              where: {
                providerTaskId,
                status: preTerminalGenerationStatuses(),
              },
              data: {
                status: RovelleGenerationStatus.FAILED,
                actualCostUsd: input.actualCostUsd,
                errorCode,
                errorMessage,
              },
            });
            if (failed.count !== 1) {
              const current = await tx.rovelleShotGeneration.findUnique({
                where: { providerTaskId },
              });
              if (!current) return { status: "not_found" };
              if (isTerminalGeneration(current.status)) {
                return { status: "already_terminal", generation: current };
              }
              throw new GenerationTransitionChangedError();
            }

            await this.reconcileEpisode(
              tx,
              generation.shot.episodeId,
              generation.shotId,
              RovelleShotStatus.FAILED,
            );

            const reloaded = await tx.rovelleShotGeneration.findUnique({
              where: { id: generation.id },
            });
            if (!reloaded) throw new GenerationTransitionChangedError();
            return { status: "updated", generation: reloaded };
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
      } catch (error) {
        if (error instanceof GenerationTransitionChangedError) {
          if (attempt < 2) continue;
          throw error;
        }
        if (attempt < 2 && isSerializableTransactionError(error)) continue;
        throw error;
      }
    }
  }

  private async reconcileEpisode(
    tx: Prisma.TransactionClient,
    episodeId: string,
    shotId: string,
    shotStatus: RovelleShotStatus,
  ): Promise<void> {
    await tx.rovelleShot.updateMany({
      where: {
        id: shotId,
        status: {
          in: [
            RovelleShotStatus.READY_TO_GENERATE,
            RovelleShotStatus.GENERATING,
          ],
        },
      },
      data: { status: shotStatus },
    });

    const pendingCount = await tx.rovelleShot.count({
      where: {
        episodeId,
        status: {
          in: [
            RovelleShotStatus.READY_TO_GENERATE,
            RovelleShotStatus.GENERATING,
          ],
        },
      },
    });
    const episodeStatus =
      pendingCount === 0
        ? RovelleEpisodeStatus.REVIEW_REQUIRED
        : RovelleEpisodeStatus.GENERATING;

    await tx.rovelleEpisode.updateMany({
      where: {
        id: episodeId,
        status: {
          in: [
            RovelleEpisodeStatus.READY_TO_GENERATE,
            RovelleEpisodeStatus.GENERATING,
          ],
        },
      },
      data: { status: episodeStatus },
    });
  }

  async markSubmissionFailed(
    generationId: string,
    errorCode: string,
    errorMessage: string,
  ): Promise<MarkSubmissionFailedResult> {
    const code = normalizeErrorCode(errorCode);
    const message = normalizeErrorMessage(errorMessage);

    try {
      return await this.prisma.client.$transaction(
        async (tx) => {
          const generation = await tx.rovelleShotGeneration.findUnique({
            where: { id: generationId },
          });
          if (!generation) return { status: "not_found" };
          if (generation.status !== RovelleGenerationStatus.CREATED) {
            return { status: "invalid_state" };
          }

          const failed = await tx.rovelleShotGeneration.updateMany({
            where: {
              id: generationId,
              status: RovelleGenerationStatus.CREATED,
            },
            data: {
              status: RovelleGenerationStatus.SUBMISSION_FAILED,
              errorCode: code,
              errorMessage: message,
            },
          });
          if (failed.count !== 1) throw new SubmissionStateChangedError();

          const reloaded = await tx.rovelleShotGeneration.findUnique({
            where: { id: generationId },
          });
          if (!reloaded) throw new SubmissionStateChangedError();
          return { status: "submission_failed", generation: reloaded };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (error) {
      if (error instanceof SubmissionStateChangedError) {
        return { status: "invalid_state" };
      }
      throw error;
    }
  }
}

function isGenerationEpisode(status: RovelleEpisodeStatus): boolean {
  return (
    status === RovelleEpisodeStatus.READY_TO_GENERATE ||
    status === RovelleEpisodeStatus.GENERATING
  );
}

function isTerminalGeneration(status: RovelleGenerationStatus): boolean {
  return (
    status === RovelleGenerationStatus.COMPLETED ||
    status === RovelleGenerationStatus.FAILED ||
    status === RovelleGenerationStatus.CANCELLED ||
    status === RovelleGenerationStatus.SUBMISSION_FAILED
  );
}

function isSubmissionRaceSafeGeneration(
  status: RovelleGenerationStatus,
): boolean {
  return (
    status === RovelleGenerationStatus.PROCESSING ||
    status === RovelleGenerationStatus.COMPLETED ||
    status === RovelleGenerationStatus.FAILED ||
    status === RovelleGenerationStatus.CANCELLED
  );
}

function isPreTerminalGeneration(status: RovelleGenerationStatus): boolean {
  return (
    status === RovelleGenerationStatus.CREATED ||
    status === RovelleGenerationStatus.SUBMITTED ||
    status === RovelleGenerationStatus.PROCESSING
  );
}

function preTerminalGenerationStatuses(): {
  in: RovelleGenerationStatus[];
} {
  return {
    in: [
      RovelleGenerationStatus.CREATED,
      RovelleGenerationStatus.SUBMITTED,
      RovelleGenerationStatus.PROCESSING,
    ],
  };
}

function normalizeSanitizedRequest(
  value: Prisma.InputJsonValue,
  profile: GenerationProfile,
): Prisma.InputJsonObject {
  const request = requireJsonObject(value, "sanitizedRequest");
  assertKeys(request, [
    "profile",
    "width",
    "height",
    "duration",
    "audio",
    "referenceAssetIds",
    "referenceCanonVersions",
  ]);

  const dimensions = getGenerationProfile(profile);
  const width = requireInteger(request.width, "width");
  const height = requireInteger(request.height, "height");
  const duration = requireInteger(request.duration, "duration");
  if (
    request.profile !== profile ||
    width !== dimensions.width ||
    height !== dimensions.height ||
    duration < 4 ||
    duration > 30 ||
    request.audio !== false
  ) {
    throw new BadRequestException(
      "sanitizedRequest has invalid generation fields",
    );
  }

  return {
    profile,
    width,
    height,
    duration,
    audio: false,
    referenceAssetIds: requireAssetIds(request.referenceAssetIds),
    referenceCanonVersions: requireCanonVersions(
      request.referenceCanonVersions,
    ),
  };
}

function requireJsonObject(
  value: unknown,
  field: string,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new BadRequestException(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): void {
  if (
    Object.keys(value).length !== expected.length ||
    Object.keys(value).some((key) => !expected.includes(key))
  ) {
    throw new BadRequestException(
      "sanitizedRequest contains unsupported fields",
    );
  }
}

function requireAssetIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new BadRequestException(
      "referenceAssetIds must be a non-empty array",
    );
  }

  return value.map((assetId) => {
    if (typeof assetId !== "string") {
      throw new BadRequestException("referenceAssetIds must contain UUIDs");
    }
    assertAssetId(assetId);
    return assetId;
  });
}

function requireCanonVersions(value: unknown): Array<{
  entityCode: string;
  version: number;
}> {
  if (!Array.isArray(value) || value.length === 0) {
    throw new BadRequestException(
      "referenceCanonVersions must be a non-empty array",
    );
  }

  return value.map((entry) => {
    const version = requireJsonObject(entry, "referenceCanonVersions entry");
    assertKeys(version, ["entityCode", "version"]);
    const canonVersion = requireInteger(version.version, "canon version");
    if (
      typeof version.entityCode !== "string" ||
      version.entityCode.length === 0 ||
      version.entityCode.length > 64 ||
      URL_PATTERN.test(version.entityCode) ||
      canonVersion < 1
    ) {
      throw new BadRequestException(
        "referenceCanonVersions entries must contain entityCode and version",
      );
    }

    return { entityCode: version.entityCode, version: canonVersion };
  });
}

function requireInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value)) {
    throw new BadRequestException(`${field} must be an integer`);
  }
  return value as number;
}

function normalizeErrorCode(value: string): string {
  return value.trim().toUpperCase().slice(0, 120) || "UNKNOWN";
}

function normalizeErrorMessage(value: string): string {
  return value.trim() || "Generation submission failed";
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
