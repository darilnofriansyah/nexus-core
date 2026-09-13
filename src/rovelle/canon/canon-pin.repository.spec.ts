import * as assert from "node:assert/strict";
import { test } from "node:test";
import { PrismaService } from "../../database/prisma.service";
import {
  Prisma,
  RovelleAssetStatus,
  RovelleAssetType,
  RovelleCanonEntityType,
  RovelleCanonVersionStatus,
  RovelleEpisodeStatus,
  RovelleShotStatus,
  type RovelleAsset,
  type RovelleCanonEntity,
  type RovelleCanonVersion,
  type RovelleEpisode,
  type RovelleEpisodeCanonPin,
  type RovelleShot,
  type RovelleShotCanonPin,
} from "../../generated/prisma/client";
import {
  CanonPinRepository,
  type CanonPinWithVersion,
} from "./canon-pin.repository";

type RepositoryCall = {
  operation: string;
  args: unknown;
  inTransaction: boolean;
};

type FakeOptions = {
  episode?: RovelleEpisode | null;
  shot?: (RovelleShot & { episode: Pick<RovelleEpisode, "status"> }) | null;
  version?: (RovelleCanonVersion & { entity: RovelleCanonEntity }) | null;
  episodePin?: RovelleEpisodeCanonPin;
  shotPin?: RovelleShotCanonPin;
  effectiveShot?: EffectiveShotPins | null;
};

const EPISODE_ID = "550e8400-e29b-41d4-a716-446655440000";
const SHOT_ID = "123e4567-e89b-42d3-a456-426614174000";
const ENTITY_ID = "223e4567-e89b-42d3-a456-426614174000";
const VERSION_ID = "323e4567-e89b-42d3-a456-426614174000";
const OTHER_ENTITY_ID = "423e4567-e89b-42d3-a456-426614174000";

const createdAt = new Date("2026-08-27T00:00:00.000Z");
const updatedAt = new Date("2026-08-27T00:01:00.000Z");

const episode: RovelleEpisode = {
  id: EPISODE_ID,
  code: "EP-001",
  title: "Berry Count",
  status: RovelleEpisodeStatus.PREPRODUCTION,
  brief: null,
  targetDurationSeconds: 60,
  generationBudgetUsd: null,
  approvedRenderId: null,
  createdAt,
  updatedAt,
};

const shot: RovelleShot & { episode: Pick<RovelleEpisode, "status"> } = {
  id: SHOT_ID,
  episodeId: EPISODE_ID,
  sequence: 1,
  name: "Opening",
  direction: "Open on the basket.",
  targetDurationSeconds: 10,
  status: RovelleShotStatus.DRAFT,
  approvedGenerationId: null,
  episode: { status: episode.status },
  createdAt,
  updatedAt,
};

const entity: RovelleCanonEntity = {
  id: ENTITY_ID,
  code: "KOKO",
  displayName: "Koko",
  entityType: RovelleCanonEntityType.CHARACTER,
  description: null,
  createdAt,
  updatedAt,
};

const version: RovelleCanonVersion & { entity: RovelleCanonEntity } = {
  id: VERSION_ID,
  entityId: ENTITY_ID,
  version: 1,
  status: RovelleCanonVersionStatus.LOCKED,
  definition: { appearance: { color: "yellow" } },
  lockedAt: createdAt,
  entity,
  createdAt,
  updatedAt,
};

const episodePin: RovelleEpisodeCanonPin = {
  episodeId: EPISODE_ID,
  canonEntityId: ENTITY_ID,
  canonVersionId: VERSION_ID,
  createdAt,
  updatedAt,
};

const shotPin: RovelleShotCanonPin = {
  shotId: SHOT_ID,
  canonEntityId: ENTITY_ID,
  canonVersionId: VERSION_ID,
  createdAt,
  updatedAt,
};

type EffectiveShotPins = RovelleShot & {
  episode: RovelleEpisode & { canonPins: CanonPinWithVersion[] };
  canonPins: CanonPinWithVersion[];
};

