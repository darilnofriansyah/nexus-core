import * as assert from "node:assert/strict";
import { test } from "node:test";
import { BadRequestException } from "@nestjs/common";
import { PrismaService } from "../../database/prisma.service";
import {
  Prisma,
  RovelleAssetStatus,
  RovelleAssetType,
  RovelleEpisodeStatus,
  RovelleGenerationModality,
  RovelleGenerationProfile,
  RovelleGenerationProvider,
  RovelleGenerationStatus,
  RovelleShotStatus,
  type RovelleShotGeneration,
} from "../../generated/prisma/client";
import { GenerationRepository } from "./generation.repository";

type RepositoryCall = {
  operation: string;
  args: unknown;
  inTransaction: boolean;
};

type GenerationWithState = RovelleShotGeneration & {
  shot: {
    id: string;
    episodeId: string;
    status: RovelleShotStatus;
    episode: {
      id: string;
      status: RovelleEpisodeStatus;
      generationBudgetUsd?: Prisma.Decimal | null;
    };
  };
};

type Episode = GenerationWithState["shot"]["episode"];

type OutputAsset = {
  id: string;
  episodeId: string | null;
  status: RovelleAssetStatus;
};

type ProviderOutputAsset = {
  storageKey: string;
};

type FakeOptions = {
  existing?: RovelleShotGeneration | null;
  raceExisting?: RovelleShotGeneration | null;
  providerOutputAsset?: ProviderOutputAsset;
  generations?: Array<RovelleShotGeneration | GenerationWithState | null>;
  episodeAttempts?: RovelleShotGeneration[];
  episode?: Episode | null;
  shot?: GenerationWithState["shot"] | null;
  latestAttempt?: number | null;
  createError?: unknown;
  transactionErrors?: unknown[];
  generationUpdateCounts?: number[];
  shotUpdateCounts?: number[];
  episodeUpdateCounts?: number[];
  generationBudgetUpdateCount?: number;
  outputAsset?: OutputAsset | null;
  outputAssetUpdateCounts?: number[];
  pendingShotCount?: number;
};

const EPISODE_ID = "550e8400-e29b-41d4-a716-446655440000";
const SHOT_ID = "123e4567-e89b-42d3-a456-426614174000";
const GENERATION_ID = "223e4567-e89b-42d3-a456-426614174000";
const REQUEST_ID = "323e4567-e89b-42d3-a456-426614174000";
const TASK_ID = "423e4567-e89b-42d3-a456-426614174000";
const ASSET_ID = "523e4567-e89b-42d3-a456-426614174000";
const STORAGE_KEY = `ringmaster/assets/${ASSET_ID}`;

const sanitizedRequest = {
  profile: "DRAFT",
  width: 1280,
  height: 720,
  duration: 4,
  audio: false,
  referenceAssetIds: ["623e4567-e89b-42d3-a456-426614174000"],
  referenceCanonVersions: [{ entityCode: "KOKO", version: 1 }],
};

const generation: RovelleShotGeneration = {
  id: GENERATION_ID,
  clientRequestId: REQUEST_ID,
  shotId: SHOT_ID,
  attempt: 2,
  provider: RovelleGenerationProvider.RUNWARE,
  modality: RovelleGenerationModality.VIDEO,
  profile: RovelleGenerationProfile.DRAFT,
  model: "vidu:2@0",
  providerTaskId: TASK_ID,
  prompt: "Koko runs through the garden.",
  request: sanitizedRequest,
  status: RovelleGenerationStatus.CREATED,
  outputAssetId: ASSET_ID,
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
};

function generationWithState(
  changes: Partial<GenerationWithState> = {},
): GenerationWithState {
  return {
    ...generation,
    shot: {
      id: SHOT_ID,
      episodeId: EPISODE_ID,
      status: RovelleShotStatus.READY_TO_GENERATE,
      episode: {
        id: EPISODE_ID,
        status: RovelleEpisodeStatus.READY_TO_GENERATE,
        generationBudgetUsd: null,
      },
    },
    ...changes,
  };
}

