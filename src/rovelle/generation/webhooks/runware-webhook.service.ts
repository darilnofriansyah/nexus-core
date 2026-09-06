import { Injectable, ServiceUnavailableException } from "@nestjs/common";
import {
  Prisma,
  RovelleGenerationStatus,
} from "../../../generated/prisma/client";
import { R2StorageService } from "../../assets/r2-storage.service";
import {
  GenerationRepository,
  type GenerationMutationResult,
  type GenerationWithOutputAsset,
} from "../generation.repository";
import type { RunwareWebhookEvent } from "./runware-webhook.dto";

const URL_PATTERN = /(?:\b[a-z][a-z\d+.-]*:[^\s]*|\/\/[^\s]*)/gi;
const EMPTY_OUTPUT_CODE = "OUTPUT_EMPTY";
const EMPTY_OUTPUT_MESSAGE = "Runware output object is empty";
const DEFAULT_ERROR_CODE = "RUNWARE_ERROR";
const DEFAULT_ERROR_MESSAGE = "Runware generation failed";
const VIDEO_MEDIA_TYPE = "video/mp4";

export interface RunwareWebhookHandleResult {
  accepted: true;
  disposition:
    | "processing"
    | "completed"
    | "failed"
    | "duplicate"
    | "unknown_task";
  generationId?: string;
}

@Injectable()
export class RunwareWebhookService {
  constructor(
    private readonly repository: GenerationRepository,
    private readonly storage: R2StorageService,
  ) {}

  async handle(
    event: RunwareWebhookEvent,
  ): Promise<RunwareWebhookHandleResult> {
    const generation = await this.repository.findByProviderTaskId(event.taskId);
    if (!generation) return unknownTask();
    if (isTerminalGeneration(generation.status)) {
      return duplicate(generation.id);
    }

    if (event.kind === "processing") {
      return this.handleProcessing(event.taskId);
    }
    if (event.kind === "failure") {
      return this.handleFailure(event);
    }
    return this.handleSuccess(event, generation);
  }

  private async handleProcessing(
    taskId: string,
  ): Promise<RunwareWebhookHandleResult> {
    const result = await this.repository.markProcessing(taskId);
    return mutationResult(result, "processing");
  }

  private async handleSuccess(
    event: Extract<RunwareWebhookEvent, { kind: "success" }>,
    generation: GenerationWithOutputAsset,
  ): Promise<RunwareWebhookHandleResult> {
    const metadata = await this.ensureOutputInR2(event, generation);

    if (metadata.byteSize === 0n) {
      const result = await this.repository.failGeneration(event.taskId, {
        errorCode: EMPTY_OUTPUT_CODE,
        errorMessage: EMPTY_OUTPUT_MESSAGE,
        actualCostUsd: decimalCost(event.costUsd),
      });
      return mutationResult(result, "failed");
    }

    const result = await this.repository.completeGeneration(event.taskId, {
      providerOutputId: event.providerOutputId,
      actualCostUsd: decimalCost(event.costUsd),
      byteSize: metadata.byteSize,
      etag: metadata.etag,
    });
    return mutationResult(result, "completed");
  }

  private async ensureOutputInR2(
    event: Extract<RunwareWebhookEvent, { kind: "success" }>,
    generation: GenerationWithOutputAsset,
  ) {
    const storageKey = generation.outputAsset.storageKey;
    const existing = await this.storage.headObject(storageKey);
    if (existing) return existing;
    if (!event.videoUrl) {
      throw new ServiceUnavailableException(
        "Runware output is not available in R2 yet",
      );
    }

    await this.storage.putObject(
      storageKey,
      VIDEO_MEDIA_TYPE,
      await this.downloadVideo(event.videoUrl),
    );
    const copied = await this.storage.headObject(storageKey);
    if (copied) return copied;

    throw new ServiceUnavailableException(
      "Runware output is not available in R2 yet",
    );
  }

  private async downloadVideo(videoUrl: string): Promise<Uint8Array> {
    try {
      const response = await fetch(videoUrl, { redirect: "error" });
      const contentType = response.headers
        .get("content-type")
        ?.split(";", 1)[0]
        ?.trim()
        .toLowerCase();
      if (!response.ok || contentType !== VIDEO_MEDIA_TYPE) {
        throw new ServiceUnavailableException("Runware video download failed");
      }

      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength === 0) {
        throw new ServiceUnavailableException("Runware video download failed");
      }
      return bytes;
    } catch (error) {
      if (error instanceof ServiceUnavailableException) throw error;
      throw new ServiceUnavailableException("Runware video download failed");
    }
  }

  private async handleFailure(
    event: Extract<RunwareWebhookEvent, { kind: "failure" }>,
  ): Promise<RunwareWebhookHandleResult> {
    const result = await this.repository.failGeneration(event.taskId, {
      errorCode: sanitizeError(event.code, 120, DEFAULT_ERROR_CODE),
      errorMessage: sanitizeError(event.message, 4000, DEFAULT_ERROR_MESSAGE),
      actualCostUsd: decimalCost(event.costUsd),
    });
    return mutationResult(result, "failed");
  }
}

function mutationResult(
  result: GenerationMutationResult,
  disposition: "processing" | "completed" | "failed",
): RunwareWebhookHandleResult {
  if (result.status === "not_found") return unknownTask();
  if (
    result.status === "already_terminal" &&
    isTerminalGeneration(result.generation.status)
  ) {
    return duplicate(result.generation.id);
  }

  return {
    accepted: true,
    disposition,
    generationId: result.generation.id,
  };
}

function decimalCost(costUsd: string | null): Prisma.Decimal | null {
  return costUsd === null ? null : new Prisma.Decimal(costUsd);
}

function sanitizeError(
  value: string,
  maxLength: number,
  fallback: string,
): string {
  const sanitized = redactUrls(value.trim()).slice(0, maxLength);
  return sanitized || fallback;
}

function redactUrls(value: string): string {
  return value.replace(URL_PATTERN, "[redacted-url]");
}

function isTerminalGeneration(status: RovelleGenerationStatus): boolean {
  return (
    status === RovelleGenerationStatus.COMPLETED ||
    status === RovelleGenerationStatus.FAILED ||
    status === RovelleGenerationStatus.CANCELLED ||
    status === RovelleGenerationStatus.SUBMISSION_FAILED
  );
}

function duplicate(generationId: string): RunwareWebhookHandleResult {
  return { accepted: true, disposition: "duplicate", generationId };
}

function unknownTask(): RunwareWebhookHandleResult {
  return { accepted: true, disposition: "unknown_task" };
}
