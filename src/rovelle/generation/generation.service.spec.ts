import * as assert from "node:assert/strict";
import { test } from "node:test";
import {
  BadGatewayException,
  ConflictException,
  InternalServerErrorException,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "../../generated/prisma/client";
import {
  RovelleGenerationModality,
  RovelleGenerationProfile,
  RovelleGenerationProvider,
  RovelleGenerationStatus,
  RovelleAssetStatus,
  RovelleAssetType,
  type RovelleShotGeneration,
} from "../../generated/prisma/client";
import type { AssetReadUrlDto } from "../assets/dto/asset.dto";
import type { R2PresignedRequest } from "../assets/r2-storage.service";
import type { PreparedShotGeneration } from "./generation-prompt.compiler";
import type {
  CreateGenerationAttemptInput,
  CreateGenerationAttemptResult,
  MarkSubmittedResult,
} from "./generation.repository";
import type { GenerationProviderSubmission } from "./providers/generation-provider";
import { RunwareSubmissionError } from "./providers/runware/runware-submit.client";
import { GenerationService } from "./generation.service";

const EPISODE_ID = "550e8400-e29b-41d4-a716-446655440000";
const SHOT_ID = "123e4567-e89b-42d3-a456-426614174000";
const REQUEST_ID = "323e4567-e89b-42d3-a456-426614174000";
const GENERATION_ID = "223e4567-e89b-42d3-a456-426614174000";
const TASK_ID = "423e4567-e89b-42d3-a456-426614174000";
const OUTPUT_ASSET_ID = "523e4567-e89b-42d3-a456-426614174000";
const FIRST_FRAME_ASSET_ID = "623e4567-e89b-42d3-a456-426614174010";
const REFERENCE_IDS = [
  "623e4567-e89b-42d3-a456-426614174000",
  "723e4567-e89b-42d3-a456-426614174000",
];

function generation(
  changes: Partial<RovelleShotGeneration> = {},
): RovelleShotGeneration {
  return {
    id: GENERATION_ID,
    clientRequestId: REQUEST_ID,
    shotId: SHOT_ID,
    attempt: 1,
    provider: RovelleGenerationProvider.RUNWARE,
    modality: RovelleGenerationModality.VIDEO,
    profile: RovelleGenerationProfile.DRAFT,
    model: "vidu:2@0",
    providerTaskId: TASK_ID,
    prompt: "Make Koko walk through the garden.",
    request: {
      profile: "DRAFT",
      width: 1280,
      height: 720,
      duration: 4,
      audio: false,
      referenceAssetIds: REFERENCE_IDS,
      referenceCanonVersions: [
        { entityCode: "KOKO", version: 1 },
        { entityCode: "GARDEN", version: 1 },
      ],
    },
    status: RovelleGenerationStatus.CREATED,
    outputAssetId: OUTPUT_ASSET_ID,
    estimatedCostUsd: new Prisma.Decimal("0.220000"),
    currency: "USD",
    pricingSource: "RUNWARE_VIDU_2_0_720P_4S_OBSERVED_2026_09_07",
    actualCostUsd: null,
    errorCode: null,
    errorMessage: null,
    submittedAt: null,
    completedAt: null,
    createdAt: new Date("2026-08-28T00:00:00.000Z"),
    updatedAt: new Date("2026-08-28T00:00:00.000Z"),
    ...changes,
  };
}

function prepared(): PreparedShotGeneration {
  return {
    shotId: SHOT_ID,
    episodeId: EPISODE_ID,
    direction: "Koko walks through the garden.",
    duration: 4,
    prompt: "Make Koko walk through the garden.",
    references: [
      {
        assetId: REFERENCE_IDS[0],
        entityCode: "KOKO",
        entityType:
          "CHARACTER" as PreparedShotGeneration["references"][number]["entityType"],
        version: 1,
        role: "PRIMARY",
        mediaType: "image/png",
      },
      {
        assetId: REFERENCE_IDS[1],
        entityCode: "GARDEN",
        entityType:
          "ENVIRONMENT" as PreparedShotGeneration["references"][number]["entityType"],
        version: 1,
        role: "PRIMARY",
        mediaType: "image/png",
      },
    ],
  };
}

class FakePreflightService {
  calls: string[] = [];
  result = prepared();

  async preflight(shotId: string): Promise<PreparedShotGeneration> {
    this.calls.push(shotId);
    return this.result;
  }
}

class FakeRepository {
  existing: RovelleShotGeneration | null = null;
  createResult: CreateGenerationAttemptResult = {
    status: "created",
    generation: generation(),
  };
  markSubmittedResult: MarkSubmittedResult = {
    status: "submitted",
    generation: generation({ status: RovelleGenerationStatus.SUBMITTED }),
  };
  markSubmittedError: unknown;
  markSubmissionFailedResult: unknown = {
    status: "submission_failed",
    generation: generation({
      status: RovelleGenerationStatus.SUBMISSION_FAILED,
    }),
  };
  markSubmissionFailedError: unknown;
  listResult: RovelleShotGeneration[] = [];
  findResult: RovelleShotGeneration | null = generation();
  createInput: CreateGenerationAttemptInput | undefined;
  failed: Array<{ id: string; code: string; message: string }> = [];
  readonly events: string[];

  constructor(events: string[]) {
    this.events = events;
  }

  async findByClientRequestId(): Promise<RovelleShotGeneration | null> {
    this.events.push("existing");
    return this.existing;
  }

  async createAttempt(
    input: CreateGenerationAttemptInput,
  ): Promise<CreateGenerationAttemptResult> {
    this.events.push("create");
    this.createInput = input;
    return this.createResult;
  }

  async markSubmitted(): Promise<MarkSubmittedResult> {
    this.events.push("markSubmitted");
    if (this.markSubmittedError) throw this.markSubmittedError;
    return this.markSubmittedResult;
  }

  async markSubmissionFailed(
    id: string,
    code: string,
    message: string,
  ): Promise<unknown> {
    this.events.push("markSubmissionFailed");
    this.failed.push({ id, code, message });
    if (this.markSubmissionFailedError) throw this.markSubmissionFailedError;
    return this.markSubmissionFailedResult;
  }

  async findById(): Promise<RovelleShotGeneration | null> {
    return this.findResult;
  }

  async listForShot(): Promise<RovelleShotGeneration[]> {
    return this.listResult;
  }
}

class FakeAssetService {
  calls: string[] = [];
  readonly events: string[];

  constructor(events: string[]) {
    this.events = events;
  }

  async createReadUrl(id: string): Promise<AssetReadUrlDto> {
    this.events.push(`read:${id}`);
    this.calls.push(id);
    return {
      asset: {
        id,
        episodeId: EPISODE_ID,
        assetType: RovelleAssetType.STORYBOARD,
        status: RovelleAssetStatus.AVAILABLE,
        mediaType: "image/png",
        originalFilename: null,
        byteSize: "100",
        etag: null,
        createdAt: "2026-08-28T00:00:00.000Z",
        updatedAt: "2026-08-28T00:00:00.000Z",
      },
      download: {
        method: "GET",
        url: `https://signed.example/read-${this.calls.length}`,
        headers: {},
        expiresAt: "2026-08-28T01:00:00.000Z",
      },
    };
  }
}

class FakeStorageService {
  keys: string[] = [];
  readonly events: string[];

  constructor(events: string[]) {
    this.events = events;
  }

  async createProviderPutUrl(key: string): Promise<R2PresignedRequest> {
    this.events.push("providerPut");
    this.keys.push(key);
    return {
      method: "PUT",
      url: "https://signed.example/provider-output",
      headers: {},
      expiresAt: "2026-08-28T01:00:00.000Z",
    };
  }
}

class FakeProvider {
  calls: GenerationProviderSubmission[] = [];
  error: unknown;
  readonly events: string[];

  constructor(events: string[]) {
    this.events = events;
  }

  async submit(
    request: GenerationProviderSubmission,
  ): Promise<{ providerTaskId: string }> {
    this.events.push("provider");
    this.calls.push(request);
    if (this.error) throw this.error;
    return { providerTaskId: request.taskId };
  }
}

function createService(model = "vidu:2@0") {
  const events: string[] = [];
  const preflight = new FakePreflightService();
  const repository = new FakeRepository(events);
  const assets = new FakeAssetService(events);
  const storage = new FakeStorageService(events);
  const provider = new FakeProvider(events);
  return {
    events,
    preflight,
    repository,
    assets,
    storage,
    provider,
    service: new GenerationService(
      preflight as unknown as ConstructorParameters<
        typeof GenerationService
      >[0],
      repository as unknown as ConstructorParameters<
        typeof GenerationService
      >[1],
      assets as unknown as ConstructorParameters<typeof GenerationService>[2],
      storage as unknown as ConstructorParameters<typeof GenerationService>[3],
      provider as unknown as ConstructorParameters<typeof GenerationService>[4],
      model,
    ),
  };
}

test("submits Q3 with only the episode storyboard first frame", async () => {
  const { service, assets, provider, repository } = createService("vidu:4@1");

  await service.submitShot(SHOT_ID, {
    requestId: REQUEST_ID,
    profile: "DRAFT",
    firstFrameAssetId: FIRST_FRAME_ASSET_ID,
  });

  assert.deepEqual(assets.calls, [FIRST_FRAME_ASSET_ID]);
  assert.deepEqual(provider.calls, [{
    taskId: repository.createInput?.providerTaskId,
    prompt: "Make Koko walk through the garden.",
    duration: 4,
    width: 1280,
    height: 720,
    referenceImageUrls: [],
    frameImageUrl: "https://signed.example/read-1",
    uploadUrl: "https://signed.example/provider-output",
  }]);
  assert.equal(
    (repository.createInput?.sanitizedRequest as { firstFrameAssetId?: string })
      .firstFrameAssetId,
    FIRST_FRAME_ASSET_ID,
  );
});

test("persists the injected Runware video model with the attempt", async () => {
  const { service, repository } = createService("custom:seedance@2.5");

  await service.submitShot(SHOT_ID, {
    requestId: REQUEST_ID,
    profile: "DRAFT",
  });

  assert.equal(repository.createInput?.model, "custom:seedance@2.5");
});

test("returns an existing client request without preflight or provider submission", async () => {
  const { service, repository, preflight, provider, events } = createService();
  repository.existing = generation({
    status: RovelleGenerationStatus.SUBMITTED,
  });

  const result = await service.submitShot(SHOT_ID, {
    requestId: REQUEST_ID,
    profile: "DRAFT",
  });

  assert.equal(result.id, GENERATION_ID);
  assert.deepEqual(events, ["existing"]);
  assert.equal(preflight.calls.length, 0);
  assert.equal(provider.calls.length, 0);
});

test("maps an authoritative budget rejection to a safe 409 before signed URLs or provider spend", async () => {
  const { service, repository, assets, storage, provider, events } =
    createService();
  repository.createResult = {
    status: "budget_exceeded",
    budgetUsd: new Prisma.Decimal("10.000000"),
    committedUsd: new Prisma.Decimal("8.000000"),
    requestedEstimateUsd: new Prisma.Decimal("2.500000"),
    projectedUsd: new Prisma.Decimal("10.500000"),
  };

  await assert.rejects(
    () =>
      service.submitShot(SHOT_ID, { requestId: REQUEST_ID, profile: "DRAFT" }),
    (error: unknown) => {
      if (!(error instanceof ConflictException)) return false;
      assert.equal(error.getStatus(), 409);
      assert.deepEqual(error.getResponse(), {
        message: "Episode generation budget would be exceeded",
        budgetUsd: "10.000000",
        committedUsd: "8.000000",
        requestedEstimateUsd: "2.500000",
        projectedUsd: "10.500000",
      });
      return true;
    },
  );

  assert.deepEqual(events, ["existing", "create"]);
  assert.equal(assets.calls.length, 0);
  assert.equal(storage.keys.length, 0);
  assert.equal(provider.calls.length, 0);
});

test("returns a previously accepted request even when its current budget would reject a new attempt", async () => {
  const { service, repository, preflight, provider, events } = createService();
  repository.existing = generation({
    status: RovelleGenerationStatus.SUBMITTED,
  });
  repository.createResult = {
    status: "budget_exceeded",
    budgetUsd: new Prisma.Decimal("1.000000"),
    committedUsd: new Prisma.Decimal("1.000000"),
    requestedEstimateUsd: new Prisma.Decimal("0.220000"),
    projectedUsd: new Prisma.Decimal("1.220000"),
  };

  const result = await service.submitShot(SHOT_ID, {
    requestId: REQUEST_ID,
    profile: "DRAFT",
  });

  assert.equal(result.status, RovelleGenerationStatus.SUBMITTED);
  assert.deepEqual(events, ["existing"]);
  assert.equal(preflight.calls.length, 0);
  assert.equal(provider.calls.length, 0);
});

test("persists the attempt before issuing ordered reference and output URLs", async () => {
  const { service, repository, preflight, assets, storage, provider, events } =
    createService();

  await service.submitShot(SHOT_ID, {
    requestId: REQUEST_ID,
    profile: "DRAFT",
  });

  assert.deepEqual(preflight.calls, [SHOT_ID]);
  assert.match(repository.createInput?.providerTaskId ?? "", /^[0-9a-f]{8}-/i);
  assert.match(repository.createInput?.outputAssetId ?? "", /^[0-9a-f]{8}-/i);
  assert.notEqual(
    repository.createInput?.providerTaskId,
    repository.createInput?.outputAssetId,
  );
  assert.equal(
    repository.createInput?.outputStorageKey,
    `ringmaster/assets/${repository.createInput?.outputAssetId}`,
  );
  assert.equal(repository.createInput?.estimatedCostUsd.toFixed(6), "0.220000");
  assert.equal(
    repository.createInput?.pricingSource,
    "RUNWARE_VIDU_2_0_720P_4S_OBSERVED_2026_09_07",
  );
  assert.deepEqual(events, [
    "existing",
    "create",
    `read:${REFERENCE_IDS[0]}`,
    `read:${REFERENCE_IDS[1]}`,
    "providerPut",
    "provider",
    "markSubmitted",
  ]);
  assert.deepEqual(assets.calls, REFERENCE_IDS);
  assert.deepEqual(storage.keys, [repository.createInput?.outputStorageKey]);
  assert.equal(provider.calls.length, 1);
});

test("submits only prompt, settings, and temporary URLs to the provider", async () => {
  const { service, repository, provider } = createService();

  await service.submitShot(SHOT_ID, {
    requestId: REQUEST_ID,
    profile: "DRAFT",
  });

  assert.deepEqual(provider.calls, [
    {
      taskId: repository.createInput?.providerTaskId,
      prompt: "Make Koko walk through the garden.",
      duration: 4,
      width: 1280,
      height: 720,
      referenceImageUrls: [
        "https://signed.example/read-1",
        "https://signed.example/read-2",
      ],
      uploadUrl: "https://signed.example/provider-output",
    },
  ]);
  assert.equal(JSON.stringify(provider.calls).includes(SHOT_ID), false);
  assert.equal(JSON.stringify(provider.calls).includes(EPISODE_ID), false);
  assert.equal(
    JSON.stringify(provider.calls).includes(REFERENCE_IDS[0]),
    false,
  );
  assert.equal(
    JSON.stringify(provider.calls).includes(REFERENCE_IDS[1]),
    false,
  );
});

test("stores the allowlisted request snapshot without temporary URLs", async () => {
  const { service, repository } = createService();

  await service.submitShot(SHOT_ID, {
    requestId: REQUEST_ID,
    profile: "DRAFT",
  });

  assert.deepEqual(repository.createInput?.sanitizedRequest, {
    profile: "DRAFT",
    width: 1280,
    height: 720,
    duration: 4,
    audio: false,
    referenceAssetIds: REFERENCE_IDS,
    referenceCanonVersions: [
      { entityCode: "KOKO", version: 1 },
      { entityCode: "GARDEN", version: 1 },
    ],
  });
  assert.equal(
    JSON.stringify(repository.createInput?.sanitizedRequest).includes("http"),
    false,
  );
});

test("marks an accepted provider task submitted and returns its mapped attempt", async () => {
  const { service, repository, provider } = createService();
  repository.markSubmittedResult = {
    status: "submitted",
    generation: generation({ status: RovelleGenerationStatus.SUBMITTED }),
  };

  const result = await service.submitShot(SHOT_ID, {
    requestId: REQUEST_ID,
    profile: "DRAFT",
  });

  assert.equal(provider.calls.length, 1);
  assert.equal(result.status, RovelleGenerationStatus.SUBMITTED);
});

test("returns the callback-won generation after provider acceptance", async () => {
  const { service, repository, provider } = createService();
  repository.markSubmittedResult = {
    status: "already_terminal",
    generation: generation({ status: RovelleGenerationStatus.PROCESSING }),
  };

  const result = await service.submitShot(SHOT_ID, {
    requestId: REQUEST_ID,
    profile: "DRAFT",
  });

  assert.equal(provider.calls.length, 1);
  assert.equal(result.status, RovelleGenerationStatus.PROCESSING);
});

test("records normalized provider failure and redacts temporary URLs from the gateway error", async () => {
  const { service, repository, provider } = createService();
  provider.error = new RunwareSubmissionError(
    "RATE_LIMIT",
    "retry https://signed.example/should-not-leak",
    true,
  );

  await assert.rejects(
    () =>
      service.submitShot(SHOT_ID, { requestId: REQUEST_ID, profile: "DRAFT" }),
    (error: unknown) => {
      if (!(error instanceof BadGatewayException)) return false;
      const body = error.getResponse() as Record<string, unknown>;
      assert.deepEqual(body, {
        message: "Runware generation submission failed",
        generationId: GENERATION_ID,
        code: "RATE_LIMIT",
      });
      assert.equal(JSON.stringify(body).includes("signed.example"), false);
      return true;
    },
  );

  assert.deepEqual(repository.failed, [
    {
      id: GENERATION_ID,
      code: "RATE_LIMIT",
      message: "retry [redacted-url]",
    },
  ]);
});

test("returns 500 without resubmitting when provider failure persistence is not durable", async () => {
  const { service, repository, provider } = createService();
  provider.error = new RunwareSubmissionError(
    "RATE_LIMIT",
    "retry later",
    true,
  );
  repository.markSubmissionFailedResult = { status: "invalid_state" };

  await assert.rejects(
    () =>
      service.submitShot(SHOT_ID, { requestId: REQUEST_ID, profile: "DRAFT" }),
    (error: unknown) => {
      if (!(error instanceof InternalServerErrorException)) return false;
      assert.deepEqual(error.getResponse(), {
        message: "Generation submission failure persistence failed",
        generationId: GENERATION_ID,
      });
      return true;
    },
  );

  assert.equal(provider.calls.length, 1);
  assert.equal(repository.failed.length, 1);
});

test("returns 500 without resubmitting when provider failure persistence throws", async () => {
  const { service, repository, provider } = createService();
  provider.error = new RunwareSubmissionError(
    "RATE_LIMIT",
    "retry later",
    true,
  );
  repository.markSubmissionFailedError = new Error("database unavailable");

  await assert.rejects(
    () =>
      service.submitShot(SHOT_ID, { requestId: REQUEST_ID, profile: "DRAFT" }),
    (error: unknown) => {
      if (!(error instanceof InternalServerErrorException)) return false;
      assert.deepEqual(error.getResponse(), {
        message: "Generation submission failure persistence failed",
        generationId: GENERATION_ID,
      });
      return true;
    },
  );

  assert.equal(provider.calls.length, 1);
  assert.equal(repository.failed.length, 1);
});

test("does not treat an unnormalized provider error as a submission failure", async () => {
  const { service, repository, provider } = createService();
  const providerError = new Error("unexpected provider failure");
  provider.error = providerError;

  await assert.rejects(
    () =>
      service.submitShot(SHOT_ID, { requestId: REQUEST_ID, profile: "DRAFT" }),
    (error: unknown) => error === providerError,
  );

  assert.equal(repository.failed.length, 0);
});

test("does not resubmit a provider-accepted task when submission persistence fails", async () => {
  const { service, repository, provider } = createService();
  repository.markSubmittedError = new Error("database unavailable");

  await assert.rejects(
    () =>
      service.submitShot(SHOT_ID, { requestId: REQUEST_ID, profile: "DRAFT" }),
    (error: unknown) => {
      if (!(error instanceof InternalServerErrorException)) return false;
      assert.deepEqual(error.getResponse(), {
        message: "Generation submission acceptance persistence failed",
        generationId: GENERATION_ID,
      });
      return true;
    },
  );

  assert.equal(provider.calls.length, 1);
  assert.equal(repository.failed.length, 0);
});

test("returns attempts in repository order and rejects a missing generation", async () => {
  const { service, repository } = createService();
  const first = generation({
    id: "823e4567-e89b-42d3-a456-426614174000",
    attempt: 1,
  });
  const second = generation({
    id: "923e4567-e89b-42d3-a456-426614174000",
    attempt: 2,
  });
  repository.listResult = [first, second];
  repository.findResult = null;

  const listed = await service.listShotGenerations(SHOT_ID);

  assert.deepEqual(
    listed.map(({ id, attempt }) => ({ id, attempt })),
    [
      { id: first.id, attempt: 1 },
      { id: second.id, attempt: 2 },
    ],
  );
  await assert.rejects(
    () => service.getGeneration(GENERATION_ID),
    NotFoundException,
  );
});
