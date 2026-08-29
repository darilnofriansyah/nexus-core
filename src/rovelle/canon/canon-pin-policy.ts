import { RovelleEpisodeStatus } from "../../generated/prisma/client";

const EDITABLE_CANON_PIN_STATUSES: ReadonlySet<RovelleEpisodeStatus> = new Set([
  RovelleEpisodeStatus.DRAFT,
  RovelleEpisodeStatus.BRIEF_APPROVED,
  RovelleEpisodeStatus.PREPRODUCTION,
  RovelleEpisodeStatus.READY_TO_GENERATE,
]);

export function canEditCanonPins(status: RovelleEpisodeStatus): boolean {
  return EDITABLE_CANON_PIN_STATUSES.has(status);
}
