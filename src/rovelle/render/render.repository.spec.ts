import * as assert from "node:assert/strict";
import { test } from "node:test";
import {
  Prisma,
  RovelleAssetStatus,
  RovelleAssetType,
  RovelleEpisodeStatus,
  RovelleGenerationModality,
  RovelleGenerationProfile,
  RovelleGenerationProvider,
  RovelleGenerationStatus,
  RovelleRenderJobStatus,
  RovelleRenderProfile,
  RovelleRenderStatus,
  RovelleShotStatus,
  type RovelleAsset,
  type RovelleRenderJob,
  type RovelleShotGeneration,
} from "../../generated/prisma/client";
import { PrismaService } from "../../database/prisma.service";
import {
  RenderRepository,
  type InternalRenderRecord,
} from "./render.repository";

type RepositoryCall = {
  operation: string;
  args: unknown;
  inTransaction: boolean;
};

type ApprovedGeneration = RovelleShotGeneration & { outputAsset: RovelleAsset };

type ShotSource = {
  id: string;
  sequence: number;
  status: RovelleShotStatus;
  approvedGenerationId: string | null;
  targetDurationSeconds: number | null;
  approvedGeneration: ApprovedGeneration | null;
};

type Episode = { id: string; status: RovelleEpisodeStatus };

type FakeOptions = {
  existing?: InternalRenderRecord | null;
  raceExisting?: InternalRenderRecord | null;
  episode?: Episode | null;
  shots?: ShotSource[];
  audio?: RovelleAsset | null;
  caption?: RovelleAsset | null;
  latestAttempt?: number | null;
  createdRender?: InternalRenderRecord | null;
  createError?: unknown;
  transactionErrors?: unknown[];
  episodeUpdateCounts?: number[];
  findRender?: InternalRenderRecord | null;
  listRenders?: InternalRenderRecord[];
};

const EPISODE_ID = "550e8400-e29b-41d4-a716-446655440000";
const SHOT_ID = "123e4567-e89b-42d3-a456-426614174000";
const GENERATION_ID = "223e4567-e89b-42d3-a456-426614174000";
const REQUEST_ID = "323e4567-e89b-42d3-a456-426614174000";
const AUDIO_ID = "423e4567-e89b-42d3-a456-426614174000";
const CAPTION_ID = "523e4567-e89b-42d3-a456-426614174000";
const OUTPUT_ID = "623e4567-e89b-42d3-a456-426614174000";
const RENDER_ID = "723e4567-e89b-42d3-a456-426614174000";
const JOB_ID = "823e4567-e89b-42d3-a456-426614174000";

function asset(changes: Partial<RovelleAsset> = {}): RovelleAsset {
  return {
    id: "923e4567-e89b-42d3-a456-426614174000",
    episodeId: EPISODE_ID,
    assetType: RovelleAssetType.GENERATION,
    status: RovelleAssetStatus.AVAILABLE,
    mediaType: "video/mp4",
    storageKey: "rovelle/private/source.mp4",
    originalFilename: null,
    byteSize: 42n,
    etag: null,
    createdAt: new Date("2026-08-29T00:00:00.000Z"),
    updatedAt: new Date("2026-08-29T00:00:00.000Z"),
    ...changes,
  };
}

function approvedGeneration(
  changes: Partial<ApprovedGeneration> = {},
): ApprovedGeneration {
  return {
    id: GENERATION_ID,
    clientRequestId: "a23e4567-e89b-42d3-a456-426614174000",
    shotId: SHOT_ID,
    attempt: 1,
    provider: RovelleGenerationProvider.RUNWARE,
    modality: RovelleGenerationModality.VIDEO,
    profile: RovelleGenerationProfile.PRODUCTION,
    model: "seedance",
    providerTaskId: "b23e4567-e89b-42d3-a456-426614174000",
    prompt: "private prompt",
    request: {},
    status: RovelleGenerationStatus.COMPLETED,
    outputAssetId: "c23e4567-e89b-42d3-a456-426614174000",
    estimatedCostUsd: new Prisma.Decimal("0.1"),
    currency: "USD",
    pricingSource: "test",
    actualCostUsd: new Prisma.Decimal("0.1"),
    errorCode: null,
    errorMessage: null,
    submittedAt: null,
    completedAt: new Date("2026-08-29T00:00:00.000Z"),
    createdAt: new Date("2026-08-29T00:00:00.000Z"),
    updatedAt: new Date("2026-08-29T00:00:00.000Z"),
    outputAsset: asset(),
    ...changes,
  };
}

