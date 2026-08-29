import * as assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ServiceUnavailableException } from "@nestjs/common";
import { Prisma } from "../../../generated/prisma/client";
import {
  RovelleGenerationModality,
  RovelleGenerationProfile,
  RovelleGenerationProvider,
  RovelleGenerationStatus,
  type RovelleShotGeneration,
} from "../../../generated/prisma/client";
import type { R2ObjectMetadata } from "../../assets/r2-storage.service";
import type {
  GenerationMutationResult,
  InternalGenerationRecord,
} from "../generation.repository";
import { GenerationRepository } from "../generation.repository";
import type { RunwareWebhookEvent } from "./runware-webhook.dto";
import { RunwareWebhookService } from "./runware-webhook.service";

const GENERATION_ID = "223e4567-e89b-42d3-a456-426614174000";
const TASK_ID = "423e4567-e89b-42d3-a456-426614174000";
const SHOT_ID = "123e4567-e89b-42d3-a456-426614174000";
const REQUEST_ID = "323e4567-e89b-42d3-a456-426614174000";
const ASSET_ID = "523e4567-e89b-42d3-a456-426614174000";
const STORAGE_KEY = "ringmaster/assets/provider-owned-output.mp4";
const PERSISTED_STORAGE_KEY =
  "provider-owned/output/asset-without-derived-name.mp4";

type GenerationWithOutputAsset = InternalGenerationRecord & {
  outputAsset: { storageKey: string };
};

function generation(
  changes: Partial<RovelleShotGeneration> = {},
): GenerationWithOutputAsset {
  return {
    id: GENERATION_ID,
    clientRequestId: REQUEST_ID,
    shotId: SHOT_ID,
    attempt: 1,
    provider: RovelleGenerationProvider.RUNWARE,
    modality: RovelleGenerationModality.VIDEO,
    profile: RovelleGenerationProfile.DRAFT,
    model: "bytedance:seedance@2.5",
    providerTaskId: TASK_ID,
    prompt: "Koko walks through the garden.",
    request: {
      profile: "DRAFT",
      width: 480,
      height: 854,
      duration: 5,
      audio: false,
      referenceAssetIds: [ASSET_ID],
      referenceCanonVersions: [{ entityCode: "KOKO", version: 1 }],
    },
    status: RovelleGenerationStatus.PROCESSING,
    outputAssetId: ASSET_ID,
    estimatedCostUsd: new Prisma.Decimal("0.575000"),
    currency: "USD",
    pricingSource: "RUNWARE_SEEDANCE_2_5_2026_08_28",
    actualCostUsd: null,
    errorCode: null,
    errorMessage: null,
    submittedAt: new Date("2026-08-28T00:00:00.000Z"),
    completedAt: null,
    createdAt: new Date("2026-08-28T00:00:00.000Z"),
    updatedAt: new Date("2026-08-28T00:00:00.000Z"),
    ...changes,
    outputAsset: { storageKey: STORAGE_KEY },
  };
}

function successEvent(
  changes: Partial<Extract<RunwareWebhookEvent, { kind: "success" }>> = {},
): Extract<RunwareWebhookEvent, { kind: "success" }> {
  return {
    kind: "success",
    taskId: TASK_ID,
    providerOutputId: "provider-output-id",
    costUsd: "0.250000",
    ...changes,
  };
}

function processingEvent(
  changes: Partial<Extract<RunwareWebhookEvent, { kind: "processing" }>> = {},
): Extract<RunwareWebhookEvent, { kind: "processing" }> {
  return {
    kind: "processing",
    taskId: TASK_ID,
    progress: 37.5,
    ...changes,
  };
}

function failureEvent(
  changes: Partial<Extract<RunwareWebhookEvent, { kind: "failure" }>> = {},
): Extract<RunwareWebhookEvent, { kind: "failure" }> {
  return {
    kind: "failure",
    taskId: TASK_ID,
    code: "PROVIDER_FAILURE",
    message: "Runware could not render the video",
    costUsd: "0.125",
    ...changes,
  };
}

