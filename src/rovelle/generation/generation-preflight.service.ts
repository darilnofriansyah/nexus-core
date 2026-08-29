import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  Prisma,
  RovelleAssetStatus,
  RovelleCanonEntityType,
  RovelleCanonVersionStatus,
  RovelleEpisodeStatus,
  RovelleShotStatus,
} from "../../generated/prisma/client";
import { PrismaService } from "../../database/prisma.service";
import { CanonPinService } from "../canon/canon-pin.service";
import type { CanonPinDto } from "../canon/dto/canon.dto";
import type { GenerationProfile } from "./dto/generation.dto";
import { estimateGenerationCostUsd } from "./generation-profile";
import { GenerationRepository } from "./generation.repository";
import {
  GenerationPromptCompiler,
  type PreparedShotGeneration,
} from "./generation-prompt.compiler";

const REQUIRED_CANON_TYPES = [
  RovelleCanonEntityType.CHARACTER,
  RovelleCanonEntityType.ENVIRONMENT,
  RovelleCanonEntityType.STYLE,
] as const;

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
    this.assertCanon(canon);

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

  private assertCanon(canon: readonly CanonPinDto[]): void {
    const types = new Set(canon.map((pin) => pin.version.entity.entityType));
    if (REQUIRED_CANON_TYPES.some((type) => !types.has(type))) {
      throw new BadRequestException(
        "effective canon must include CHARACTER, ENVIRONMENT, and STYLE",
      );
    }
    if (
      canon.some(
        (pin) => pin.version.status !== RovelleCanonVersionStatus.LOCKED,
      )
    ) {
      throw new BadRequestException("canon versions must be LOCKED");
    }
    if (canon.some((pin) => pin.version.assets.length === 0)) {
      throw new BadRequestException(
        "canon versions require at least one attached asset",
      );
    }

    const assets = canon.flatMap((pin) => pin.version.assets.map(({ asset }) => asset));
    if (assets.some((asset) => asset.status !== RovelleAssetStatus.AVAILABLE)) {
      throw new BadRequestException("selected assets must be AVAILABLE");
    }
    if (assets.some((asset) => !asset.mediaType.startsWith("image/"))) {
      throw new BadRequestException(
        "selected assets must use image/* media types",
      );
    }
    if (assets.length > 30) {
      throw new BadRequestException("preflight supports at most 30 references");
    }
  }
}