function shot(changes: Partial<ShotSource> = {}): ShotSource {
  const generation = approvedGeneration();
  return {
    id: SHOT_ID,
    sequence: 1,
    status: RovelleShotStatus.APPROVED,
    approvedGenerationId: generation.id,
    targetDurationSeconds: 5,
    approvedGeneration: generation,
    ...changes,
  };
}

function audio(changes: Partial<RovelleAsset> = {}): RovelleAsset {
  return asset({
    id: AUDIO_ID,
    assetType: RovelleAssetType.AUDIO_MASTER,
    mediaType: "audio/mpeg",
    byteSize: 128n,
    ...changes,
  });
}

function caption(changes: Partial<RovelleAsset> = {}): RovelleAsset {
  return asset({
    id: CAPTION_ID,
    assetType: RovelleAssetType.CAPTION,
    mediaType: "text/vtt",
    byteSize: 8n,
    ...changes,
  });
}

function renderJob(changes: Partial<RovelleRenderJob> = {}): RovelleRenderJob {
  return {
    id: JOB_ID,
    clientRequestId: REQUEST_ID,
    renderId: RENDER_ID,
    attempt: 1,
    status: RovelleRenderJobStatus.QUEUED,
    availableAt: new Date("2026-08-29T00:00:00.000Z"),
    workerId: null,
    leaseToken: null,
    claimedAt: null,
    heartbeatAt: null,
    leaseExpiresAt: null,
    startedAt: null,
    finishedAt: null,
    errorCode: null,
    errorMessage: null,
    createdAt: new Date("2026-08-29T00:00:00.000Z"),
    updatedAt: new Date("2026-08-29T00:00:00.000Z"),
    ...changes,
  };
}

function render(changes: Partial<InternalRenderRecord> = {}): InternalRenderRecord {
  return {
    id: RENDER_ID,
    clientRequestId: REQUEST_ID,
    episodeId: EPISODE_ID,
    attempt: 1,
    profile: RovelleRenderProfile.VERTICAL_SHORT_V1,
    status: RovelleRenderStatus.QUEUED,
    specVersion: 1,
    spec: {},
    specHash: "a".repeat(64),
    outputAssetId: OUTPUT_ID,
    completedAt: null,
    createdAt: new Date("2026-08-29T00:00:00.000Z"),
    updatedAt: new Date("2026-08-29T00:00:00.000Z"),
    outputAsset: asset({ id: OUTPUT_ID, assetType: RovelleAssetType.RENDER }),
    jobs: [renderJob()],
    ...changes,
  };
}

function input(changes: Partial<Parameters<RenderRepository["createQueuedRender"]>[0]> = {}) {
  return {
    clientRequestId: REQUEST_ID,
    episodeId: EPISODE_ID,
    audioAssetId: AUDIO_ID,
    captionAssetId: CAPTION_ID,
    outputAssetId: OUTPUT_ID,
    outputStorageKey: "rovelle/private/render.mp4",
    ...changes,
  };
}

