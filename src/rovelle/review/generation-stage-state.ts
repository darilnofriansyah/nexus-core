import { BadRequestException } from "@nestjs/common";
import { RovelleEpisodeStatus } from "../../generated/prisma/client";

export interface GenerationStageCounts {
  totalShots: number;
  pendingShots: number;
  approvedShots: number;
}

export function deriveGenerationStageStatus({
  totalShots,
  pendingShots,
  approvedShots,
}: GenerationStageCounts): RovelleEpisodeStatus {
  if (
    ![totalShots, pendingShots, approvedShots].every(
      (count) => Number.isInteger(count) && count >= 0,
    )
  ) {
    throw new BadRequestException(
      "generation stage counts must be non-negative integers",
    );
  }
  if (approvedShots > totalShots || pendingShots > totalShots) {
    throw new BadRequestException(
      "generation stage counts cannot exceed totalShots",
    );
  }

  if (pendingShots > 0) return RovelleEpisodeStatus.GENERATING;
  if (totalShots > 0 && approvedShots === totalShots) {
    return RovelleEpisodeStatus.GENERATION_APPROVED;
  }

  return RovelleEpisodeStatus.REVIEW_REQUIRED;
}
