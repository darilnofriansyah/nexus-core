import { randomUUID } from "node:crypto";
import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  Optional,
} from "@nestjs/common";
import { readEnv } from "../../config/env";
import {
  Prisma,
  RovelleGenerationProfile,
} from "../../generated/prisma/client";
import { AssetService } from "../assets/asset.service";
import { buildAssetStorageKey } from "../assets/asset-validation";
import { R2StorageService } from "../assets/r2-storage.service";
import type {
  GenerationAttemptDto,
  SubmitShotGenerationRequestDto,
} from "./dto/generation.dto";
import { GenerationPreflightService } from "./generation-preflight.service";
import {
  estimateGenerationCostUsd,
  getGenerationProfile,
  normalizeSubmitGenerationRequest,
  toGenerationAttemptDto,
} from "./generation-profile";
import { GenerationRepository } from "./generation.repository";
import {
  GENERATION_PROVIDER,
  type GenerationProvider,
} from "./providers/generation-provider";
import { RunwareSubmissionError } from "./providers/runware/runware-submit.client";

const URL_PATTERN = /(?:\b[a-z][a-z\d+.-]*:[^\s]*|\/\/[^\s]*)/gi;

@Injectable()
export class GenerationService {
  constructor(
    private readonly preflight: GenerationPreflightService,
    private readonly repository: GenerationRepository,
    private readonly assetService: AssetService,
    private readonly storage: R2StorageService,
    @Inject(GENERATION_PROVIDER)
    private readonly provider: GenerationProvider,
    @Optional()
    private readonly model = readEnv().runwareVideoModel,
  ) {}

  async submitShot(
    shotId: string,
    request: SubmitShotGenerationRequestDto,
  ): Promise<GenerationAttemptDto> {
    const normalized = normalizeSubmitGenerationRequest(request);
    const existing = await this.repository.findByClientRequestId(
      normalized.requestId,
    );
    if (existing) return toGenerationAttemptDto(existing);

    const prepared = await this.preflight.preflight(
      shotId,
      normalized.profile,
    );
    const profile = getGenerationProfile(normalized.profile);
    const estimatedCostUsd = new Prisma.Decimal(
      estimateGenerationCostUsd(normalized.profile, prepared.duration),
    );
    const providerTaskId = randomUUID();
    const outputAssetId = randomUUID();
    const outputStorageKey = buildAssetStorageKey(outputAssetId);
    const created = await this.repository.createAttempt({
      clientRequestId: normalized.requestId,
      shotId: prepared.shotId,
      episodeId: prepared.episodeId,
      providerTaskId,
      outputAssetId,
      outputStorageKey,
      profile: normalized.profile as RovelleGenerationProfile,
      model: this.model,
      prompt: prepared.prompt,
      sanitizedRequest: sanitizedRequest(normalized.profile, prepared),
      estimatedCostUsd,
      pricingSource: profile.pricingSource,
    });
    if (created.status === "existing")
      return toGenerationAttemptDto(created.generation);
    if (created.status === "not_found") {
      throw new NotFoundException("Rovelle shot not found");
    }
    if (created.status === "budget_exceeded") {
      throw new ConflictException({
        message: "Episode generation budget would be exceeded",
        budgetUsd: created.budgetUsd.toFixed(6),
        committedUsd: created.committedUsd.toFixed(6),
        requestedEstimateUsd: created.requestedEstimateUsd.toFixed(6),
        projectedUsd: created.projectedUsd.toFixed(6),
      });
    }
    if (created.status !== "created") {
      throw new BadRequestException("Rovelle shot is not ready to generate");
    }

    let referenceImageUrls: string[];
    let uploadUrl: string;
    try {
      referenceImageUrls = await Promise.all(
        prepared.references.map(
          async (reference) =>
            (await this.assetService.createReadUrl(reference.assetId)).download
              .url,
        ),
      );
      uploadUrl = (await this.storage.createProviderPutUrl(outputStorageKey))
        .url;
    } catch {
      await this.markTemporaryUrlPreparationFailed(created.generation.id);
      throw new InternalServerErrorException({
        message: "Generation temporary URL preparation failed",
        generationId: created.generation.id,
      });
    }

    try {
      await this.provider.submit({
        taskId: providerTaskId,
        prompt: prepared.prompt,
        duration: prepared.duration,
        width: profile.width,
        height: profile.height,
        referenceImageUrls,
        uploadUrl,
      });
    } catch (error) {
      if (!(error instanceof RunwareSubmissionError)) throw error;
      await this.markProviderSubmissionFailed(created.generation.id, error);
      throw new BadGatewayException({
        message: "Runware generation submission failed",
        generationId: created.generation.id,
        code: error.code,
      });
    }

    const submitted = await this.markAcceptedSubmission(created.generation.id);
    return toGenerationAttemptDto(submitted);
  }

  async getGeneration(id: string): Promise<GenerationAttemptDto> {
    const generation = await this.repository.findById(id);
    if (!generation)
      throw new NotFoundException("Rovelle generation not found");
    return toGenerationAttemptDto(generation);
  }

  async listShotGenerations(shotId: string): Promise<GenerationAttemptDto[]> {
    return (await this.repository.listForShot(shotId)).map(
      toGenerationAttemptDto,
    );
  }

  private async markAcceptedSubmission(id: string) {
    try {
      const result = await this.repository.markSubmitted(id);
      if (
        result.status === "submitted" ||
        result.status === "already_terminal"
      ) {
        return result.generation;
      }
    } catch {
      // Provider acceptance must never trigger a second paid submission.
    }
    throw new InternalServerErrorException({
      message: "Generation submission acceptance persistence failed",
      generationId: id,
    });
  }

  private async markProviderSubmissionFailed(
    id: string,
    error: RunwareSubmissionError,
  ): Promise<void> {
    return this.markSubmissionFailed(id, error.code, redactUrls(error.message));
  }

  private async markTemporaryUrlPreparationFailed(id: string): Promise<void> {
    return this.markSubmissionFailed(
      id,
      "NETWORK",
      "Generation temporary URL creation failed",
    );
  }

  private async markSubmissionFailed(
    id: string,
    errorCode: string,
    errorMessage: string,
  ): Promise<void> {
    try {
      const result = await this.repository.markSubmissionFailed(
        id,
        errorCode,
        errorMessage,
      );
      if (result.status === "submission_failed") return;
    } catch {
      // A submission error cannot be reported as durable when persistence failed.
    }
    throw new InternalServerErrorException({
      message: "Generation submission failure persistence failed",
      generationId: id,
    });
  }
}

function sanitizedRequest(
  profile: SubmitShotGenerationRequestDto["profile"],
  prepared: Awaited<ReturnType<GenerationPreflightService["preflight"]>>,
) {
  const dimensions = getGenerationProfile(profile);
  return {
    profile,
    width: dimensions.width,
    height: dimensions.height,
    duration: prepared.duration,
    audio: false,
    referenceAssetIds: prepared.references.map(
      (reference) => reference.assetId,
    ),
    referenceCanonVersions: prepared.references.map((reference) => ({
      entityCode: reference.entityCode,
      version: reference.version,
    })),
  };
}

function redactUrls(message: string): string {
  return message.replace(URL_PATTERN, "[redacted-url]");
}