class FakeGenerationRepository {
  generation: GenerationWithOutputAsset | null = generation();
  markProcessingResult: GenerationMutationResult = {
    status: "updated",
    generation: generation({ status: RovelleGenerationStatus.PROCESSING }),
  };
  completeResult: GenerationMutationResult = {
    status: "updated",
    generation: generation({ status: RovelleGenerationStatus.COMPLETED }),
  };
  failResult: GenerationMutationResult = {
    status: "updated",
    generation: generation({ status: RovelleGenerationStatus.FAILED }),
  };
  findCalls: string[] = [];
  markProcessingCalls: string[] = [];
  completeCalls: Array<{
    taskId: string;
    input: Parameters<GenerationRepository["completeGeneration"]>[1];
  }> = [];
  failCalls: Array<{
    taskId: string;
    input: Parameters<GenerationRepository["failGeneration"]>[1];
  }> = [];

  async findByProviderTaskId(
    taskId: string,
  ): Promise<GenerationWithOutputAsset | null> {
    this.findCalls.push(taskId);
    return this.generation;
  }

  async markProcessing(taskId: string): Promise<GenerationMutationResult> {
    this.markProcessingCalls.push(taskId);
    return this.markProcessingResult;
  }

  async completeGeneration(
    taskId: string,
    input: Parameters<GenerationRepository["completeGeneration"]>[1],
  ): Promise<GenerationMutationResult> {
    this.completeCalls.push({ taskId, input });
    return this.completeResult;
  }

  async failGeneration(
    taskId: string,
    input: Parameters<GenerationRepository["failGeneration"]>[1],
  ): Promise<GenerationMutationResult> {
    this.failCalls.push({ taskId, input });
    return this.failResult;
  }
}

class FakeStorageService {
  keys: string[] = [];
  metadata: R2ObjectMetadata | null = {
    byteSize: 1024n,
    etag: "etag-1",
    contentType: "text/plain",
  };
  error: unknown;

  async headObject(key: string): Promise<R2ObjectMetadata | null> {
    this.keys.push(key);
    if (this.error) throw this.error;
    return this.metadata;
  }
}

function createServiceWithRepositoryRead() {
  const repositoryRead = new GenerationRepository({
    client: {
      rovelleShotGeneration: {
        findUnique: async (args: unknown) => {
          const include = (args as { include?: unknown }).include;
          if (
            include &&
            typeof include === "object" &&
            "outputAsset" in include
          ) {
            return {
              ...generation(),
              outputAsset: { storageKey: PERSISTED_STORAGE_KEY },
            };
          }
          return generation();
        },
      },
    },
  } as never);
  const completeInputs: Array<
    Parameters<GenerationRepository["completeGeneration"]>[1]
  > = [];
  const repository = {
    findByProviderTaskId:
      repositoryRead.findByProviderTaskId.bind(repositoryRead),
    markProcessing: async () => {
      throw new Error("markProcessing should not run");
    },
    completeGeneration: async (
      _taskId: string,
      input: Parameters<GenerationRepository["completeGeneration"]>[1],
    ): Promise<GenerationMutationResult> => {
      completeInputs.push(input);
      return {
        status: "updated",
        generation: generation({ status: RovelleGenerationStatus.COMPLETED }),
      };
    },
    failGeneration: async () => {
      throw new Error("failGeneration should not run");
    },
  };
  const storage = new FakeStorageService();
  const service = new RunwareWebhookService(
    repository as unknown as GenerationRepository,
    storage as never,
  );
  return { completeInputs, service, storage };
}

function createService() {
  const repository = new FakeGenerationRepository();
  const storage = new FakeStorageService();
  const service = new RunwareWebhookService(
    repository as unknown as GenerationRepository,
    storage as never,
  );
  return { repository, storage, service };
}

