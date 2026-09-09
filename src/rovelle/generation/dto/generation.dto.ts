import type {
  RovelleGenerationModality,
  RovelleGenerationProfile,
  RovelleGenerationProvider,
  RovelleGenerationStatus,
} from "../../../generated/prisma/client";

export type GenerationProfile = "DRAFT";

export interface SubmitShotGenerationRequestDto {
  requestId: string;
  profile: GenerationProfile;
  firstFrameAssetId?: string;
}

export interface GenerationProfileSpec {
  readonly width: number;
  readonly height: number;
  readonly usdPerSecond: string;
  readonly pricingSource: string;
}

export interface GenerationAttemptDto {
  id: string;
  clientRequestId: string;
  shotId: string;
  attempt: number;
  provider: RovelleGenerationProvider;
  modality: RovelleGenerationModality;
  profile: RovelleGenerationProfile;
  model: string;
  providerTaskId: string;
  status: RovelleGenerationStatus;
  outputAssetId: string;
  estimatedCostUsd: string;
  pricingSource: string;
  actualCostUsd: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  submittedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}