function createRepository(options: FakeOptions = {}) {
  const calls: RepositoryCall[] = [];
  const generations = [...(options.generations ?? [])];
  const episodeAttempts = options.episodeAttempts ?? [];
  const transactionErrors = [...(options.transactionErrors ?? [])];
  const generationUpdateCounts = [...(options.generationUpdateCounts ?? [1])];
  const shotUpdateCounts = [...(options.shotUpdateCounts ?? [1])];
  const episodeUpdateCounts = [...(options.episodeUpdateCounts ?? [1])];
  const outputAssetUpdateCounts = [...(options.outputAssetUpdateCounts ?? [1])];
  let inTransaction = false;
  let transactionCount = 0;

  const record = (operation: string, args: unknown) => {
    calls.push({ operation, args, inTransaction });
  };
  const findTransactionGeneration = async (args: unknown) => {
    record("generation.findUnique", args);
    const where = (args as { where: Record<string, unknown> }).where;
    return "clientRequestId" in where
      ? (options.existing ?? null)
      : (generations.shift() ?? null);
  };
  const transactionClient = {
    rovelleShotGeneration: {
      findUnique: findTransactionGeneration,
      aggregate: async (args: unknown) => {
        record("generation.aggregate", args);
        return { _max: { attempt: options.latestAttempt ?? null } };
      },
      findMany: async (args: unknown) => {
        record("generation.findMany", args);
        return episodeAttempts;
      },
      create: async (args: unknown) => {
        record("generation.create", args);
        if (options.createError) throw options.createError;
        return generation;
      },
      updateMany: async (args: unknown) => {
        record("generation.updateMany", args);
        return { count: generationUpdateCounts.shift() ?? 1 };
      },
    },
    rovelleShot: {
      findUnique: async (args: unknown) => {
        record("shot.findUnique", args);
        return options.shot === undefined
          ? generationWithState().shot
          : options.shot;
      },
      updateMany: async (args: unknown) => {
        record("shot.updateMany", args);
        return { count: shotUpdateCounts.shift() ?? 1 };
      },
      count: async (args: unknown) => {
        record("shot.count", args);
        return options.pendingShotCount ?? 0;
      },
    },
    rovelleEpisode: {
      findUnique: async (args: unknown) => {
        record("episode.findUnique", args);
        return options.episode === undefined
          ? generationWithState().shot.episode
          : options.episode;
      },
      updateMany: async (args: unknown) => {
        record("episode.updateMany", args);
        return { count: episodeUpdateCounts.shift() ?? 1 };
      },
    },
    rovelleAsset: {
      create: async (args: unknown) => {
        record("asset.create", args);
        return { id: ASSET_ID };
      },
      findUnique: async (args: unknown) => {
        record("asset.findUnique", args);
        return options.outputAsset === undefined
          ? {
              id: ASSET_ID,
              episodeId: EPISODE_ID,
              status: RovelleAssetStatus.RESERVED,
            }
          : options.outputAsset;
      },
      updateMany: async (args: unknown) => {
        record("asset.updateMany", args);
        return { count: outputAssetUpdateCounts.shift() ?? 1 };
      },
    },
  };
  const client = {
    rovelleShotGeneration: {
      findUnique: async (args: unknown) => {
        record("generation.findUnique", args);
        const existing = options.raceExisting ?? options.existing ?? null;
        const include = (args as { include?: unknown }).include;
        if (
          existing &&
          options.providerOutputAsset &&
          include &&
          typeof include === "object" &&
          "outputAsset" in include
        ) {
          return { ...existing, outputAsset: options.providerOutputAsset };
        }
        return existing;
      },
      findMany: async (args: unknown) => {
        record("generation.findMany", args);
        const where = (args as { where: Record<string, unknown> }).where;
        return "shot" in where ? episodeAttempts : [generation];
      },
    },
    rovelleEpisode: {
      findUnique: async (args: unknown) => {
        record("episode.findUnique", args);
        return options.episode === undefined
          ? generationWithState().shot.episode
          : options.episode;
      },
      updateMany: async (args: unknown) => {
        record("episode.updateMany", args);
        return { count: options.generationBudgetUpdateCount ?? 1 };
      },
    },
    $transaction: async <T>(
      callback: (transaction: typeof transactionClient) => Promise<T>,
      transactionOptions?: unknown,
    ): Promise<T> => {
      record("$transaction", transactionOptions);
      transactionCount += 1;
      const transactionError = transactionErrors.shift();
      if (transactionError) throw transactionError;
      inTransaction = true;
      try {
        return await callback(transactionClient);
      } finally {
        inTransaction = false;
      }
    },
  };

  return {
    calls,
    repository: new GenerationRepository({
      client,
    } as unknown as PrismaService),
    get transactionCount() {
      return transactionCount;
    },
  };
}

function callsFor(calls: RepositoryCall[], operation: string) {
  return calls.filter((call) => call.operation === operation);
}

function input(
  overrides: Partial<Parameters<GenerationRepository["createAttempt"]>[0]> = {},
) {
  return {
    clientRequestId: REQUEST_ID,
    shotId: SHOT_ID,
    episodeId: EPISODE_ID,
    providerTaskId: TASK_ID,
    outputAssetId: ASSET_ID,
    outputStorageKey: STORAGE_KEY,
    profile: RovelleGenerationProfile.DRAFT,
    model: "vidu:2@0",
    prompt: "Koko runs through the garden.",
    sanitizedRequest,
    estimatedCostUsd: new Prisma.Decimal("0.220000"),
    pricingSource: "RUNWARE_VIDU_2_0_720P_4S_OBSERVED_2026_09_07",
    ...overrides,
  };
}

test("getEpisodeCostSummary derives actual and committed spend across the episode", async () => {
  const fake = createRepository({
    episode: {
      id: EPISODE_ID,
      status: RovelleEpisodeStatus.GENERATING,
      generationBudgetUsd: new Prisma.Decimal("10.000000"),
    },
    episodeAttempts: [
      {
        ...generation,
        status: RovelleGenerationStatus.SUBMISSION_FAILED,
        estimatedCostUsd: new Prisma.Decimal("4.000000"),
        actualCostUsd: new Prisma.Decimal("1.500000"),
      },
      {
        ...generation,
        status: RovelleGenerationStatus.FAILED,
        estimatedCostUsd: new Prisma.Decimal("0.800000"),
        actualCostUsd: new Prisma.Decimal("0.250000"),
      },
      {
        ...generation,
        status: RovelleGenerationStatus.SUBMITTED,
        estimatedCostUsd: new Prisma.Decimal("0.400000"),
        actualCostUsd: null,
      },
      {
        ...generation,
        status: RovelleGenerationStatus.CREATED,
        estimatedCostUsd: new Prisma.Decimal("0.100000"),
        actualCostUsd: null,
      },
    ],
  });
  const repository = fake.repository as GenerationRepository & {
    getEpisodeCostSummary(episodeId: string): Promise<{
      episodeId: string;
      budgetUsd: Prisma.Decimal | null;
      actualSpentUsd: Prisma.Decimal;
      committedUsd: Prisma.Decimal;
    } | null>;
  };

  const summary = await repository.getEpisodeCostSummary(EPISODE_ID);

  assert.equal(summary?.episodeId, EPISODE_ID);
  assert.equal(summary?.budgetUsd?.toFixed(6), "10.000000");
  assert.equal(summary?.actualSpentUsd.toFixed(6), "1.750000");
  assert.equal(summary?.committedUsd.toFixed(6), "0.750000");
  assert.deepEqual(callsFor(fake.calls, "episode.findUnique")[0], {
    operation: "episode.findUnique",
    args: {
      where: { id: EPISODE_ID },
      select: { id: true, generationBudgetUsd: true },
    },
    inTransaction: false,
  });
  assert.deepEqual(callsFor(fake.calls, "generation.findMany")[0], {
    operation: "generation.findMany",
    args: {
      where: { shot: { episodeId: EPISODE_ID } },
      select: {
        status: true,
        estimatedCostUsd: true,
        actualCostUsd: true,
      },
    },
    inTransaction: false,
  });
});

