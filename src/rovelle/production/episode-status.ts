import { BadRequestException } from '@nestjs/common';
import { RovelleEpisodeStatus } from '../../generated/prisma/client';

const PHASE_ONE_TRANSITIONS: Readonly<
  Partial<Record<RovelleEpisodeStatus, readonly RovelleEpisodeStatus[]>>
> = {
  [RovelleEpisodeStatus.DRAFT]: [RovelleEpisodeStatus.BRIEF_APPROVED],
  [RovelleEpisodeStatus.BRIEF_APPROVED]: [
    RovelleEpisodeStatus.PREPRODUCTION,
  ],
  [RovelleEpisodeStatus.PREPRODUCTION]: [
    RovelleEpisodeStatus.READY_TO_GENERATE,
  ],
  [RovelleEpisodeStatus.READY_TO_GENERATE]: [
    RovelleEpisodeStatus.GENERATING,
  ],
  [RovelleEpisodeStatus.REVIEW_REQUIRED]: [
    RovelleEpisodeStatus.GENERATING,
    RovelleEpisodeStatus.GENERATION_APPROVED,
  ],
};

export function canTransitionEpisode(
  from: RovelleEpisodeStatus,
  to: RovelleEpisodeStatus,
): boolean {
  return PHASE_ONE_TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertEpisodeTransition(
  from: RovelleEpisodeStatus,
  to: RovelleEpisodeStatus,
): void {
  if (!canTransitionEpisode(from, to)) {
    throw new BadRequestException(
      `Invalid Rovelle episode transition: ${from} -> ${to}`,
    );
  }
}
