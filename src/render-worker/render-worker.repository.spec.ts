import * as assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, describe, test } from "node:test";
import {
  Prisma,
  RovelleAssetStatus,
  RovelleAssetType,
  RovelleEpisodeStatus,
  RovelleRenderJobStatus,
  RovelleRenderProfile,
  RovelleRenderStatus,
} from "../generated/prisma/client";
import { PrismaService } from "../database/prisma.service";
import { type RenderSpecV1 } from "../rovelle/render/render-spec";
import { RenderWorkerRepository } from "./render-worker.repository";

const EPISODE_ID = "550e8400-e29b-41d4-a716-446655440000";
const RENDER_ID = "650e8400-e29b-41d4-a716-446655440000";
const JOB_ID = "750e8400-e29b-41d4-a716-446655440000";
const OUTPUT_ID = "850e8400-e29b-41d4-a716-446655440000";
const LEASE_TOKEN = "950e8400-e29b-41d4-a716-446655440000";

const renderSpec: RenderSpecV1 = {
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
  shots: [],
  audio: { assetId: "a50e8400-e29b-41d4-a716-446655440000", mediaType: "audio/mpeg", byteSize: "10", etag: null },
  captions: null,
};

type Call = { operation: string; args: unknown };

type FakeOptions = {
  candidate?: { id: string; renderId: string } | null;
  claimedRender?: {
    id: string;
    episodeId: string;
    spec: RenderSpecV1;
    specHash: string;
    outputAsset: { id: string; storageKey: string; status: RovelleAssetStatus; mediaType: string };
  } | null;
  rawCounts?: number[];
  renderUpdateCounts?: number[];
  assetUpdateCounts?: number[];
};

function queryText(query: unknown): string {
  if (typeof query !== "object" || query === null || !("strings" in query)) return "";
  const strings = (query as { strings: readonly string[] }).strings;
  return strings.join("?");
}

function createRepository(options: FakeOptions = {}) {
  const calls: Call[] = [];
  const rawCounts = [...(options.rawCounts ?? [])];
  const renderUpdateCounts = [...(options.renderUpdateCounts ?? [])];
  const assetUpdateCounts = [...(options.assetUpdateCounts ?? [])];
  const claimedRender = options.claimedRender === undefined
    ? {
        id: RENDER_ID,
        episodeId: EPISODE_ID,
        spec: renderSpec,
        specHash: "a".repeat(64),
        outputAsset: {
          id: OUTPUT_ID,
          storageKey: "rovelle/private/output.mp4",
          status: RovelleAssetStatus.RESERVED,
          mediaType: "video/mp4",
        },
      }
    : options.claimedRender;
  const candidate = options.candidate === undefined ? { id: JOB_ID, renderId: RENDER_ID } : options.candidate;

  const record = (operation: string, args: unknown) => calls.push({ operation, args });
  const tx = {
    $queryRaw: async (query: unknown) => {
      record("$queryRaw", query);
      const sql = queryText(query);
      if (sql.includes("FOR UPDATE SKIP LOCKED")) return candidate ? [candidate] : [];
      if (sql.includes("WITH expired_jobs")) {
        return [{ count: rawCounts.shift() ?? 1 }];
      }
      if (sql.includes("RETURNING render_id::text")) {
        return rawCounts.shift() === 0 ? [] : [{ renderId: RENDER_ID }];
      }
      return Array.from({ length: rawCounts.shift() ?? 1 }, () => ({ id: RENDER_ID }));
    },
    $executeRaw: async (query: unknown) => {
      record("$executeRaw", query);
      return rawCounts.shift() ?? 1;
    },
    rovelleRender: {
      updateMany: async (args: unknown) => {
        record("render.updateMany", args);
        return { count: renderUpdateCounts.shift() ?? 1 };
      },
      findUnique: async (args: unknown) => {
        record("render.findUnique", args);
        if (
          typeof args === "object" &&
          args !== null &&
          "select" in args &&
          typeof args.select === "object" &&
          args.select !== null &&
          "outputAssetId" in args.select
        ) {
          return { id: RENDER_ID, episodeId: EPISODE_ID, outputAssetId: OUTPUT_ID };
        }
        return claimedRender;
      },
    },
    rovelleAsset: {
      updateMany: async (args: unknown) => {
        record("asset.updateMany", args);
        return { count: assetUpdateCounts.shift() ?? 1 };
      },
    },
    rovelleEpisode: {
      updateMany: async (args: unknown) => {
        record("episode.updateMany", args);
        return { count: 1 };
      },
    },
  };
  const client = {
    $transaction: async (callback: (transaction: typeof tx) => Promise<unknown>) => {
      record("$transaction", undefined);
      return callback(tx);
    },
    $executeRaw: tx.$executeRaw,
  };

  return {
    calls,
    repository: new RenderWorkerRepository({ client } as unknown as PrismaService),
  };
}

