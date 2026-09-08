import {
  RovelleAssetStatus,
  RovelleCanonEntityType,
  RovelleCanonVersionStatus,
} from "../../generated/prisma/client";
import type { CanonPinDto } from "../canon/dto/canon.dto";

const REQUIRED_CANON_TYPES = [
  RovelleCanonEntityType.CHARACTER,
  RovelleCanonEntityType.ENVIRONMENT,
  RovelleCanonEntityType.STYLE,
] as const;

export function generationCanonReadinessError(canon: readonly CanonPinDto[]): string | null {
  const types = new Set(canon.map((pin) => pin.version.entity.entityType));
  if (REQUIRED_CANON_TYPES.some((type) => !types.has(type))) {
    return "effective canon must include CHARACTER, ENVIRONMENT, and STYLE";
  }
  if (canon.some((pin) => pin.version.status !== RovelleCanonVersionStatus.LOCKED)) {
    return "canon versions must be LOCKED";
  }
  if (canon.some((pin) => pin.version.assets.length === 0)) {
    return "canon versions require at least one attached asset";
  }
  const assets = canon.flatMap((pin) => pin.version.assets.map(({ asset }) => asset));
  if (assets.some((asset) => asset.status !== RovelleAssetStatus.AVAILABLE)) {
    return "selected assets must be AVAILABLE";
  }
  if (assets.some((asset) => !asset.mediaType.startsWith("image/"))) {
    return "selected assets must use image/* media types";
  }
  return assets.length > 30 ? "preflight supports at most 30 references" : null;
}