test("setEpisodeGenerationBudget updates only an episode still in a mutable state", async () => {
  const allowedStatuses = [
    RovelleEpisodeStatus.DRAFT,
    RovelleEpisodeStatus.BRIEF_APPROVED,
    RovelleEpisodeStatus.PREPRODUCTION,
    RovelleEpisodeStatus.READY_TO_GENERATE,
    RovelleEpisodeStatus.GENERATING,
    RovelleEpisodeStatus.REVIEW_REQUIRED,
  ];

  for (const status of allowedStatuses) {
    const fake = createRepository({
      episode: {
        id: EPISODE_ID,
        status,
        generationBudgetUsd: null,
      },
    });
    const repository = fake.repository as GenerationRepository & {
      setEpisodeGenerationBudget(
        episodeId: string,
        budgetUsd: Prisma.Decimal | null,
      ): Promise<"updated" | "not_found" | "invalid_state">;
    };

    assert.equal(
      await repository.setEpisodeGenerationBudget(
        EPISODE_ID,
        new Prisma.Decimal("2.500000"),
      ),
      "updated",
    );
    assert.deepEqual(callsFor(fake.calls, "episode.updateMany")[0], {
      operation: "episode.updateMany",
      args: {
        where: {
          id: EPISODE_ID,
          status: {
            in: allowedStatuses,
          },
        },
        data: { generationBudgetUsd: new Prisma.Decimal("2.500000") },
      },
      inTransaction: false,
    });
  }
});

test("setEpisodeGenerationBudget distinguishes missing and immutable episodes", async () => {
  const immutableStatuses = [
    RovelleEpisodeStatus.GENERATION_APPROVED,
    RovelleEpisodeStatus.RENDERING,
    RovelleEpisodeStatus.FINAL_REVIEW,
    RovelleEpisodeStatus.PUBLISH_READY,
    RovelleEpisodeStatus.PUBLISHING,
    RovelleEpisodeStatus.PUBLISHED,
    RovelleEpisodeStatus.PAUSED,
    RovelleEpisodeStatus.CANCELLED,
    RovelleEpisodeStatus.FAILED,
  ];

  for (const status of immutableStatuses) {
    const fake = createRepository({
      generationBudgetUpdateCount: 0,
      episode: { id: EPISODE_ID, status, generationBudgetUsd: null },
    });
    const repository = fake.repository as GenerationRepository & {
      setEpisodeGenerationBudget(
        episodeId: string,
        budgetUsd: Prisma.Decimal | null,
      ): Promise<"updated" | "not_found" | "invalid_state">;
    };

    assert.equal(
      await repository.setEpisodeGenerationBudget(EPISODE_ID, null),
      "invalid_state",
    );
  }

  const missing = createRepository({
    generationBudgetUpdateCount: 0,
    episode: null,
  });
  const repository = missing.repository as GenerationRepository & {
    setEpisodeGenerationBudget(
      episodeId: string,
      budgetUsd: Prisma.Decimal | null,
    ): Promise<"updated" | "not_found" | "invalid_state">;
  };
  assert.equal(
    await repository.setEpisodeGenerationBudget(EPISODE_ID, null),
    "not_found",
  );
});