function callsFor(calls: Call[], operation: string): Call[] {
  return calls.filter((call) => call.operation === operation);
}

test("claimNext locks the earliest available queued job with SKIP LOCKED", async () => {
  const fake = createRepository();

  const claimed = await fake.repository.claimNext({ workerId: "worker-a", leaseSeconds: 120 });

  assert.equal(claimed?.jobId, JOB_ID);
  assert.equal(claimed?.renderId, RENDER_ID);
  assert.equal(claimed?.episodeId, EPISODE_ID);
  assert.match(claimed?.leaseToken ?? "", /^[0-9a-f-]{36}$/);
  assert.equal(claimed?.workerId, "worker-a");
  assert.deepEqual(claimed?.renderSpec, renderSpec);
  assert.deepEqual(claimed?.outputAsset, {
    id: OUTPUT_ID,
    storageKey: "rovelle/private/output.mp4",
    status: RovelleAssetStatus.RESERVED,
    mediaType: "video/mp4",
  });

  const claimSql = queryText(callsFor(fake.calls, "$queryRaw")[0]?.args);
  assert.match(claimSql, /FROM "rovelle_render_jobs"/);
  assert.match(claimSql, /status = 'QUEUED'/);
  assert.match(claimSql, /available_at <= now\(\)/);
  assert.match(claimSql, /ORDER BY available_at ASC, created_at ASC/);
  assert.match(claimSql, /FOR UPDATE SKIP LOCKED/);
  assert.match(claimSql, /LIMIT 1/);
  assert.match(queryText(callsFor(fake.calls, "$executeRaw")[0]?.args), /lease_expires_at = now\(\) \+ \?::integer \* interval '1 second'/);
  assert.deepEqual(callsFor(fake.calls, "render.updateMany")[0]?.args, {
    where: { id: RENDER_ID, status: RovelleRenderStatus.QUEUED },
    data: { status: RovelleRenderStatus.RUNNING },
  });
});

test("claimNext returns null when no queued job is available", async () => {
  const fake = createRepository({ candidate: null });

  assert.equal(await fake.repository.claimNext({ workerId: "worker-a", leaseSeconds: 120 }), null);
  assert.equal(callsFor(fake.calls, "$executeRaw").length, 0);
});

test("heartbeat extends only an active matching lease", async () => {
  const fake = createRepository();

  assert.equal(
    await fake.repository.heartbeat({ jobId: JOB_ID, leaseToken: LEASE_TOKEN, leaseSeconds: 120 }),
    true,
  );

  const sql = queryText(callsFor(fake.calls, "$executeRaw")[0]?.args);
  assert.match(sql, /status = 'RUNNING'/);
  assert.match(sql, /lease_token = \?::uuid/);
  assert.match(sql, /lease_expires_at > now\(\)/);
  assert.match(sql, /heartbeat_at = now\(\)/);
});

test("heartbeat reports a lost or expired lease", async () => {
  const fake = createRepository({ rawCounts: [0] });

  assert.equal(
    await fake.repository.heartbeat({ jobId: JOB_ID, leaseToken: LEASE_TOKEN, leaseSeconds: 120 }),
    false,
  );
});