function createRepository(options: FakeOptions = {}) {
  const calls: RepositoryCall[] = [];
  const transactionErrors = [...(options.transactionErrors ?? [])];
  const episodeUpdateCounts = [...(options.episodeUpdateCounts ?? [1])];
  const committedWrites: string[] = [];
  const rolledBackWrites: string[] = [];
  let inTransaction = false;
  let transactionCount = 0;
  let stagedWrites: string[] = [];

  const record = (operation: string, args: unknown) =>
    calls.push({ operation, args, inTransaction });
  const write = (operation: string) => stagedWrites.push(operation);
  const currentEpisode = options.episode === undefined
    ? { id: EPISODE_ID, status: RovelleEpisodeStatus.GENERATION_APPROVED }
    : options.episode;
  const currentShots = options.shots ?? [shot()];
  const currentAudio = options.audio === undefined ? audio() : options.audio;
  const currentCaption = options.caption === undefined ? caption() : options.caption;
  const created = options.createdRender ?? render();
  const include = {
    outputAsset: true,
    jobs: { orderBy: { attempt: "asc" as const } },
  };

  const transactionClient = {
    rovelleRender: {
      findUnique: async (args: unknown) => {
        record("render.findUnique", args);
        const where = (args as { where: Record<string, unknown> }).where;
        return "clientRequestId" in where ? (options.existing ?? null) : created;
      },
      aggregate: async (args: unknown) => {
        record("render.aggregate", args);
        return { _max: { attempt: options.latestAttempt ?? null } };
      },
      create: async (args: unknown) => {
        record("render.create", args);
        write("render");
        if (options.createError) throw options.createError;
        return created;
      },
    },
    rovelleEpisode: {
      findUnique: async (args: unknown) => {
        record("episode.findUnique", args);
        return currentEpisode;
      },
      updateMany: async (args: unknown) => {
        record("episode.updateMany", args);
        write("episode");
        return { count: episodeUpdateCounts.shift() ?? 1 };
      },
    },
    rovelleShot: {
      findMany: async (args: unknown) => {
        record("shot.findMany", args);
        return currentShots;
      },
    },
    rovelleAsset: {
      findUnique: async (args: unknown) => {
        record("asset.findUnique", args);
        const id = (args as { where: { id: string } }).where.id;
        if (id === AUDIO_ID) return currentAudio;
        if (id === CAPTION_ID) return currentCaption;
        return null;
      },
      create: async (args: unknown) => {
        record("asset.create", args);
        write("asset");
        return asset({ id: OUTPUT_ID, assetType: RovelleAssetType.RENDER });
      },
    },
    rovelleRenderJob: {
      create: async (args: unknown) => {
        record("job.create", args);
        write("job");
        return renderJob();
      },
    },
  };

  const client = {
    $transaction: async <T>(
      callback: (tx: typeof transactionClient) => Promise<T>,
      transactionOptions: unknown,
    ): Promise<T> => {
      record("$transaction", transactionOptions);
      transactionCount += 1;
      const error = transactionErrors.shift();
      if (error) throw error;
      inTransaction = true;
      stagedWrites = [];
      try {
        const result = await callback(transactionClient);
        committedWrites.push(...stagedWrites);
        return result;
      } catch (error) {
        rolledBackWrites.push(...stagedWrites);
        throw error;
      } finally {
        inTransaction = false;
      }
    },
    rovelleRender: {
      findUnique: async (args: unknown) => {
        record("client.render.findUnique", args);
        const where = (args as { where: Record<string, unknown> }).where;
        return "clientRequestId" in where
          ? (options.raceExisting ?? options.findRender ?? null)
          : (options.findRender ?? null);
      },
      findMany: async (args: unknown) => {
        record("client.render.findMany", args);
        return options.listRenders ?? [];
      },
    },
  };

  return {
    repository: new RenderRepository({ client } as unknown as PrismaService),
    calls,
    committedWrites,
    rolledBackWrites,
    get transactionCount() {
      return transactionCount;
    },
    include,
  };
}

function callsFor(calls: RepositoryCall[], operation: string) {
  return calls.filter((call) => call.operation === operation);
}

function hasUnsafeSpecValue(value: unknown): boolean {
  if (typeof value === "string") {
    return /storageKey|url|token|secret|authorization|https?:\/\//i.test(value);
  }
  if (Array.isArray(value)) return value.some(hasUnsafeSpecValue);
  if (value !== null && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).some(
      ([key, nested]) =>
        /storageKey|url|token|secret|authorization/i.test(key) ||
        hasUnsafeSpecValue(nested),
    );
  }
  return false;
}

type RetryRenderResult = { status: string; render?: InternalRenderRecord };

type RetryRenderRepository = RenderRepository & {
  retryRender(input: {
    renderId: string;
    clientRequestId: string;
  }): Promise<RetryRenderResult>;
};

type RetryOptions = {
  render?: InternalRenderRecord | null;
  episode?: Episode | null;
  requestJob?: (RovelleRenderJob & { render: InternalRenderRecord }) | null;
  latestJobAttempt?: number | null;
  renderUpdateCounts?: number[];
  transactionErrors?: unknown[];
  afterRace?: InternalRenderRecord | null;
  afterSerialization?: InternalRenderRecord | null;
};

function failedRender(changes: Partial<InternalRenderRecord> = {}) {
  return render({
    status: RovelleRenderStatus.FAILED,
    outputAsset: asset({
      id: OUTPUT_ID,
      assetType: RovelleAssetType.RENDER,
      status: RovelleAssetStatus.RESERVED,
    }),
    jobs: [
      renderJob({
        status: RovelleRenderJobStatus.FAILED,
        workerId: "render-worker",
        errorCode: "RENDER_FAILED",
        errorMessage: "encoder stopped",
        startedAt: new Date("2026-08-29T00:01:00.000Z"),
        finishedAt: new Date("2026-08-29T00:02:00.000Z"),
      }),
    ],
    ...changes,
  });
}

