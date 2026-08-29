import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  RovelleAssetStatus,
  RovelleCanonEntityType,
  RovelleCanonVersionStatus,
  RovelleEpisodeStatus,
  RovelleShotStatus,
} from "../../generated/prisma/client";
import { PrismaService } from "../../database/prisma.service";
import { CanonPinService } from "../canon/canon-pin.service";
import type { CanonPinDto } from "../canon/dto/canon.dto";
import {
  GenerationPromptCompiler,
  type PreparedShotGeneration,
} from "./generation-prompt.compiler";

const REQUIRED_CANON_TYPES = [
  RovelleCanonEntityType.CHARACTER,
  RovelleCanonEntityType.ENVIRONMENT,
  RovelleCanonEntityType.STYLE,
] as const;

@Injectable()
export class GenerationPreflightService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly canonPinService: CanonPinService,
    private readonly promptCompiler: GenerationPromptCompiler,
  ) {}

  async preflight(shotId: string): Promise<PreparedShotGeneration> {
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

    return this.promptCompiler.compile({
      shotId: shot.id,
      episodeId: shot.episodeId,
      direction: shot.direction,
      duration: shot.targetDurationSeconds,
      canon,
    });
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