describe("Runware webhook completion service", () => {
  test("returns unknown_task without creating state for an unknown task", async () => {
    const { repository, storage, service } = createService();
    repository.generation = null;

    const result = await service.handle(successEvent());

    assert.deepEqual(result, { accepted: true, disposition: "unknown_task" });
    assert.deepEqual(repository.findCalls, [TASK_ID]);
    assert.deepEqual(storage.keys, []);
    assert.deepEqual(repository.completeCalls, []);
    assert.deepEqual(repository.failCalls, []);
  });

  test("returns duplicate for a terminal generation without checking R2", async () => {
    const { repository, storage, service } = createService();
    repository.generation = generation({
      status: RovelleGenerationStatus.COMPLETED,
    });

    const result = await service.handle(successEvent());

    assert.deepEqual(result, {
      accepted: true,
      disposition: "duplicate",
      generationId: GENERATION_ID,
    });
    assert.deepEqual(storage.keys, []);
    assert.deepEqual(repository.completeCalls, []);
  });

  test("heads the generation output key before completing and ignores provider content type", async () => {
    const { repository, storage, service } = createService();

    const result = await service.handle(successEvent());

    assert.deepEqual(result, {
      accepted: true,
      disposition: "completed",
      generationId: GENERATION_ID,
    });
    assert.deepEqual(storage.keys, [STORAGE_KEY]);
    assert.equal(repository.completeCalls.length, 1);
    assert.equal(repository.completeCalls[0]?.taskId, TASK_ID);
    assert.equal(
      repository.completeCalls[0]?.input.providerOutputId,
      "provider-output-id",
    );
    assert.equal(repository.completeCalls[0]?.input.byteSize, 1024n);
    assert.equal(repository.completeCalls[0]?.input.etag, "etag-1");
    assert.equal(
      repository.completeCalls[0]?.input.actualCostUsd?.toFixed(6),
      "0.250000",
    );
    assert.equal(
      "contentType" in (repository.completeCalls[0]?.input ?? {}),
      false,
    );
  });

  test("uses the non-deterministic storage key returned by the repository read contract", async () => {
    const { service, storage } = createServiceWithRepositoryRead();

    await service.handle(successEvent());

    assert.deepEqual(storage.keys, [PERSISTED_STORAGE_KEY]);
  });

  test("turns a missing R2 object into a retryable service-unavailable error without mutation", async () => {
    const { repository, storage, service } = createService();
    storage.metadata = null;

    await assert.rejects(
      () => service.handle(successEvent()),
      (error: unknown) =>
        error instanceof ServiceUnavailableException &&
        error.message === "Runware output is not available in R2 yet",
    );
    assert.deepEqual(repository.completeCalls, []);
    assert.deepEqual(repository.failCalls, []);
  });

  test("fails an empty R2 object with a stable output-empty code", async () => {
    const { repository, storage, service } = createService();
    storage.metadata = {
      byteSize: 0n,
      etag: "empty-etag",
      contentType: "video/mp4",
    };

    const result = await service.handle(successEvent());

    assert.deepEqual(result, {
      accepted: true,
      disposition: "failed",
      generationId: GENERATION_ID,
    });
    assert.equal(repository.completeCalls.length, 0);
    assert.deepEqual(repository.failCalls[0], {
      taskId: TASK_ID,
      input: {
        errorCode: "OUTPUT_EMPTY",
        errorMessage: "Runware output object is empty",
        actualCostUsd: new Prisma.Decimal("0.250000"),
      },
    });
  });

  test("does not fetch the provider video URL before completing", async () => {
    const { repository, storage, service } = createService();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() => {
      throw new Error("provider video URL must not be fetched");
    }) as typeof fetch;

    try {
      await service.handle(
        successEvent({
          providerOutputId: "https://provider.invalid/video.mp4",
        }),
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.deepEqual(storage.keys, [STORAGE_KEY]);
    assert.equal(repository.completeCalls.length, 1);
  });

  test("converts a normalized success cost string to Prisma Decimal", async () => {
    const { repository, service } = createService();

    await service.handle(successEvent({ costUsd: "1.234567" }));

    assert.ok(
      repository.completeCalls[0]?.input.actualCostUsd instanceof
        Prisma.Decimal,
    );
    assert.equal(
      repository.completeCalls[0]?.input.actualCostUsd?.toString(),
      "1.234567",
    );
  });

  test("returns unknown_task for processing callbacks with no matching generation", async () => {
    const { repository, service } = createService();
    repository.generation = null;

    const result = await service.handle(processingEvent());

    assert.deepEqual(result, { accepted: true, disposition: "unknown_task" });
    assert.deepEqual(repository.markProcessingCalls, []);
  });

  test("marks a known processing callback and returns processing", async () => {
    const { repository, service } = createService();

    const result = await service.handle(processingEvent());

    assert.deepEqual(result, {
      accepted: true,
      disposition: "processing",
      generationId: GENERATION_ID,
    });
    assert.deepEqual(repository.markProcessingCalls, [TASK_ID]);
    assert.deepEqual(repository.completeCalls, []);
    assert.deepEqual(repository.failCalls, []);
  });

  test("returns duplicate for a terminal processing callback without mutation", async () => {
    const { repository, service } = createService();
    repository.generation = generation({
      status: RovelleGenerationStatus.FAILED,
    });

    const result = await service.handle(processingEvent());

    assert.deepEqual(result, {
      accepted: true,
      disposition: "duplicate",
      generationId: GENERATION_ID,
    });
    assert.deepEqual(repository.markProcessingCalls, []);
  });

  test("sanitizes and truncates provider failure fields before persistence", async () => {
    const { repository, storage, service } = createService();

    await service.handle(
      failureEvent({
        code: `  ${"C".repeat(130)}  `,
        message: `  failed: https://provider.invalid/docs ${"m".repeat(4000)}  `,
        costUsd: null,
      }),
    );

    assert.equal(repository.failCalls.length, 1);
    assert.equal(repository.failCalls[0]?.input.errorCode, "C".repeat(120));
    assert.equal(repository.failCalls[0]?.input.errorMessage.length, 4000);
    assert.equal(
      repository.failCalls[0]?.input.errorMessage.includes("https://"),
      false,
    );
    assert.equal(repository.failCalls[0]?.input.actualCostUsd, null);
    assert.deepEqual(storage.keys, []);
  });

  test("redacts provider failure URLs with arbitrary URI schemes", async () => {
    const { repository, service } = createService();

    await service.handle(
      failureEvent({
        message: "s3://private-bucket/key",
      }),
    );

    assert.equal(repository.failCalls[0]?.input.errorMessage, "[redacted-url]");
  });

  test("uses safe defaults for blank provider failure fields", async () => {
    const { repository, service } = createService();

    await service.handle(failureEvent({ code: "  ", message: "\t" }));

    assert.deepEqual(repository.failCalls[0]?.input, {
      errorCode: "RUNWARE_ERROR",
      errorMessage: "Runware generation failed",
      actualCostUsd: new Prisma.Decimal("0.125"),
    });
  });

  test("returns duplicate when a failure callback loses a terminal race", async () => {
    const { repository, service } = createService();
    repository.failResult = {
      status: "already_terminal",
      generation: generation({ status: RovelleGenerationStatus.COMPLETED }),
    };

    const result = await service.handle(failureEvent());

    assert.deepEqual(result, {
      accepted: true,
      disposition: "duplicate",
      generationId: GENERATION_ID,
    });
  });

  test("propagates R2 operational errors without terminal mutation", async () => {
    const { repository, storage, service } = createService();
    const error = new Error("R2 unavailable");
    storage.error = error;

    await assert.rejects(() => service.handle(successEvent()), error);
    assert.deepEqual(repository.completeCalls, []);
    assert.deepEqual(repository.failCalls, []);
  });
});