test("recoverExpiredLeases fails expired jobs and their running renders without changing episodes", async () => {
  const fake = createRepository({ rawCounts: [2] });

  assert.equal(await fake.repository.recoverExpiredLeases(), 2);

  const sql = queryText(callsFor(fake.calls, "$queryRaw")[0]?.args);
  assert.match(sql, /status = 'RUNNING'/);
  assert.match(sql, /lease_expires_at < now\(\)/);
  assert.match(sql, /WORKER_LEASE_EXPIRED/);
  assert.match(sql, /UPDATE "rovelle_renders" render/);
  assert.equal(callsFor(fake.calls, "render.updateMany").length, 0);
  assert.equal(callsFor(fake.calls, "episode.updateMany").length, 0);
  assert.equal(callsFor(fake.calls, "asset.updateMany").length, 0);
});

test("completeJob publishes the reserved output and advances only a rendering episode", async () => {
  const fake = createRepository();

  assert.equal(
    await fake.repository.completeJob({ jobId: JOB_ID, leaseToken: LEASE_TOKEN, byteSize: 123n, etag: "etag-123" }),
    "completed",
  );

  assert.deepEqual(callsFor(fake.calls, "asset.updateMany")[0]?.args, {
    where: { id: OUTPUT_ID, status: RovelleAssetStatus.RESERVED },
    data: { status: RovelleAssetStatus.AVAILABLE, byteSize: 123n, etag: "etag-123" },
  });
  const completedRender = callsFor(fake.calls, "render.updateMany")[0]?.args as {
    where: unknown;
    data: { status: unknown; completedAt: unknown };
  };
  assert.deepEqual(completedRender.where, { id: RENDER_ID, status: RovelleRenderStatus.RUNNING });
  assert.equal(completedRender.data.status, RovelleRenderStatus.COMPLETED);
  assert.ok(completedRender.data.completedAt instanceof Date);
  assert.deepEqual(callsFor(fake.calls, "episode.updateMany")[0]?.args, {
    where: { id: EPISODE_ID, status: RovelleEpisodeStatus.RENDERING },
    data: { status: RovelleEpisodeStatus.FINAL_REVIEW },
  });
});

test("completeJob does not mutate assets, renders, or episodes after lease loss", async () => {
  const fake = createRepository({ rawCounts: [0] });

  assert.equal(
    await fake.repository.completeJob({ jobId: JOB_ID, leaseToken: LEASE_TOKEN, byteSize: 123n, etag: null }),
    "lease_lost",
  );
  assert.equal(callsFor(fake.calls, "asset.updateMany").length, 0);
  assert.equal(callsFor(fake.calls, "render.updateMany").length, 0);
  assert.equal(callsFor(fake.calls, "episode.updateMany").length, 0);
});

test("failJob keeps the reserved output and sanitizes persisted errors", async () => {
  const fake = createRepository();

  assert.equal(
    await fake.repository.failJob({
      jobId: JOB_ID,
      leaseToken: LEASE_TOKEN,
      errorCode: `  ${"x".repeat(130)}  `,
      errorMessage: `  ${"m".repeat(4010)}  `,
    }),
    "failed",
  );

  const sql = queryText(callsFor(fake.calls, "$queryRaw")[0]?.args);
  assert.match(sql, /error_code = \?/);
  assert.match(sql, /error_message = \?/);
  assert.match(sql, /status = 'RUNNING'/);
  assert.match(sql, /lease_token = \?::uuid/);
  assert.match(sql, /lease_expires_at > now\(\)/);
  const persistedError = callsFor(fake.calls, "$queryRaw")[0]?.args as { values: unknown[] };
  assert.ok(persistedError.values.includes("x".repeat(120)));
  assert.ok(persistedError.values.includes("m".repeat(4000)));
  assert.equal(callsFor(fake.calls, "asset.updateMany").length, 0);
  assert.equal(callsFor(fake.calls, "episode.updateMany").length, 0);
  assert.deepEqual(callsFor(fake.calls, "render.updateMany")[0]?.args, {
    where: { id: RENDER_ID, status: RovelleRenderStatus.RUNNING },
    data: { status: RovelleRenderStatus.FAILED },
  });
});

