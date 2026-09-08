import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  Prisma,
  RovelleEpisodeStatus,
  RovelleShotStatus,
} from "../../generated/prisma/client";
import { PrismaService } from "../../database/prisma.service";
import { CanonPinService } from "../canon/canon-pin.service";
import type { GenerationProfile } from "./dto/generation.dto";
import { estimateGenerationCostUsd } from "./generation-profile";
import { GenerationRepository } from "./generation.repository";
import { generationCanonReadinessError } from "./generation-canon-readiness";
import {
  GenerationPromptCompiler,
  type PreparedShotGeneration,
} from "./generation-prompt.compiler";

export interface GenerationBudgetVisibility {
  budgetUsd: string | null;
  committedUsd: string;
  requestedEstimateUsd: string;
  projectedUsd: string;
  withinBudget: boolean;
}

export type PreparedShotGenerationWithBudget = PreparedShotGeneration & {
  budget: GenerationBudgetVisibility;
};

@Injectable()
export class GenerationPreflightService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly canonPinService: CanonPinService,
    private readonly promptCompiler: GenerationPromptCompiler,
    private readonly generationRepository: GenerationRepository,
  ) {
    if (!generationRepository) {
      throw new Error("GenerationRepository is required");
    }
  }

  async preflight(
    shotId: string,
    profile: GenerationProfile = "DRAFT",
  ): Promise<PreparedShotGenerationWithBudget> {
    const shot = await this.prisma.client.rovelleShot.findUnique({
      where: { id: shotId },
      select: {
        id: true,
        episodeId: true,
        direction: true,
        targetDurationSeconds: true,
        status: true,
        episode: { select: { id: true, status: true } },
      },
    });
    if (!shot) throw new NotFoundException("Rovelle shot not found");

    if (
      shot.episode.status !== RovelleEpisodeStatus.READY_TO_GENERATE &&
      shot.episode.status !== RovelleEpisodeStatus.GENERATING
    ) {
      throw new BadRequestException(
        "episode must be READY_TO_GENERATE or GENERATING",
      );
    }
    if (shot.status !== RovelleShotStatus.READY_TO_GENERATE) {
      throw new BadRequestException("shot must be READY_TO_GENERATE");
    }
    if (
      !Number.isInteger(shot.targetDurationSeconds) ||
      shot.targetDurationSeconds === null ||
      shot.targetDurationSeconds < 4 ||
      shot.targetDurationSeconds > 30
    ) {
      throw new BadRequestException("duration must be an integer from 4 to 30");
    }

    const canon = await this.canonPinService.getEffectiveShotCanon(shot.id);
    const canonError = generationCanonReadinessError(canon);
    if (canonError) throw new BadRequestException(canonError);

    const prepared = this.promptCompiler.compile({
      shotId: shot.id,
      episodeId: shot.episodeId,
      direction: shot.direction,
      duration: shot.targetDurationSeconds,
      canon,
    });

    const summary = await this.generationRepository.getEpisodeCostSummary(
      shot.episodeId,
    );
    const requestedEstimateUsd = new Prisma.Decimal(
      estimateGenerationCostUsd(profile, shot.targetDurationSeconds),
    );
    const committedUsd = summary?.committedUsd ?? new Prisma.Decimal("0");
    const budgetUsd = summary?.budgetUsd ?? null;
    const projectedUsd = committedUsd.plus(requestedEstimateUsd);

    return {
      ...prepared,
      budget: {
        budgetUsd: budgetUsd?.toFixed(6) ?? null,
        committedUsd: committedUsd.toFixed(6),
        requestedEstimateUsd: requestedEstimateUsd.toFixed(6),
        projectedUsd: projectedUsd.toFixed(6),
        withinBudget: budgetUsd === null || projectedUsd.lte(budgetUsd),
      },
    };
  }

}