const asset: RovelleAsset = {
  id: "523e4567-e89b-42d3-a456-426614174000",
  episodeId: null,
  assetType: RovelleAssetType.CHARACTER_REFERENCE,
  status: RovelleAssetStatus.AVAILABLE,
  mediaType: "image/png",
  storageKey: "rovelle/assets/koko.png",
  originalFilename: "koko.png",
  byteSize: 42n,
  etag: "etag-koko",
  createdAt,
  updatedAt,
};

const pinWithVersion: CanonPinWithVersion = {
  ...episodePin,
  canonVersion: {
    ...version,
    assets: [
      {
        canonVersionId: VERSION_ID,
        assetId: asset.id,
        role: "PORTRAIT",
        sortOrder: 0,
        createdAt,
        asset,
      },
    ],
  },
};

function createRepository(options: FakeOptions = {}) {
  const calls: RepositoryCall[] = [];
  let inTransaction = false;
  let transactionCount = 0;
  const record = (operation: string, args: unknown) => {
    calls.push({ operation, args, inTransaction });
  };

  const transactionClient = {
    rovelleEpisode: {
      findUnique: async (args: unknown) => {
        record("episode.findUnique", args);
        return options.episode === undefined ? episode : options.episode;
      },
    },
    rovelleShot: {
      findUnique: async (args: unknown) => {
        record("shot.findUnique", args);
        return options.shot === undefined ? shot : options.shot;
      },
    },
    rovelleCanonVersion: {
      findUnique: async (args: unknown) => {
        record("version.findUnique", args);
        return options.version === undefined ? version : options.version;
      },
    },
    rovelleEpisodeCanonPin: {
      findMany: async (args: unknown) => {
        record("episodePin.findMany", args);
        return [pinWithVersion];
      },
      upsert: async (args: unknown) => {
        record("episodePin.upsert", args);
        return options.episodePin ?? episodePin;
      },
      deleteMany: async (args: unknown) => {
        record("episodePin.deleteMany", args);
        return { count: 1 };
      },
    },
    rovelleShotCanonPin: {
      upsert: async (args: unknown) => {
        record("shotPin.upsert", args);
        return options.shotPin ?? shotPin;
      },
      deleteMany: async (args: unknown) => {
        record("shotPin.deleteMany", args);
        return { count: 1 };
      },
    },
  };

  const client = {
    ...transactionClient,
    rovelleEpisodeCanonPin: {
      ...transactionClient.rovelleEpisodeCanonPin,
      findMany: async (args: unknown) => {
        record("episodePin.findMany", args);
        return [pinWithVersion];
      },
    },
    rovelleShot: {
      ...transactionClient.rovelleShot,
      findUnique: async (args: unknown) => {
        record("shot.findUnique", args);
        return options.effectiveShot === undefined
          ? ({ ...shot, episode: { ...episode, canonPins: [pinWithVersion] }, canonPins: [pinWithVersion] } as EffectiveShotPins)
          : options.effectiveShot;
      },
    },
    $transaction: async <T>(
      callback: (transaction: typeof transactionClient) => Promise<T>,
      transactionOptions?: unknown,
    ): Promise<T> => {
      record("$transaction", transactionOptions);
      transactionCount += 1;
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
    transactionClient,
    repository: new CanonPinRepository({ client } as unknown as PrismaService),
    get transactionCount() {
      return transactionCount;
    },
  };
}

function callsFor(calls: RepositoryCall[], operation: string): RepositoryCall[] {
  return calls.filter((call) => call.operation === operation);
}

test("pins an episode to a locked version in a serializable transaction", async () => {
  const fake = createRepository();

  const result = await fake.repository.pinEpisodeVersion(
    EPISODE_ID,
    ENTITY_ID,
    VERSION_ID,
  );

  assert.deepEqual(result, { status: "pinned", pin: episodePin });
  assert.equal(fake.transactionCount, 1);
  assert.deepEqual(callsFor(fake.calls, "$transaction")[0], {
    operation: "$transaction",
    args: { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    inTransaction: false,
  });
  assert.deepEqual(callsFor(fake.calls, "episode.findUnique")[0], {
    operation: "episode.findUnique",
    args: { where: { id: EPISODE_ID } },
    inTransaction: true,
  });
  assert.deepEqual(callsFor(fake.calls, "version.findUnique")[0], {
    operation: "version.findUnique",
    args: { where: { id: VERSION_ID }, include: { entity: true } },
    inTransaction: true,
  });
  assert.deepEqual(callsFor(fake.calls, "episodePin.upsert")[0], {
    operation: "episodePin.upsert",
    args: {
      where: { episodeId_canonEntityId: { episodeId: EPISODE_ID, canonEntityId: ENTITY_ID } },
      update: { canonVersionId: VERSION_ID },
      create: { episodeId: EPISODE_ID, canonEntityId: ENTITY_ID, canonVersionId: VERSION_ID },
    },
    inTransaction: true,
  });
});

test("pins and reads episode canon inside a caller transaction without nesting", async () => {
  const fake = createRepository();
  const tx = fake.transactionClient as unknown as Prisma.TransactionClient;

  const result = await fake.repository.pinEpisodeVersion(EPISODE_ID, ENTITY_ID, VERSION_ID, tx);
  const pins = await fake.repository.listEpisodePins(EPISODE_ID, tx);

  assert.equal(result.status, "pinned");
  assert.deepEqual(pins, [pinWithVersion]);
  assert.equal(fake.transactionCount, 0);
});

test("rejects episode pins for missing, locked, draft, and mismatched entities", async () => {
  const cases = [
    { options: { episode: null }, expected: { status: "not_found" } },
    { options: { episode: { ...episode, status: RovelleEpisodeStatus.GENERATING } }, expected: { status: "episode_locked" } },
    { options: { version: { ...version, status: RovelleCanonVersionStatus.DRAFT } }, expected: { status: "version_not_locked" } },
    { options: { version: { ...version, entityId: OTHER_ENTITY_ID } }, expected: { status: "entity_mismatch" } },
  ];

  for (const { options, expected } of cases) {
    const fake = createRepository(options);
    assert.deepEqual(
      await fake.repository.pinEpisodeVersion(EPISODE_ID, ENTITY_ID, VERSION_ID),
      expected,
    );
    assert.equal(callsFor(fake.calls, "episodePin.upsert").length, 0);
  }
});

test("pins a shot to a locked version after checking its owning episode", async () => {
  const fake = createRepository();

  assert.deepEqual(
    await fake.repository.pinShotVersion(SHOT_ID, ENTITY_ID, VERSION_ID),
    { status: "pinned", pin: shotPin },
  );
  assert.deepEqual(callsFor(fake.calls, "$transaction")[0], {
    operation: "$transaction",
    args: { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    inTransaction: false,
  });
  assert.deepEqual(callsFor(fake.calls, "shot.findUnique")[0], {
    operation: "shot.findUnique",
    args: { where: { id: SHOT_ID }, include: { episode: { select: { status: true } } } },
    inTransaction: true,
  });
  assert.deepEqual(callsFor(fake.calls, "shotPin.upsert")[0], {
    operation: "shotPin.upsert",
    args: {
      where: { shotId_canonEntityId: { shotId: SHOT_ID, canonEntityId: ENTITY_ID } },
      update: { canonVersionId: VERSION_ID },
      create: { shotId: SHOT_ID, canonEntityId: ENTITY_ID, canonVersionId: VERSION_ID },
    },
    inTransaction: true,
  });
});

test("rejects shot pins for a missing or locked owner and invalid versions", async () => {
  const cases = [
    { options: { shot: null }, expected: { status: "not_found" } },
    { options: { shot: { ...shot, episode: { status: RovelleEpisodeStatus.GENERATING } } }, expected: { status: "episode_locked" } },
    { options: { version: { ...version, status: RovelleCanonVersionStatus.DRAFT } }, expected: { status: "version_not_locked" } },
    { options: { version: { ...version, entityId: OTHER_ENTITY_ID } }, expected: { status: "entity_mismatch" } },
  ];

  for (const { options, expected } of cases) {
    const fake = createRepository(options);
    assert.deepEqual(
      await fake.repository.pinShotVersion(SHOT_ID, ENTITY_ID, VERSION_ID),
      expected,
    );
    assert.equal(callsFor(fake.calls, "shotPin.upsert").length, 0);
  }
});

test("unpins idempotently while the owning episode remains editable", async () => {
  const fake = createRepository();

  assert.deepEqual(
    await fake.repository.unpinEpisodeEntity(EPISODE_ID, ENTITY_ID),
    { status: "unpinned" },
  );
  assert.deepEqual(
    await fake.repository.unpinShotEntity(SHOT_ID, ENTITY_ID),
    { status: "unpinned" },
  );
  assert.deepEqual(
    callsFor(fake.calls, "$transaction").map((call) => call.args),
    [
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ],
  );
  assert.deepEqual(callsFor(fake.calls, "episodePin.deleteMany")[0], {
    operation: "episodePin.deleteMany",
    args: { where: { episodeId: EPISODE_ID, canonEntityId: ENTITY_ID } },
    inTransaction: true,
  });
  assert.deepEqual(callsFor(fake.calls, "shotPin.deleteMany")[0], {
    operation: "shotPin.deleteMany",
    args: { where: { shotId: SHOT_ID, canonEntityId: ENTITY_ID } },
    inTransaction: true,
  });
});

test("rejects unpins when the owner is missing or locked", async () => {
  const cases = [
    { method: "unpinEpisodeEntity" as const, options: { episode: null }, args: [EPISODE_ID, ENTITY_ID], expected: { status: "not_found" } },
    { method: "unpinEpisodeEntity" as const, options: { episode: { ...episode, status: RovelleEpisodeStatus.GENERATING } }, args: [EPISODE_ID, ENTITY_ID], expected: { status: "episode_locked" } },
    { method: "unpinShotEntity" as const, options: { shot: null }, args: [SHOT_ID, ENTITY_ID], expected: { status: "not_found" } },
    { method: "unpinShotEntity" as const, options: { shot: { ...shot, episode: { status: RovelleEpisodeStatus.GENERATING } } }, args: [SHOT_ID, ENTITY_ID], expected: { status: "episode_locked" } },
  ];

  for (const { method, options, args, expected } of cases) {
    const fake = createRepository(options);
    const result =
      method === "unpinEpisodeEntity"
        ? await fake.repository.unpinEpisodeEntity(args[0], args[1])
        : await fake.repository.unpinShotEntity(args[0], args[1]);
    assert.deepEqual(result, expected);
    assert.equal(callsFor(fake.calls, "episodePin.deleteMany").length, 0);
    assert.equal(callsFor(fake.calls, "shotPin.deleteMany").length, 0);
  }
});

test("lists episode pins with their complete canon versions", async () => {
  const { calls, repository } = createRepository();

  assert.deepEqual(await repository.listEpisodePins(EPISODE_ID), [pinWithVersion]);
  assert.deepEqual(callsFor(calls, "episodePin.findMany")[0], {
    operation: "episodePin.findMany",
    args: {
      where: { episodeId: EPISODE_ID },
      orderBy: { canonEntityId: "asc" },
      include: {
        canonVersion: {
          include: {
            entity: true,
            assets: {
              orderBy: [
                { sortOrder: "asc" },
                { role: "asc" },
                { assetId: "asc" },
              ],
              include: { asset: true },
            },
          },
        },
      },
    },
    inTransaction: false,
  });
});

test("loads both episode and direct shot pins with complete canon versions", async () => {
  const { calls, repository } = createRepository();

  assert.ok(await repository.getEffectiveShotPins(SHOT_ID));
  assert.deepEqual(callsFor(calls, "shot.findUnique")[0], {
    operation: "shot.findUnique",
    args: {
      where: { id: SHOT_ID },
      include: {
        episode: {
          include: {
            canonPins: {
              orderBy: { canonEntityId: "asc" },
              include: {
                canonVersion: {
                  include: {
                    entity: true,
                    assets: {
                      orderBy: [
                        { sortOrder: "asc" },
                        { role: "asc" },
                        { assetId: "asc" },
                      ],
                      include: { asset: true },
                    },
                  },
                },
              },
            },
          },
        },
        canonPins: {
          orderBy: { canonEntityId: "asc" },
          include: {
            canonVersion: {
              include: {
                entity: true,
                assets: {
                  orderBy: [
                    { sortOrder: "asc" },
                    { role: "asc" },
                    { assetId: "asc" },
                  ],
                  include: { asset: true },
                },
              },
            },
          },
        },
      },
    },
    inTransaction: false,
  });
});