test("failJob defaults blank errors and does not mutate after lease loss", async () => {
  const failed = createRepository();
  assert.equal(
    await failed.repository.failJob({ jobId: JOB_ID, leaseToken: LEASE_TOKEN, errorCode: "  ", errorMessage: "\n" }),
    "failed",
  );
  const fallbackSql = callsFor(failed.calls, "$queryRaw")[0]?.args as { values: unknown[] };
  assert.ok(fallbackSql.values.includes("RENDER_WORKER_FAILED"));
  assert.ok(fallbackSql.values.includes("Render worker failed"));

  const lost = createRepository({ rawCounts: [0] });
  assert.equal(
    await lost.repository.failJob({ jobId: JOB_ID, leaseToken: LEASE_TOKEN, errorCode: "FFMPEG", errorMessage: "failed" }),
    "lease_lost",
  );
  assert.equal(callsFor(lost.calls, "render.updateMany").length, 0);
});

const testDatabaseUrl = process.env.ROVELLE_TEST_DATABASE_URL;
const originalDatabaseUrl = process.env.DATABASE_URL;

describe("RenderWorkerRepository PostgreSQL lease claiming", { skip: !testDatabaseUrl }, () => {
  let prisma: PrismaService | undefined;
  let repository: RenderWorkerRepository;
  const episodeIds: string[] = [];

  after(async () => {
    if (prisma) {
      await prisma.client.rovelleRenderJob.deleteMany({ where: { render: { episodeId: { in: episodeIds } } } });
      await prisma.client.rovelleRender.deleteMany({ where: { episodeId: { in: episodeIds } } });
      await prisma.client.rovelleAsset.deleteMany({ where: { episodeId: { in: episodeIds } } });
      await prisma.client.rovelleEpisode.deleteMany({ where: { id: { in: episodeIds } } });
      await prisma.onModuleDestroy();
    }
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
  });

  async function createQueuedJob(code: string) {
    if (!prisma) {
      process.env.DATABASE_URL = testDatabaseUrl;
      prisma = new PrismaService();
      repository = new RenderWorkerRepository(prisma);
    }
    const episode = await prisma.client.rovelleEpisode.create({
      data: { code, title: "Render worker lease test", status: RovelleEpisodeStatus.RENDERING },
    });
    episodeIds.push(episode.id);
    const output = await prisma.client.rovelleAsset.create({
      data: {
        episodeId: episode.id,
        assetType: RovelleAssetType.RENDER,
        status: RovelleAssetStatus.RESERVED,
        mediaType: "video/mp4",
        storageKey: `rovelle/private/${episode.id}.mp4`,
        originalFilename: null,
      },
    });
    const render = await prisma.client.rovelleRender.create({
      data: {
        clientRequestId: randomUUID(),
        episodeId: episode.id,
        attempt: 1,
        profile: RovelleRenderProfile.VERTICAL_SHORT_V1,
        status: RovelleRenderStatus.QUEUED,
        specVersion: 1,
        spec: renderSpec as unknown as Prisma.InputJsonValue,
        specHash: "b".repeat(64),
        outputAssetId: output.id,
      },
    });
    return prisma.client.rovelleRenderJob.create({
      data: { clientRequestId: randomUUID(), renderId: render.id, attempt: 1, status: RovelleRenderJobStatus.QUEUED },
    });
  }

  test("two workers claim different jobs and one job only once", async () => {
    await createQueuedJob(`LEASE-A-${randomUUID().replaceAll("-", "").slice(0, 24)}`);
    await createQueuedJob(`LEASE-B-${randomUUID().replaceAll("-", "").slice(0, 24)}`);
    const [first, second] = await Promise.all([
      repository.claimNext({ workerId: "worker-one", leaseSeconds: 120 }),
      repository.claimNext({ workerId: "worker-two", leaseSeconds: 120 }),
    ]);
    assert.ok(first && second);
    assert.notEqual(first.jobId, second.jobId);

    await createQueuedJob(`LEASE-C-${randomUUID().replaceAll("-", "").slice(0, 24)}`);
    const [third, fourth] = await Promise.all([
      repository.claimNext({ workerId: "worker-three", leaseSeconds: 120 }),
      repository.claimNext({ workerId: "worker-four", leaseSeconds: 120 }),
    ]);
    assert.ok(third);
    assert.equal(fourth, null);
  });
});
