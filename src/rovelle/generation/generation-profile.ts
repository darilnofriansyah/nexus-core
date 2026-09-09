import { BadRequestException } from "@nestjs/common";
import type { RovelleShotGeneration } from "../../generated/prisma/client";
import type {
  GenerationAttemptDto,
  GenerationProfile,
  GenerationProfileSpec,
  SubmitShotGenerationRequestDto,
} from "./dto/generation.dto";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const GENERATION_PROFILES = Object.freeze({
  DRAFT: Object.freeze({
    width: 1280,
    height: 720,
    usdPerSecond: "0.055",
    pricingSource: "RUNWARE_VIDU_2_0_720P_4S_OBSERVED_2026_09_07",
  }),
} satisfies Readonly<Record<GenerationProfile, GenerationProfileSpec>>);

export function normalizeSubmitGenerationRequest(
  input: unknown,
): SubmitShotGenerationRequestDto {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new BadRequestException("request must be an object");
  }

  const request = input as Record<string, unknown>;
  const requestId = request.requestId;
  if (typeof requestId !== "string" || !UUID_PATTERN.test(requestId.trim())) {
    throw new BadRequestException("requestId must be a valid UUID");
  }

  const profile = request.profile;
  if (typeof profile !== "string" || profile !== "DRAFT") {
    throw new BadRequestException("profile must be DRAFT");
  }

  const firstFrameAssetId = request.firstFrameAssetId;
  if (
    firstFrameAssetId !== undefined &&
    (typeof firstFrameAssetId !== "string" ||
      !UUID_PATTERN.test(firstFrameAssetId.trim()))
  ) {
    throw new BadRequestException("firstFrameAssetId must be a valid UUID");
  }

  return {
    requestId: requestId.trim(),
    profile: profile as GenerationProfile,
    ...(firstFrameAssetId === undefined
      ? {}
      : { firstFrameAssetId: firstFrameAssetId.trim() }),
  };
}

export function getGenerationProfile(
  profile: GenerationProfile,
): GenerationProfileSpec {
  if (typeof profile !== "string" || profile !== "DRAFT") {
    throw new BadRequestException("profile must be DRAFT");
  }

  return GENERATION_PROFILES[profile];
}

export function estimateGenerationCostUsd(
  profile: GenerationProfile,
  durationSeconds: number,
): string {
  const { usdPerSecond } = getGenerationProfile(profile);
  if (
    typeof durationSeconds !== "number" ||
    !Number.isInteger(durationSeconds) ||
    durationSeconds !== 4
  ) {
    throw new BadRequestException("durationSeconds must be 4 for Vidu 2");
  }

  const [whole, fraction = ""] = usdPerSecond.split(".");
  const scale = fraction.length;
  const units = BigInt(`${whole}${fraction}`) * BigInt(durationSeconds);
  const scaledUnits = units * 10n ** BigInt(6 - scale);
  const integerPart = scaledUnits / 1_000_000n;
  const decimalPart = (scaledUnits % 1_000_000n).toString().padStart(6, "0");

  return `${integerPart}.${decimalPart}`;
}

export function toGenerationAttemptDto(
  generation: RovelleShotGeneration,
): GenerationAttemptDto {
  return {
    id: generation.id,
    clientRequestId: generation.clientRequestId,
    shotId: generation.shotId,
    attempt: generation.attempt,
    provider: generation.provider,
    modality: generation.modality,
    profile: generation.profile,
    model: generation.model,
    providerTaskId: generation.providerTaskId,
    status: generation.status,
    outputAssetId: generation.outputAssetId,
    estimatedCostUsd: generation.estimatedCostUsd.toFixed(6),
    pricingSource: generation.pricingSource,
    actualCostUsd: generation.actualCostUsd?.toFixed(6) ?? null,
    errorCode: generation.errorCode,
    errorMessage: generation.errorMessage,
    submittedAt: generation.submittedAt?.toISOString() ?? null,
    completedAt: generation.completedAt?.toISOString() ?? null,
    createdAt: generation.createdAt.toISOString(),
    updatedAt: generation.updatedAt.toISOString(),
  };
}