test("createAttempt atomically reserves the output and allocates the next attempt", async () => {
  const fake = createRepository({ latestAttempt: 4 });

  const result = await fake.repository.createAttempt(input());

  assert.deepEqual(result, { status: "created", generation });
  assert.equal(fake.transactionCount, 1);
  assert.deepEqual(callsFor(fake.calls, "$transaction")[0], {
    operation: "$transaction",
    args: { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    inTransaction: false,
  });
  assert.deepEqual(callsFor(fake.calls, "shot.findUnique")[0], {
    operation: "shot.findUnique",
    args: { where: { id: SHOT_ID }, include: { episode: true } },
    inTransaction: true,
  });
  assert.deepEqual(callsFor(fake.calls, "generation.aggregate")[0], {
    operation: "generation.aggregate",
    args: { where: { shotId: SHOT_ID }, _max: { attempt: true } },
    inTransaction: true,
  });
  assert.deepEqual(callsFor(fake.calls, "asset.create")[0], {
    operation: "asset.create",
    args: {
      data: {
        id: ASSET_ID,
        episodeId: EPISODE_ID,
        assetType: RovelleAssetType.GENERATION,
        status: RovelleAssetStatus.RESERVED,
        mediaType: "video/mp4",
        storageKey: STORAGE_KEY,
        originalFilename: null,
      },
    },
    inTransaction: true,
  });
  assert.deepEqual(callsFor(fake.calls, "generation.create")[0], {
    operation: "generation.create",
    args: {
      data: {
        clientRequestId: REQUEST_ID,
        shotId: SHOT_ID,
        attempt: 5,
        provider: RovelleGenerationProvider.RUNWARE,
        modality: RovelleGenerationModality.VIDEO,
        profile: RovelleGenerationProfile.DRAFT,
        model: "vidu:2@0",
        providerTaskId: TASK_ID,
        prompt: "Koko runs through the garden.",
        request: sanitizedRequest,
        status: RovelleGenerationStatus.CREATED,
        outputAssetId: ASSET_ID,
        estimatedCostUsd: new Prisma.Decimal("0.220000"),
        pricingSource: "RUNWARE_VIDU_2_0_720P_4S_OBSERVED_2026_09_07",
      },
    },
    inTransaction: true,
  });
});

test("createAttempt enforces the episode budget from all prior attempts before allocating output", async () => {
  const cases: Array<{
    name: string;
    budget: string | null;
    requested: string;
    attempts: RovelleShotGeneration[];
    committed: string;
    expected: "created" | "budget_exceeded";
  }> = [
    {
      name: "allows an episode with no budget",
      budget: null,
      requested: "100.000000",
      attempts: [],
      committed: "0.000000",
      expected: "created",
    },
    {
      name: "allows projected cost exactly at the budget",
      budget: "10.000000",
      requested: "2.000000",
      attempts: [
        {
          ...generation,
          status: RovelleGenerationStatus.SUBMITTED,
          estimatedCostUsd: new Prisma.Decimal("8.000000"),
        },
      ],
      committed: "8.000000",
      expected: "created",
    },
    {
      name: "rejects a cost above the Decimal budget boundary",
      budget: "10.000000",
      requested: "2.000001",
      attempts: [
        {
          ...generation,
          status: RovelleGenerationStatus.SUBMITTED,
          estimatedCostUsd: new Prisma.Decimal("8.000000"),
        },
      ],
      committed: "8.000000",
      expected: "budget_exceeded",
    },
    {
      name: "rejects a positive request against a zero budget",
      budget: "0.000000",
      requested: "0.000001",
      attempts: [],
      committed: "0.000000",
      expected: "budget_exceeded",
    },
    {
      name: "does not reserve a submission failure",
      budget: "2.000000",
      requested: "2.000000",
      attempts: [
        {
          ...generation,
          status: RovelleGenerationStatus.SUBMISSION_FAILED,
          estimatedCostUsd: new Prisma.Decimal("8.000000"),
          actualCostUsd: new Prisma.Decimal("4.000000"),
        },
      ],
      committed: "0.000000",
      expected: "created",
    },
    {
      name: "reserves a submitted estimate with no actual provider cost",
      budget: "10.000000",
      requested: "2.000000",
      attempts: [
        {
          ...generation,
          status: RovelleGenerationStatus.SUBMITTED,
          estimatedCostUsd: new Prisma.Decimal("8.000000"),
          actualCostUsd: null,
        },
      ],
      committed: "8.000000",
      expected: "created",
    },
    {
      name: "uses completed actual cost instead of estimate",
      budget: "10.000000",
      requested: "2.000000",
      attempts: [
        {
          ...generation,
          status: RovelleGenerationStatus.COMPLETED,
          estimatedCostUsd: new Prisma.Decimal("80.000000"),
          actualCostUsd: new Prisma.Decimal("8.000000"),
        },
      ],
      committed: "8.000000",
      expected: "created",
    },
    {
      name: "uses failed actual cost instead of estimate",
      budget: "10.000000",
      requested: "2.000000",
      attempts: [
        {
          ...generation,
          status: RovelleGenerationStatus.FAILED,
          estimatedCostUsd: new Prisma.Decimal("80.000000"),
          actualCostUsd: new Prisma.Decimal("8.000000"),
        },
      ],
      committed: "8.000000",
      expected: "created",
    },
    {
      name: "reserves a created attempt estimate",
      budget: "10.000000",
      requested: "2.000000",
      attempts: [
        {
          ...generation,
          status: RovelleGenerationStatus.CREATED,
          estimatedCostUsd: new Prisma.Decimal("8.000000"),
          actualCostUsd: null,
        },
      ],
      committed: "8.000000",
      expected: "created",
    },
  ];

  for (const scenario of cases) {
    const budgetUsd =
      scenario.budget === null ? null : new Prisma.Decimal(scenario.budget);
    const fake = createRepository({
      shot: {
        ...generationWithState().shot,
        episode: {
          ...generationWithState().shot.episode,
          generationBudgetUsd: budgetUsd,
        },
      },
      episodeAttempts: scenario.attempts,
    });

    const result = await fake.repository.createAttempt(
      input({ estimatedCostUsd: new Prisma.Decimal(scenario.requested) }),
    );

    assert.equal(result.status, scenario.expected, scenario.name);
    assert.deepEqual(callsFor(fake.calls, "generation.findMany")[0], {
      operation: "generation.findMany",
      args: {
        where: { shot: { episodeId: EPISODE_ID } },
        select: {
          status: true,
          estimatedCostUsd: true,
          actualCostUsd: true,
        },
      },
      inTransaction: true,
    });
    if (scenario.expected === "budget_exceeded") {
      const budgetResult = result as typeof result & {
        budgetUsd: Prisma.Decimal;
        committedUsd: Prisma.Decimal;
        requestedEstimateUsd: Prisma.Decimal;
        projectedUsd: Prisma.Decimal;
      };
      assert.equal(callsFor(fake.calls, "asset.create").length, 0);
      assert.equal(callsFor(fake.calls, "generation.create").length, 0);
      assert.equal(budgetResult.budgetUsd.toFixed(6), scenario.budget);
      assert.equal(budgetResult.committedUsd.toFixed(6), scenario.committed);
      assert.equal(
        budgetResult.requestedEstimateUsd.toFixed(6),
        scenario.requested,
      );
      assert.equal(
        budgetResult.projectedUsd.toFixed(6),
        scenario.budget === "0.000000" ? "0.000001" : "10.000001",
      );
    }
  }
});

test("createAttempt returns the existing client request without allocating another attempt", async () => {
  const fake = createRepository({ existing: generation });

  assert.deepEqual(await fake.repository.createAttempt(input()), {
    status: "existing",
    generation,
  });
  assert.equal(callsFor(fake.calls, "shot.findUnique").length, 0);
  assert.equal(callsFor(fake.calls, "generation.findMany").length, 0);
  assert.equal(callsFor(fake.calls, "generation.aggregate").length, 0);
  assert.equal(callsFor(fake.calls, "asset.create").length, 0);
  assert.equal(callsFor(fake.calls, "generation.create").length, 0);
});

test("createAttempt refuses missing or no-longer-ready shots and episodes", async () => {
  const cases: Array<{
    shot: GenerationWithState["shot"] | null;
    result: {
      status: "not_found" | "invalid_shot_state" | "invalid_episode_state";
    };
  }> = [
    { shot: null, result: { status: "not_found" } },
    {
      shot: {
        ...generationWithState().shot,
        status: RovelleShotStatus.GENERATING,
      },
      result: { status: "invalid_shot_state" },
    },
    {
      shot: {
        ...generationWithState().shot,
        episode: {
          id: EPISODE_ID,
          status: RovelleEpisodeStatus.REVIEW_REQUIRED,
        },
      },
      result: { status: "invalid_episode_state" },
    },
  ];

  for (const { shot, result } of cases) {
    const fake = createRepository({ shot });
    assert.deepEqual(await fake.repository.createAttempt(input()), result);
    assert.equal(callsFor(fake.calls, "generation.aggregate").length, 0);
    assert.equal(callsFor(fake.calls, "asset.create").length, 0);
  }
});

test("createAttempt accepts only the exact sanitized request shape", async () => {
  const requests = [
    { ...sanitizedRequest, apiKey: "secret" },
    {
      ...sanitizedRequest,
      referenceCanonVersions: [
        { entityCode: "KOKO", version: 1, authorization: "Bearer secret" },
      ],
    },
    {
      ...sanitizedRequest,
      referenceCanonVersions: [
        { entityCode: "https://secret.example/canon", version: 1 },
      ],
    },
    {
      ...sanitizedRequest,
      referenceCanonVersions: [
        { entityCode: "//secret.example/canon", version: 1 },
      ],
    },
  ];

  for (const sanitizedRequest of requests) {
    const fake = createRepository();
    await assert.rejects(
      () => fake.repository.createAttempt(input({ sanitizedRequest })),
      BadRequestException,
    );
    assert.equal(fake.transactionCount, 0);
  }
});

test("createAttempt reloads the winning attempt after an idempotency insert race", async () => {
  const fake = createRepository({
    createError: { code: "P2002" },
    raceExisting: generation,
  });

  assert.deepEqual(await fake.repository.createAttempt(input()), {
    status: "existing",
    generation,
  });
  assert.equal(fake.transactionCount, 1);
  assert.equal(
    callsFor(fake.calls, "generation.findUnique").filter(
      (call) => !call.inTransaction,
    ).length,
    1,
  );
});

test("createAttempt retries an adapter serializable write conflict", async () => {
  const fake = createRepository({
    transactionErrors: [
      {
        cause: {
          originalCode: "40001",
          originalMessage:
            "could not serialize access due to read/write dependencies among transactions",
        },
      },
    ],
  });

  assert.deepEqual(await fake.repository.createAttempt(input()), {
    status: "created",
    generation,
  });
  assert.equal(fake.transactionCount, 2);
});

test("markProcessing moves a created callback attempt into processing", async () => {
  const processing = generationWithState({
    status: RovelleGenerationStatus.PROCESSING,
  });
  const fake = createRepository({
    generations: [generationWithState(), processing],
  });

  assert.deepEqual(await fake.repository.markProcessing(TASK_ID), {
    status: "updated",
    generation: processing,
  });
});

test("findByProviderTaskId reads by the provider task UUID", async () => {
  const fake = createRepository({ existing: generation });

  assert.equal(await fake.repository.findByProviderTaskId(TASK_ID), generation);
  assert.deepEqual(callsFor(fake.calls, "generation.findUnique")[0], {
    operation: "generation.findUnique",
    args: {
      where: { providerTaskId: TASK_ID },
      include: { outputAsset: { select: { storageKey: true } } },
    },
    inTransaction: false,
  });
});

test("findByProviderTaskId returns the persisted output asset storage key", async () => {
  const outputAsset = {
    storageKey: "provider-owned/output/asset-without-derived-name.mp4",
  };
  const fake = createRepository({
    existing: generation,
    providerOutputAsset: outputAsset,
  });

  const result = await fake.repository.findByProviderTaskId(TASK_ID);

  assert.equal(
    (result as RovelleShotGeneration & { outputAsset: ProviderOutputAsset })
      .outputAsset.storageKey,
    outputAsset.storageKey,
  );
  assert.deepEqual(callsFor(fake.calls, "generation.findUnique")[0], {
    operation: "generation.findUnique",
    args: {
      where: { providerTaskId: TASK_ID },
      include: { outputAsset: { select: { storageKey: true } } },
    },
    inTransaction: false,
  });
});

test("markProcessing moves a submitted generation and promotes ready aggregates", async () => {
  const submitted = generationWithState({
    status: RovelleGenerationStatus.SUBMITTED,
  });
  const processing = {
    ...submitted,
    status: RovelleGenerationStatus.PROCESSING,
  };
  const fake = createRepository({ generations: [submitted, processing] });

  assert.deepEqual(await fake.repository.markProcessing(TASK_ID), {
    status: "updated",
    generation: processing,
  });
  assert.deepEqual(callsFor(fake.calls, "generation.updateMany")[0], {
    operation: "generation.updateMany",
    args: {
      where: {
        providerTaskId: TASK_ID,
        status: {
          in: [
            RovelleGenerationStatus.CREATED,
            RovelleGenerationStatus.SUBMITTED,
          ],
        },
      },
      data: { status: RovelleGenerationStatus.PROCESSING },
    },
    inTransaction: true,
  });
  assert.deepEqual(callsFor(fake.calls, "shot.updateMany")[0], {
    operation: "shot.updateMany",
    args: {
      where: {
        id: SHOT_ID,
        status: {
          in: [
            RovelleShotStatus.READY_TO_GENERATE,
            RovelleShotStatus.GENERATING,
          ],
        },
      },
      data: { status: RovelleShotStatus.GENERATING },
    },
    inTransaction: true,
  });
  assert.deepEqual(callsFor(fake.calls, "episode.updateMany")[0], {
    operation: "episode.updateMany",
    args: {
      where: {
        id: EPISODE_ID,
        status: {
          in: [
            RovelleEpisodeStatus.READY_TO_GENERATE,
            RovelleEpisodeStatus.GENERATING,
          ],
        },
      },
      data: { status: RovelleEpisodeStatus.GENERATING },
    },
    inTransaction: true,
  });
});

test("markProcessing is idempotent for processing and terminal generations", async () => {
  for (const status of [
    RovelleGenerationStatus.PROCESSING,
    RovelleGenerationStatus.COMPLETED,
    RovelleGenerationStatus.FAILED,
    RovelleGenerationStatus.CANCELLED,
    RovelleGenerationStatus.SUBMISSION_FAILED,
  ]) {
    const current = generationWithState({ status });
    const fake = createRepository({ generations: [current] });

    assert.deepEqual(await fake.repository.markProcessing(TASK_ID), {
      status: "already_terminal",
      generation: current,
    });
    assert.equal(callsFor(fake.calls, "generation.updateMany").length, 0);
    assert.equal(callsFor(fake.calls, "shot.updateMany").length, 0);
    assert.equal(callsFor(fake.calls, "episode.updateMany").length, 0);
  }
});

test("markProcessing returns not_found for an unknown provider task", async () => {
  const fake = createRepository();

  assert.deepEqual(await fake.repository.markProcessing(TASK_ID), {
    status: "not_found",
  });
  assert.equal(fake.transactionCount, 1);
});

test("completeGeneration updates the reserved output and reconciles terminal success atomically", async () => {
  const actualCostUsd = new Prisma.Decimal("0.250000");
  const completed = {
    ...generation,
    status: RovelleGenerationStatus.COMPLETED,
    actualCostUsd,
  };
  const fake = createRepository({
    generations: [generationWithState(), completed],
    pendingShotCount: 0,
  });

  assert.deepEqual(
    await fake.repository.completeGeneration(TASK_ID, {
      providerOutputId: "623e4567-e89b-42d3-a456-426614174000",
      actualCostUsd,
      byteSize: 42n,
      etag: "etag-video",
    }),
    { status: "updated", generation: completed },
  );
  assert.deepEqual(callsFor(fake.calls, "$transaction")[0], {
    operation: "$transaction",
    args: { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    inTransaction: false,
  });
  assert.deepEqual(callsFor(fake.calls, "asset.findUnique")[0], {
    operation: "asset.findUnique",
    args: { where: { id: ASSET_ID } },
    inTransaction: true,
  });
  assert.deepEqual(callsFor(fake.calls, "asset.updateMany")[0], {
    operation: "asset.updateMany",
    args: {
      where: { id: ASSET_ID, status: RovelleAssetStatus.RESERVED },
      data: {
        status: RovelleAssetStatus.AVAILABLE,
        byteSize: 42n,
        etag: "etag-video",
      },
    },
    inTransaction: true,
  });
  const generationUpdate = callsFor(fake.calls, "generation.updateMany")[0];
  assert.deepEqual((generationUpdate?.args as { where: unknown }).where, {
    providerTaskId: TASK_ID,
    status: {
      in: [
        RovelleGenerationStatus.CREATED,
        RovelleGenerationStatus.SUBMITTED,
        RovelleGenerationStatus.PROCESSING,
      ],
    },
  });
  const generationData = (
    generationUpdate?.args as {
      data: { status: unknown; actualCostUsd: unknown; completedAt: unknown };
    }
  ).data;
  assert.deepEqual(generationData.status, RovelleGenerationStatus.COMPLETED);
  assert.equal(generationData.actualCostUsd, actualCostUsd);
  assert.ok(generationData.completedAt instanceof Date);
  assert.deepEqual(callsFor(fake.calls, "shot.updateMany")[0], {
    operation: "shot.updateMany",
    args: {
      where: {
        id: SHOT_ID,
        status: {
          in: [
            RovelleShotStatus.READY_TO_GENERATE,
            RovelleShotStatus.GENERATING,
          ],
        },
      },
      data: { status: RovelleShotStatus.REVIEW_REQUIRED },
    },
    inTransaction: true,
  });
  assert.deepEqual(callsFor(fake.calls, "shot.count")[0], {
    operation: "shot.count",
    args: {
      where: {
        episodeId: EPISODE_ID,
        status: {
          in: [
            RovelleShotStatus.READY_TO_GENERATE,
            RovelleShotStatus.GENERATING,
          ],
        },
      },
    },
    inTransaction: true,
  });
  assert.deepEqual(callsFor(fake.calls, "episode.updateMany")[0], {
    operation: "episode.updateMany",
    args: {
      where: {
        id: EPISODE_ID,
        status: {
          in: [
            RovelleEpisodeStatus.READY_TO_GENERATE,
            RovelleEpisodeStatus.GENERATING,
          ],
        },
      },
      data: { status: RovelleEpisodeStatus.REVIEW_REQUIRED },
    },
    inTransaction: true,
  });
});

test("completeGeneration accepts every pre-terminal generation state", async () => {
  for (const status of [
    RovelleGenerationStatus.CREATED,
    RovelleGenerationStatus.SUBMITTED,
    RovelleGenerationStatus.PROCESSING,
  ]) {
    const completed = {
      ...generation,
      status: RovelleGenerationStatus.COMPLETED,
    };
    const fake = createRepository({
      generations: [generationWithState({ status }), completed],
    });

    assert.equal(
      (
        await fake.repository.completeGeneration(TASK_ID, {
          providerOutputId: null,
          actualCostUsd: null,
          byteSize: 1n,
          etag: null,
        })
      ).status,
      "updated",
    );
  }
});

test("completeGeneration fences unknown, terminal, and invalid output assets", async () => {
  const unknown = createRepository();
  assert.deepEqual(
    await unknown.repository.completeGeneration(TASK_ID, {
      providerOutputId: null,
      actualCostUsd: null,
      byteSize: 1n,
      etag: null,
    }),
    { status: "not_found" },
  );

  for (const status of [
    RovelleGenerationStatus.COMPLETED,
    RovelleGenerationStatus.FAILED,
    RovelleGenerationStatus.CANCELLED,
    RovelleGenerationStatus.SUBMISSION_FAILED,
  ]) {
    const terminalGeneration = generationWithState({ status });
    const terminal = createRepository({ generations: [terminalGeneration] });
    assert.deepEqual(
      await terminal.repository.completeGeneration(TASK_ID, {
        providerOutputId: null,
        actualCostUsd: null,
        byteSize: 1n,
        etag: null,
      }),
      { status: "already_terminal", generation: terminalGeneration },
    );
    assert.equal(callsFor(terminal.calls, "asset.updateMany").length, 0);
  }

  for (const outputAsset of [
    {
      id: "623e4567-e89b-42d3-a456-426614174000",
      episodeId: EPISODE_ID,
      status: RovelleAssetStatus.RESERVED,
    },
    {
      id: ASSET_ID,
      episodeId: "723e4567-e89b-42d3-a456-426614174000",
      status: RovelleAssetStatus.RESERVED,
    },
    {
      id: ASSET_ID,
      episodeId: EPISODE_ID,
      status: RovelleAssetStatus.AVAILABLE,
    },
  ]) {
    const fake = createRepository({
      generations: [generationWithState()],
      outputAsset,
    });
    assert.deepEqual(
      await fake.repository.completeGeneration(TASK_ID, {
        providerOutputId: null,
        actualCostUsd: null,
        byteSize: 1n,
        etag: null,
      }),
      { status: "not_found" },
    );
    assert.equal(callsFor(fake.calls, "generation.updateMany").length, 0);
  }
});

test("failGeneration records a terminal failure and reconciles remaining shots", async () => {
  const actualCostUsd = new Prisma.Decimal("0.125000");
  const failed = {
    ...generation,
    status: RovelleGenerationStatus.FAILED,
    actualCostUsd,
    errorCode: "PROVIDER_FAILURE",
    errorMessage: "Provider failed",
  };
  const fake = createRepository({
    generations: [generationWithState(), failed],
    pendingShotCount: 1,
  });

  assert.deepEqual(
    await fake.repository.failGeneration(TASK_ID, {
      errorCode: " provider_failure ",
      errorMessage: " Provider failed ",
      actualCostUsd,
    }),
    { status: "updated", generation: failed },
  );
  assert.deepEqual(callsFor(fake.calls, "generation.updateMany")[0], {
    operation: "generation.updateMany",
    args: {
      where: {
        providerTaskId: TASK_ID,
        status: {
          in: [
            RovelleGenerationStatus.CREATED,
            RovelleGenerationStatus.SUBMITTED,
            RovelleGenerationStatus.PROCESSING,
          ],
        },
      },
      data: {
        status: RovelleGenerationStatus.FAILED,
        actualCostUsd,
        errorCode: "PROVIDER_FAILURE",
        errorMessage: "Provider failed",
      },
    },
    inTransaction: true,
  });
  assert.deepEqual(callsFor(fake.calls, "shot.updateMany")[0], {
    operation: "shot.updateMany",
    args: {
      where: {
        id: SHOT_ID,
        status: {
          in: [
            RovelleShotStatus.READY_TO_GENERATE,
            RovelleShotStatus.GENERATING,
          ],
        },
      },
      data: { status: RovelleShotStatus.FAILED },
    },
    inTransaction: true,
  });
  assert.deepEqual(callsFor(fake.calls, "episode.updateMany")[0], {
    operation: "episode.updateMany",
    args: {
      where: {
        id: EPISODE_ID,
        status: {
          in: [
            RovelleEpisodeStatus.READY_TO_GENERATE,
            RovelleEpisodeStatus.GENERATING,
          ],
        },
      },
      data: { status: RovelleEpisodeStatus.GENERATING },
    },
    inTransaction: true,
  });
  assert.equal(callsFor(fake.calls, "asset.updateMany").length, 0);
});

test("failGeneration accepts submitted and processing states with the same fences", async () => {
  for (const status of [
    RovelleGenerationStatus.SUBMITTED,
    RovelleGenerationStatus.PROCESSING,
  ]) {
    const failed = {
      ...generation,
      status: RovelleGenerationStatus.FAILED,
      actualCostUsd: null,
      errorCode: "PROVIDER_FAILURE",
      errorMessage: "Provider failed",
    };
    const fake = createRepository({
      generations: [generationWithState({ status }), failed],
      pendingShotCount: 1,
    });

    assert.deepEqual(
      await fake.repository.failGeneration(TASK_ID, {
        errorCode: "provider_failure",
        errorMessage: "Provider failed",
        actualCostUsd: null,
      }),
      { status: "updated", generation: failed },
    );
    assert.equal(callsFor(fake.calls, "generation.updateMany").length, 1);
    assert.equal(callsFor(fake.calls, "shot.updateMany").length, 1);
    assert.equal(callsFor(fake.calls, "shot.count").length, 1);
    assert.equal(callsFor(fake.calls, "episode.updateMany").length, 1);
    assert.equal(callsFor(fake.calls, "asset.updateMany").length, 0);
  }
});

test("failGeneration returns terminal rows idempotently and reconciles no pending shots", async () => {
  for (const status of [
    RovelleGenerationStatus.COMPLETED,
    RovelleGenerationStatus.FAILED,
    RovelleGenerationStatus.CANCELLED,
    RovelleGenerationStatus.SUBMISSION_FAILED,
  ]) {
    const failed = generationWithState({ status });
    const fake = createRepository({ generations: [failed] });

    assert.deepEqual(
      await fake.repository.failGeneration(TASK_ID, {
        errorCode: "ignored",
        errorMessage: "ignored",
        actualCostUsd: null,
      }),
      { status: "already_terminal", generation: failed },
    );
    assert.equal(callsFor(fake.calls, "generation.updateMany").length, 0);
    assert.equal(callsFor(fake.calls, "shot.updateMany").length, 0);
    assert.equal(callsFor(fake.calls, "episode.updateMany").length, 0);
  }

  const noPending = createRepository({
    generations: [
      generationWithState(),
      generationWithState({ status: RovelleGenerationStatus.FAILED }),
    ],
    pendingShotCount: 0,
  });
  await noPending.repository.failGeneration(TASK_ID, {
    errorCode: "failed",
    errorMessage: "failed",
    actualCostUsd: null,
  });
  assert.deepEqual(
    (
      callsFor(noPending.calls, "episode.updateMany")[0]?.args as {
        data: unknown;
      }
    ).data,
    { status: RovelleEpisodeStatus.REVIEW_REQUIRED },
  );
});

test("markSubmitted moves only a created generation and ready shot into submission atomically", async () => {
  const submitted = {
    ...generation,
    status: RovelleGenerationStatus.SUBMITTED,
    submittedAt: new Date(),
  };
  const fake = createRepository({
    generations: [generationWithState(), generationWithState(submitted)],
  });

  const result = await fake.repository.markSubmitted(GENERATION_ID);

  assert.equal(result.status, "submitted");
  assert.equal(fake.transactionCount, 1);
  const generationUpdate = callsFor(fake.calls, "generation.updateMany")[0];
  assert.deepEqual((generationUpdate?.args as { where: unknown }).where, {
    id: GENERATION_ID,
    status: RovelleGenerationStatus.CREATED,
  });
  assert.equal(
    (generationUpdate?.args as { data: { status: unknown } }).data.status,
    RovelleGenerationStatus.SUBMITTED,
  );
  assert.deepEqual(callsFor(fake.calls, "shot.updateMany")[0], {
    operation: "shot.updateMany",
    args: {
      where: { id: SHOT_ID, status: RovelleShotStatus.READY_TO_GENERATE },
      data: { status: RovelleShotStatus.GENERATING },
    },
    inTransaction: true,
  });
  assert.deepEqual(callsFor(fake.calls, "episode.updateMany")[0], {
    operation: "episode.updateMany",
    args: {
      where: { id: EPISODE_ID, status: RovelleEpisodeStatus.READY_TO_GENERATE },
      data: { status: RovelleEpisodeStatus.GENERATING },
    },
    inTransaction: true,
  });
});

test("markSubmitted fences an already-generating episode", async () => {
  const current = generationWithState({
    shot: {
      ...generationWithState().shot,
      episode: { id: EPISODE_ID, status: RovelleEpisodeStatus.GENERATING },
    },
  });
  const fake = createRepository({ generations: [current, current] });

  assert.equal(
    (await fake.repository.markSubmitted(GENERATION_ID)).status,
    "submitted",
  );
  assert.deepEqual(callsFor(fake.calls, "episode.updateMany")[0], {
    operation: "episode.updateMany",
    args: {
      where: { id: EPISODE_ID, status: RovelleEpisodeStatus.GENERATING },
      data: { status: RovelleEpisodeStatus.GENERATING },
    },
    inTransaction: true,
  });
});

test("markSubmitted retries an adapter serializable write conflict", async () => {
  const current = generationWithState({
    shot: {
      ...generationWithState().shot,
      episode: { id: EPISODE_ID, status: RovelleEpisodeStatus.GENERATING },
    },
  });
  const fake = createRepository({
    generations: [current, current],
    transactionErrors: [
      {
        cause: {
          originalCode: "40001",
          originalMessage:
            "could not serialize access due to read/write dependencies among transactions",
        },
      },
    ],
  });

  assert.equal(
    (await fake.repository.markSubmitted(GENERATION_ID)).status,
    "submitted",
  );
  assert.equal(fake.transactionCount, 2);
});

test("markSubmitted aborts when an already-generating episode changes concurrently", async () => {
  const current = generationWithState({
    shot: {
      ...generationWithState().shot,
      episode: { id: EPISODE_ID, status: RovelleEpisodeStatus.GENERATING },
    },
  });
  const fake = createRepository({
    generations: [current, current],
    episodeUpdateCounts: [0],
  });

  assert.deepEqual(await fake.repository.markSubmitted(GENERATION_ID), {
    status: "invalid_state",
  });
});

test("markSubmitted returns callback-won processing and terminal generations", async () => {
  for (const status of [
    RovelleGenerationStatus.PROCESSING,
    RovelleGenerationStatus.COMPLETED,
    RovelleGenerationStatus.FAILED,
    RovelleGenerationStatus.CANCELLED,
  ]) {
    const current = generationWithState({ status });
    const fake = createRepository({ generations: [current] });

    assert.deepEqual(await fake.repository.markSubmitted(GENERATION_ID), {
      status: "already_terminal",
      generation: current,
    });
    assert.equal(callsFor(fake.calls, "generation.updateMany").length, 0);
    assert.equal(callsFor(fake.calls, "shot.updateMany").length, 0);
    assert.equal(callsFor(fake.calls, "episode.updateMany").length, 0);
  }
});

test("markSubmitted reloads a callback-won terminal row after a conditional write race", async () => {
  const terminal = generationWithState({
    status: RovelleGenerationStatus.COMPLETED,
  });
  const fake = createRepository({
    generations: [generationWithState()],
    generationUpdateCounts: [0],
    raceExisting: terminal,
  });

  assert.deepEqual(await fake.repository.markSubmitted(GENERATION_ID), {
    status: "already_terminal",
    generation: terminal,
  });
});

test("markSubmitted rejects a non-created generation without changing its shot or episode", async () => {
  const fake = createRepository({
    generations: [
      generationWithState({ status: RovelleGenerationStatus.SUBMITTED }),
    ],
  });

  assert.deepEqual(await fake.repository.markSubmitted(GENERATION_ID), {
    status: "invalid_state",
  });
  assert.equal(callsFor(fake.calls, "generation.updateMany").length, 0);
  assert.equal(callsFor(fake.calls, "shot.updateMany").length, 0);
  assert.equal(callsFor(fake.calls, "episode.updateMany").length, 0);
});

test("markSubmitted never submits a submission-failed generation", async () => {
  const fake = createRepository({
    generations: [
      generationWithState({
        status: RovelleGenerationStatus.SUBMISSION_FAILED,
      }),
    ],
  });

  assert.deepEqual(await fake.repository.markSubmitted(GENERATION_ID), {
    status: "invalid_state",
  });
  assert.equal(callsFor(fake.calls, "generation.updateMany").length, 0);
  assert.equal(callsFor(fake.calls, "shot.updateMany").length, 0);
  assert.equal(callsFor(fake.calls, "episode.updateMany").length, 0);
});

test("markSubmitted requires the shot and episode to remain generation-ready", async () => {
  const invalidShot = createRepository({
    generations: [
      generationWithState({
        shot: {
          ...generationWithState().shot,
          status: RovelleShotStatus.GENERATING,
        },
      }),
    ],
  });
  assert.deepEqual(await invalidShot.repository.markSubmitted(GENERATION_ID), {
    status: "invalid_state",
  });

  const invalidEpisode = createRepository({
    generations: [
      generationWithState({
        shot: {
          ...generationWithState().shot,
          episode: {
            id: EPISODE_ID,
            status: RovelleEpisodeStatus.REVIEW_REQUIRED,
          },
        },
      }),
    ],
  });
  assert.deepEqual(
    await invalidEpisode.repository.markSubmitted(GENERATION_ID),
    {
      status: "invalid_state",
    },
  );
});

test("markSubmissionFailed records normalized details without changing the shot, episode, or reserved asset", async () => {
  const failed = {
    ...generation,
    status: RovelleGenerationStatus.SUBMISSION_FAILED,
    errorCode: "TIMEOUT",
    errorMessage: "provider timed out",
  };
  const fake = createRepository({
    generations: [generationWithState(), generationWithState(failed)],
  });

  const result = await fake.repository.markSubmissionFailed(
    GENERATION_ID,
    " timeout ",
    " provider timed out ",
  );

  assert.equal(result.status, "submission_failed");
  assert.deepEqual(callsFor(fake.calls, "generation.updateMany")[0], {
    operation: "generation.updateMany",
    args: {
      where: { id: GENERATION_ID, status: RovelleGenerationStatus.CREATED },
      data: {
        status: RovelleGenerationStatus.SUBMISSION_FAILED,
        errorCode: "TIMEOUT",
        errorMessage: "provider timed out",
      },
    },
    inTransaction: true,
  });
  assert.equal(callsFor(fake.calls, "shot.updateMany").length, 0);
  assert.equal(callsFor(fake.calls, "episode.updateMany").length, 0);
  assert.equal(callsFor(fake.calls, "asset.create").length, 0);
});