function retryInput(changes: Partial<{ renderId: string; clientRequestId: string }> = {}) {
  return {
    renderId: RENDER_ID,
    clientRequestId: "923e4567-e89b-42d3-a456-426614174001",
    ...changes,
  };
}

function createRetryRepository(options: RetryOptions = {}) {
  const calls: RepositoryCall[] = [];
  const transactionErrors = [...(options.transactionErrors ?? [])];
  const renderUpdateCounts = [...(options.renderUpdateCounts ?? [1])];
  let current = options.render === undefined ? failedRender() : options.render;
  const reloaded = current === null
    ? null
    : render({
      ...current,
      status: RovelleRenderStatus.QUEUED,
      jobs: [
        ...current.jobs,
        renderJob({
          id: "a23e4567-e89b-42d3-a456-426614174001",
          clientRequestId: retryInput().clientRequestId,
          attempt: (options.latestJobAttempt ?? current.jobs.at(-1)?.attempt ?? 0) + 1,
          status: RovelleRenderJobStatus.QUEUED,
        }),
      ],
    });
  let targetReads = 0;
  let inTransaction = false;
  const record = (operation: string, args: unknown) =>
    calls.push({ operation, args, inTransaction });
  const transactionClient = {
    rovelleRenderJob: {
      findUnique: async (args: unknown) => {
        record("retry.job.findUnique", args);
        return options.requestJob ?? null;
      },
      aggregate: async (args: unknown) => {
        record("retry.job.aggregate", args);
        return {
          _max: {
            attempt: options.latestJobAttempt ?? current?.jobs.at(-1)?.attempt ?? null,
          },
        };
      },
      create: async (args: unknown) => {
        record("retry.job.create", args);
        return renderJob();
      },
    },
    rovelleRender: {
      findUnique: async (args: unknown) => {
        record("retry.render.findUnique", args);
        targetReads += 1;
        return targetReads === 1 ? current : reloaded;
      },
      updateMany: async (args: unknown) => {
        record("retry.render.updateMany", args);
        return { count: renderUpdateCounts.shift() ?? 1 };
      },
    },
    rovelleEpisode: {
      findUnique: async (args: unknown) => {
        record("retry.episode.findUnique", args);
        return options.episode === undefined
          ? { id: EPISODE_ID, status: RovelleEpisodeStatus.RENDERING }
          : options.episode;
      },
    },
  };
  const client = {
    $transaction: async <T>(
      callback: (tx: typeof transactionClient) => Promise<T>,
      transactionOptions: unknown,
    ): Promise<T> => {
      record("retry.$transaction", transactionOptions);
      const error = transactionErrors.shift();
      if (error) {
        current = options.afterSerialization ?? current;
        throw error;
      }
      inTransaction = true;
      try {
        return await callback(transactionClient);
      } finally {
        inTransaction = false;
      }
    },
    rovelleRender: {
      findUnique: async (args: unknown) => {
        record("retry.client.render.findUnique", args);
        return options.afterRace ?? null;
      },
    },
  };

  return {
    repository: new RenderRepository({ client } as unknown as PrismaService) as RetryRenderRepository,
    calls,
  };
}

test("createQueuedRender returns the existing request before validating current state", async () => {
  const existing = render();
  const fake = createRepository({
    existing,
    episode: { id: EPISODE_ID, status: RovelleEpisodeStatus.CANCELLED },
  });

  assert.deepEqual(await fake.repository.createQueuedRender(input()), {
    status: "existing",
    render: existing,
  });
  assert.equal(callsFor(fake.calls, "episode.findUnique").length, 0);
  assert.deepEqual(callsFor(fake.calls, "$transaction")[0], {
    operation: "$transaction",
    args: { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    inTransaction: false,
  });
});

test("createQueuedRender distinguishes missing, invalid, and empty episode sources", async () => {
  const cases: Array<{
    options: FakeOptions;
    expected: "episode_not_found" | "invalid_episode_state" | "no_shots";
  }> = [
    { options: { episode: null }, expected: "episode_not_found" },
    {
      options: { episode: { id: EPISODE_ID, status: RovelleEpisodeStatus.RENDERING } },
      expected: "invalid_episode_state",
    },
    { options: { shots: [] }, expected: "no_shots" },
  ];

  for (const { options, expected } of cases) {
    const fake = createRepository(options);
    assert.deepEqual(await fake.repository.createQueuedRender(input()), {
      status: expected,
    });
    assert.equal(callsFor(fake.calls, "asset.create").length, 0);
  }
});

test("createQueuedRender rejects every non-authoritative approved shot source", async () => {
  const invalidCases: Array<{
    source: ShotSource;
    expected: "shot_not_approved" | "approved_generation_invalid";
  }> = [
    { source: shot({ status: RovelleShotStatus.REVIEW_REQUIRED }), expected: "shot_not_approved" },
    { source: shot({ approvedGenerationId: null }), expected: "approved_generation_invalid" },
    { source: shot({ approvedGeneration: null }), expected: "approved_generation_invalid" },
    {
      source: shot({ approvedGeneration: approvedGeneration({ shotId: "d23e4567-e89b-42d3-a456-426614174000" }) }),
      expected: "approved_generation_invalid",
    },
    {
      source: shot({ approvedGeneration: approvedGeneration({ status: RovelleGenerationStatus.PROCESSING }) }),
      expected: "approved_generation_invalid",
    },
    {
      source: shot({ approvedGeneration: approvedGeneration({ outputAsset: asset({ status: RovelleAssetStatus.RESERVED }) }) }),
      expected: "approved_generation_invalid",
    },
    {
      source: shot({ approvedGeneration: approvedGeneration({ outputAsset: asset({ assetType: RovelleAssetType.AUDIO_MASTER }) }) }),
      expected: "approved_generation_invalid",
    },
    {
      source: shot({ approvedGeneration: approvedGeneration({ outputAsset: asset({ mediaType: "image/png" }) }) }),
      expected: "approved_generation_invalid",
    },
    {
      source: shot({ approvedGeneration: approvedGeneration({ outputAsset: asset({ episodeId: "e23e4567-e89b-42d3-a456-426614174000" }) }) }),
      expected: "approved_generation_invalid",
    },
  ];

  for (const { source, expected } of invalidCases) {
    const fake = createRepository({ shots: [source] });
    assert.deepEqual(await fake.repository.createQueuedRender(input()), {
      status: expected,
      ...(expected === "shot_not_approved" ? { shotId: SHOT_ID } : { shotId: SHOT_ID }),
    });
    assert.equal(callsFor(fake.calls, "asset.create").length, 0);
  }
});

test("createQueuedRender validates audio and optional captions from the episode", async () => {
  const audioCases = [
    audio({ episodeId: null }),
    audio({ status: RovelleAssetStatus.RESERVED }),
    audio({ assetType: RovelleAssetType.GENERATION }),
    audio({ mediaType: "video/mp4" }),
    audio({ byteSize: null }),
  ];
  for (const invalidAudio of audioCases) {
    const fake = createRepository({ audio: invalidAudio });
    assert.deepEqual(await fake.repository.createQueuedRender(input()), { status: "audio_invalid" });
  }

  const captionCases = [
    caption({ episodeId: null }),
    caption({ status: RovelleAssetStatus.RESERVED }),
    caption({ assetType: RovelleAssetType.GENERATION }),
    caption({ mediaType: "text/plain" }),
    caption({ byteSize: null }),
  ];
  for (const invalidCaption of captionCases) {
    const fake = createRepository({ caption: invalidCaption });
    assert.deepEqual(await fake.repository.createQueuedRender(input()), { status: "caption_invalid" });
  }

  const fake = createRepository({ audio: audio({ etag: null }) });
  assert.equal((await fake.repository.createQueuedRender(input({ captionAssetId: null }))).status, "created");
});

test("createQueuedRender rejects unsafe source metadata before creating queue records", async () => {
  const cases: Array<{
    options: FakeOptions;
    expected:
      | "approved_generation_invalid"
      | "audio_invalid"
      | "caption_invalid";
  }> = [
    {
      options: {
        shots: [
          shot({
            approvedGeneration: approvedGeneration({
              outputAsset: asset({ etag: "https://signed.example/video?token=private" }),
            }),
          }),
        ],
      },
      expected: "approved_generation_invalid",
    },
    {
      options: {
        shots: [
          shot({
            approvedGeneration: approvedGeneration({
              outputAsset: asset({ mediaType: "video/https://private" }),
            }),
          }),
        ],
      },
      expected: "approved_generation_invalid",
    },
    { options: { audio: audio({ etag: "secret-token" }) }, expected: "audio_invalid" },
    { options: { audio: audio({ mediaType: "audio/https://private" }) }, expected: "audio_invalid" },
    { options: { caption: caption({ etag: "authorization=private" }) }, expected: "caption_invalid" },
  ];

  for (const { options, expected } of cases) {
    const fake = createRepository(options);
    assert.equal((await fake.repository.createQueuedRender(input())).status, expected);
    assert.equal(callsFor(fake.calls, "asset.create").length, 0);
    assert.equal(callsFor(fake.calls, "render.create").length, 0);
    assert.equal(callsFor(fake.calls, "job.create").length, 0);
  }
});

test("createQueuedRender atomically reserves output, creates queue work, and transitions the episode", async () => {
  const fake = createRepository({ latestAttempt: 4 });

  const result = await fake.repository.createQueuedRender(input({ captionAssetId: null }));

  assert.deepEqual(result, { status: "created", render: render() });
  assert.deepEqual(fake.committedWrites, ["asset", "render", "job", "episode"]);
  assert.deepEqual(fake.rolledBackWrites, []);
  assert.deepEqual(callsFor(fake.calls, "shot.findMany")[0], {
    operation: "shot.findMany",
    args: {
      where: { episodeId: EPISODE_ID },
      orderBy: { sequence: "asc" },
      include: { approvedGeneration: { include: { outputAsset: true } } },
    },
    inTransaction: true,
  });
  assert.deepEqual(callsFor(fake.calls, "render.aggregate")[0], {
    operation: "render.aggregate",
    args: { where: { episodeId: EPISODE_ID }, _max: { attempt: true } },
    inTransaction: true,
  });
  assert.deepEqual(callsFor(fake.calls, "asset.create")[0], {
    operation: "asset.create",
    args: {
      data: {
        id: OUTPUT_ID,
        episodeId: EPISODE_ID,
        assetType: RovelleAssetType.RENDER,
        status: RovelleAssetStatus.RESERVED,
        mediaType: "video/mp4",
        storageKey: "rovelle/private/render.mp4",
        originalFilename: null,
      },
    },
    inTransaction: true,
  });
  const renderCreate = callsFor(fake.calls, "render.create")[0];
  const renderData = (renderCreate?.args as { data: Record<string, unknown> }).data;
  assert.equal(renderData.clientRequestId, REQUEST_ID);
  assert.equal(renderData.episodeId, EPISODE_ID);
  assert.equal(renderData.attempt, 5);
  assert.equal(renderData.status, RovelleRenderStatus.QUEUED);
  assert.equal(renderData.outputAssetId, OUTPUT_ID);
  assert.equal(renderData.specVersion, 1);
  assert.match(renderData.specHash as string, /^[a-f0-9]{64}$/);
  assert.deepEqual(renderData.spec, {
    version: 1,
    profile: "VERTICAL_SHORT_V1",
    output: {
      container: "mp4",
      width: 1080,
      height: 1920,
      frameRate: 30,
      videoCodec: "libx264",
      pixelFormat: "yuv420p",
      audioCodec: "aac",
      audioSampleRate: 48000,
    },
    shots: [
      {
        sequence: 1,
        shotId: SHOT_ID,
        generationId: GENERATION_ID,
        targetDurationSeconds: 5,
        video: {
          assetId: "923e4567-e89b-42d3-a456-426614174000",
          mediaType: "video/mp4",
          byteSize: "42",
          etag: null,
        },
      },
    ],
    audio: {
      assetId: AUDIO_ID,
      mediaType: "audio/mpeg",
      byteSize: "128",
      etag: null,
    },
    captions: null,
  });
  assert.equal(hasUnsafeSpecValue(renderData.spec), false);
  const jobCreate = callsFor(fake.calls, "job.create")[0];
  const jobData = (jobCreate?.args as { data: Record<string, unknown> }).data;
  assert.deepEqual(
    { clientRequestId: jobData.clientRequestId, renderId: jobData.renderId, attempt: jobData.attempt, status: jobData.status },
    { clientRequestId: REQUEST_ID, renderId: RENDER_ID, attempt: 1, status: RovelleRenderJobStatus.QUEUED },
  );
  assert.ok(jobData.availableAt instanceof Date);
  assert.deepEqual(callsFor(fake.calls, "episode.updateMany")[0], {
    operation: "episode.updateMany",
    args: {
      where: { id: EPISODE_ID, status: RovelleEpisodeStatus.GENERATION_APPROVED },
      data: { status: RovelleEpisodeStatus.RENDERING },
    },
    inTransaction: true,
  });
});

test("createQueuedRender rolls every staged write back when the episode transition loses its race", async () => {
  const fake = createRepository({ episodeUpdateCounts: [0] });

  assert.deepEqual(await fake.repository.createQueuedRender(input()), {
    status: "invalid_episode_state",
  });
  assert.deepEqual(fake.committedWrites, []);
  assert.deepEqual(fake.rolledBackWrites, ["asset", "render", "job", "episode"]);
});

test("createQueuedRender returns an existing request after a client request uniqueness race", async () => {
  const existing = render();
  const fake = createRepository({
    createError: { code: "P2002" },
    raceExisting: existing,
  });

  assert.deepEqual(await fake.repository.createQueuedRender(input()), {
    status: "existing",
    render: existing,
  });
  assert.equal(fake.transactionCount, 1);
  assert.equal(callsFor(fake.calls, "client.render.findUnique").length, 1);
});

test("createQueuedRender retries serializable aborts but surfaces a different attempt conflict", async () => {
  const serializable = { code: "P2034" };
  const retried = createRepository({ transactionErrors: [serializable] });
  assert.equal((await retried.repository.createQueuedRender(input())).status, "created");
  assert.equal(retried.transactionCount, 2);

  const conflict = { code: "P2002" };
  const fake = createRepository({ createError: conflict, raceExisting: null });
  await assert.rejects(fake.repository.createQueuedRender(input()), (error: unknown) => error === conflict);
  assert.equal(fake.transactionCount, 1);
});

test("findRender and listEpisodeRenders load the output and ordered jobs", async () => {
  const current = render();
  const fake = createRepository({ findRender: current, listRenders: [current] });

  assert.equal(await fake.repository.findRender(RENDER_ID), current);
  assert.deepEqual(await fake.repository.listEpisodeRenders(EPISODE_ID), [current]);
  assert.deepEqual(callsFor(fake.calls, "client.render.findUnique")[0], {
    operation: "client.render.findUnique",
    args: { where: { id: RENDER_ID }, include: fake.include },
    inTransaction: false,
  });
  assert.deepEqual(callsFor(fake.calls, "client.render.findMany")[0], {
    operation: "client.render.findMany",
    args: {
      where: { episodeId: EPISODE_ID },
      orderBy: { attempt: "desc" },
      include: fake.include,
    },
    inTransaction: false,
  });
});

test("retryRender returns the prior retry for the same render without a second job", async () => {
  const current = failedRender();
  const request = retryInput();
  const existingJob = Object.assign(
    renderJob({ clientRequestId: request.clientRequestId, renderId: RENDER_ID }),
    { render: current },
  );
  const fake = createRetryRepository({ render: current, requestJob: existingJob });

  assert.deepEqual(await fake.repository.retryRender(request), {
    status: "existing",
    render: current,
  });
  assert.equal(callsFor(fake.calls, "retry.render.findUnique").length, 0);
  assert.equal(callsFor(fake.calls, "retry.job.create").length, 0);
});

test("retryRender rejects a retry request already owned by another render", async () => {
  const request = retryInput();
  const other = render({ id: "a23e4567-e89b-42d3-a456-426614174002" });
  const existingJob = Object.assign(
    renderJob({ clientRequestId: request.clientRequestId, renderId: other.id }),
    { render: other },
  );
  const fake = createRetryRepository({ requestJob: existingJob });

  assert.deepEqual(await fake.repository.retryRender(request), {
    status: "request_conflict",
  });
  assert.equal(callsFor(fake.calls, "retry.job.create").length, 0);
});

test("retryRender rejects every independently invalid retry gate", async () => {
  const activeJob = renderJob({ status: RovelleRenderJobStatus.RUNNING });
  const cases: Array<{
    options: RetryOptions;
    expected: string;
  }> = [
    { options: { render: null }, expected: "not_found" },
    {
      options: { render: failedRender({ status: RovelleRenderStatus.QUEUED }) },
      expected: "invalid_render_state",
    },
    {
      options: { render: failedRender({ status: RovelleRenderStatus.RUNNING }) },
      expected: "invalid_render_state",
    },
    {
      options: { render: failedRender({ status: RovelleRenderStatus.COMPLETED }) },
      expected: "invalid_render_state",
    },
    {
      options: { episode: { id: EPISODE_ID, status: RovelleEpisodeStatus.FINAL_REVIEW } },
      expected: "invalid_episode_state",
    },
    {
      options: { episode: { id: EPISODE_ID, status: RovelleEpisodeStatus.PUBLISH_READY } },
      expected: "invalid_episode_state",
    },
    {
      options: {
        render: failedRender({
          outputAsset: asset({ id: OUTPUT_ID, status: RovelleAssetStatus.AVAILABLE }),
        }),
      },
      expected: "output_not_retryable",
    },
    {
      options: {
        render: failedRender({
          outputAsset: asset({
            id: "a23e4567-e89b-42d3-a456-426614174003",
            status: RovelleAssetStatus.RESERVED,
          }),
        }),
      },
      expected: "output_not_retryable",
    },
    {
      options: { render: failedRender({ jobs: [activeJob] }) },
      expected: "active_job_exists",
    },
    {
      options: {
        render: failedRender({
          jobs: [renderJob({ status: RovelleRenderJobStatus.QUEUED })],
        }),
      },
      expected: "active_job_exists",
    },
  ];

  for (const { options, expected } of cases) {
    const fake = createRetryRepository(options);
    assert.deepEqual(await fake.repository.retryRender(retryInput()), { status: expected });
    assert.equal(callsFor(fake.calls, "retry.job.create").length, 0);
  }
});

test("retryRender appends a clean next job and preserves the failed render history", async () => {
  const current = failedRender({
    profile: RovelleRenderProfile.VERTICAL_SHORT_V1,
    spec: { stable: true },
    specHash: "b".repeat(64),
  });
  const oldJob = current.jobs[0];
  const fake = createRetryRepository({ render: current, latestJobAttempt: 4 });

  const result = await fake.repository.retryRender(retryInput());

  assert.equal(result.status, "queued");
  assert.equal(current.status, RovelleRenderStatus.FAILED);
  assert.equal(current.profile, RovelleRenderProfile.VERTICAL_SHORT_V1);
  assert.deepEqual(current.spec, { stable: true });
  assert.equal(current.specHash, "b".repeat(64));
  assert.equal(current.outputAssetId, OUTPUT_ID);
  assert.equal(current.episodeId, EPISODE_ID);
  assert.deepEqual(current.jobs, [oldJob]);
  assert.equal(oldJob.status, RovelleRenderJobStatus.FAILED);
  assert.equal(oldJob.workerId, "render-worker");
  assert.equal(oldJob.errorCode, "RENDER_FAILED");
  assert.equal(oldJob.errorMessage, "encoder stopped");
  assert.ok(oldJob.startedAt);
  assert.ok(oldJob.finishedAt);
  assert.deepEqual(callsFor(fake.calls, "retry.job.aggregate")[0], {
    operation: "retry.job.aggregate",
    args: { where: { renderId: RENDER_ID }, _max: { attempt: true } },
    inTransaction: true,
  });
  const jobData = (callsFor(fake.calls, "retry.job.create")[0]?.args as {
    data: Record<string, unknown>;
  }).data;
  assert.deepEqual(jobData, {
    clientRequestId: retryInput().clientRequestId,
    renderId: RENDER_ID,
    attempt: 5,
    status: RovelleRenderJobStatus.QUEUED,
    availableAt: jobData.availableAt,
    workerId: null,
    leaseToken: null,
    claimedAt: null,
    heartbeatAt: null,
    leaseExpiresAt: null,
    startedAt: null,
    finishedAt: null,
    errorCode: null,
    errorMessage: null,
  });
  assert.ok(jobData.availableAt instanceof Date);
  assert.deepEqual(callsFor(fake.calls, "retry.render.updateMany")[0], {
    operation: "retry.render.updateMany",
    args: {
      where: { id: RENDER_ID, status: RovelleRenderStatus.FAILED },
      data: { status: RovelleRenderStatus.QUEUED },
    },
    inTransaction: true,
  });
  assert.deepEqual(callsFor(fake.calls, "retry.$transaction")[0], {
    operation: "retry.$transaction",
    args: { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    inTransaction: false,
  });
});

test("retryRender serializes competing retry requests so the loser observes the queued render", async () => {
  const queued = render({
    status: RovelleRenderStatus.QUEUED,
    outputAsset: asset({ id: OUTPUT_ID, assetType: RovelleAssetType.RENDER, status: RovelleAssetStatus.RESERVED }),
    jobs: [renderJob({ status: RovelleRenderJobStatus.QUEUED })],
  });
  const fake = createRetryRepository({
    transactionErrors: [{ code: "P2034" }],
    afterSerialization: queued,
  });

  assert.deepEqual(
    await fake.repository.retryRender(retryInput({ clientRequestId: "a23e4567-e89b-42d3-a456-426614174004" })),
    { status: "invalid_render_state" },
  );
  assert.equal(callsFor(fake.calls, "retry.$transaction").length, 2);
  assert.equal(callsFor(fake.calls, "retry.job.create").length, 0);
});
