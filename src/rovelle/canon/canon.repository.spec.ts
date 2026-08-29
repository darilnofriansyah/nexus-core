import * as assert from "node:assert/strict";
import { test } from "node:test";
import { PrismaService } from "../../database/prisma.service";
import {
  Prisma,
  RovelleAssetStatus,
  RovelleAssetType,
  RovelleCanonEntityType,
  RovelleCanonVersionStatus,
  type RovelleAsset,
  type RovelleCanonAsset,
  type RovelleCanonEntity,
  type RovelleCanonVersion,
} from "../../generated/prisma/client";
import type {
  AttachCanonAssetRequestDto,
  CreateCanonEntityRequestDto,
} from "./dto/canon.dto";
import {
  CanonRepository,
  type CanonEntityWithVersions,
  type CanonVersionWithAssets,
} from "./canon.repository";

type RepositoryCall = {
  operation: string;
  args: unknown;
  inTransaction: boolean;
};

type FakeOptions = {
  createdEntity?: RovelleCanonEntity;
  foundEntities?: Array<CanonEntityWithVersions | null>;
  listedEntities?: RovelleCanonEntity[];
  foundVersions?: Array<CanonVersionWithAssets | null>;
  transactionEntity?: RovelleCanonEntity | null;
  latestVersion?: number | null;
  createdVersion?: RovelleCanonVersion;
  updatedCounts?: number[];
  transactionVersions?: unknown[];
  attachmentCreateError?: unknown;
  attachmentDeleteCount?: number;
  lockUpdatedCounts?: number[];
};

const ENTITY_ID = "550e8400-e29b-41d4-a716-446655440000";
const VERSION_ID = "123e4567-e89b-42d3-a456-426614174000";
const ASSET_ID = "223e4567-e89b-42d3-a456-426614174000";

const entity: RovelleCanonEntity = {
  id: ENTITY_ID,
  code: "KOKO",
  displayName: "Koko",
  entityType: RovelleCanonEntityType.CHARACTER,
  description: "The lead character",
  createdAt: new Date("2026-08-27T00:00:00.000Z"),
  updatedAt: new Date("2026-08-27T00:01:00.000Z"),
};

const version: RovelleCanonVersion = {
  id: VERSION_ID,
  entityId: ENTITY_ID,
  version: 2,
  status: RovelleCanonVersionStatus.DRAFT,
  definition: { appearance: { color: "yellow" } },
  lockedAt: null,
  createdAt: new Date("2026-08-27T00:02:00.000Z"),
  updatedAt: new Date("2026-08-27T00:03:00.000Z"),
};

const asset: RovelleAsset = {
  id: ASSET_ID,
  episodeId: null,
  assetType: RovelleAssetType.CHARACTER_REFERENCE,
  status: RovelleAssetStatus.AVAILABLE,
  mediaType: "image/png",
  storageKey: "rovelle/assets/koko.png",
  originalFilename: "koko.png",
  byteSize: 42n,
  etag: "etag-koko",
  createdAt: new Date("2026-08-27T00:04:00.000Z"),
  updatedAt: new Date("2026-08-27T00:05:00.000Z"),
};

const canonAsset: RovelleCanonAsset & { asset: RovelleAsset } = {
  canonVersionId: VERSION_ID,
  assetId: ASSET_ID,
  role: "PORTRAIT",
  sortOrder: 0,
  createdAt: new Date("2026-08-27T00:06:00.000Z"),
  asset,
};

const entityWithVersions: CanonEntityWithVersions = {
  ...entity,
  versions: [
    version,
    { ...version, id: "323e4567-e89b-42d3-a456-426614174000", version: 1 },
  ],
};

const versionWithAssets: CanonVersionWithAssets = {
  ...version,
  entity,
  assets: [canonAsset],
};

function createRepository(options: FakeOptions = {}) {
  const calls: RepositoryCall[] = [];
  const foundEntities = [...(options.foundEntities ?? [entityWithVersions])];
  const foundVersions = [...(options.foundVersions ?? [versionWithAssets])];
  const updatedCounts = [...(options.updatedCounts ?? [1])];
  const transactionVersions = [...(options.transactionVersions ?? [])];
  const lockUpdatedCounts = [...(options.lockUpdatedCounts ?? [1])];
  const transactionEntity =
    options.transactionEntity === undefined
      ? entity
      : options.transactionEntity;
  let inTransaction = false;
  let transactionCount = 0;

  const record = (operation: string, args: unknown) => {
    calls.push({ operation, args, inTransaction });
  };

  const transactionClient = {
    rovelleCanonEntity: {
      findUnique: async (args: unknown) => {
        record("entity.findUnique", args);
        return transactionEntity;
      },
    },
    rovelleCanonVersion: {
      findUnique: async (args: unknown) => {
        record("version.findUnique", args);
        return transactionVersions.shift() ?? null;
      },
      aggregate: async (args: unknown) => {
        record("version.aggregate", args);
        return { _max: { version: options.latestVersion ?? null } };
      },
      create: async (args: unknown) => {
        record("version.create", args);
        return options.createdVersion ?? version;
      },
      updateMany: async (args: unknown) => {
        record("version.updateMany", args);
        return { count: lockUpdatedCounts.shift() ?? 1 };
      },
    },
    rovelleCanonAsset: {
      create: async (args: unknown) => {
        record("canonAsset.create", args);
        if (options.attachmentCreateError) {
          throw options.attachmentCreateError;
        }
        return canonAsset;
      },
      deleteMany: async (args: unknown) => {
        record("canonAsset.deleteMany", args);
        return { count: options.attachmentDeleteCount ?? 1 };
      },
    },
  };

  const client = {
    rovelleCanonEntity: {
      create: async (args: unknown) => {
        record("entity.create", args);
        return options.createdEntity ?? entity;
      },
      findMany: async (args: unknown) => {
        record("entity.findMany", args);
        return options.listedEntities ?? [entity];
      },
      findUnique: async (args: unknown) => {
        record("entity.findUnique", args);
        return foundEntities.shift() ?? null;
      },
    },
    rovelleCanonVersion: {
      findUnique: async (args: unknown) => {
        record("version.findUnique", args);
        return foundVersions.shift() ?? null;
      },
      updateMany: async (args: unknown) => {
        record("version.updateMany", args);
        return { count: updatedCounts.shift() ?? 1 };
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
    repository: new CanonRepository({ client } as unknown as PrismaService),
    get transactionCount() {
      return transactionCount;
    },
  };
}

function callsFor(
  calls: RepositoryCall[],
  operation: string,
): RepositoryCall[] {
  return calls.filter((call) => call.operation === operation);
}

test("createEntity persists the normalized canon entity fields", async () => {
  const { calls, repository } = createRepository();
  const request: CreateCanonEntityRequestDto = {
    code: "KOKO",
    displayName: "Koko",
    entityType: RovelleCanonEntityType.CHARACTER,
    description: "The lead character",
  };

  assert.equal(await repository.createEntity(request), entity);
  assert.deepEqual(calls[0], {
    operation: "entity.create",
    args: {
      data: {
        code: "KOKO",
        displayName: "Koko",
        entityType: RovelleCanonEntityType.CHARACTER,
        description: "The lead character",
      },
    },
    inTransaction: false,
  });
});

test("listEntities orders canon entities by code", async () => {
  const { calls, repository } = createRepository();

  assert.deepEqual(await repository.listEntities(), [entity]);
  assert.deepEqual(calls[0], {
    operation: "entity.findMany",
    args: { orderBy: { code: "asc" } },
    inTransaction: false,
  });
});

test("findEntity includes versions newest first", async () => {
  const { calls, repository } = createRepository();

  assert.deepEqual(await repository.findEntity(ENTITY_ID), entityWithVersions);
  assert.deepEqual(calls[0], {
    operation: "entity.findUnique",
    args: {
      where: { id: ENTITY_ID },
      include: { versions: { orderBy: { version: "desc" } } },
    },
    inTransaction: false,
  });
});

test("findEntityByCode includes versions newest first", async () => {
  const { calls, repository } = createRepository();

  assert.deepEqual(
    await repository.findEntityByCode("KOKO"),
    entityWithVersions,
  );
  assert.deepEqual(calls[0], {
    operation: "entity.findUnique",
    args: {
      where: { code: "KOKO" },
      include: { versions: { orderBy: { version: "desc" } } },
    },
    inTransaction: false,
  });
});

test("createDraftVersion allocates max plus one in a serializable transaction", async () => {
  const fake = createRepository({ latestVersion: 4 });
  const definition = { appearance: { color: "yellow" } };

  const result = await fake.repository.createDraftVersion(
    ENTITY_ID,
    definition,
  );

  assert.deepEqual(result, { status: "created", version });
  assert.equal(fake.transactionCount, 1);
  assert.deepEqual(callsFor(fake.calls, "$transaction")[0], {
    operation: "$transaction",
    args: { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    inTransaction: false,
  });
  assert.deepEqual(callsFor(fake.calls, "entity.findUnique")[0], {
    operation: "entity.findUnique",
    args: { where: { id: ENTITY_ID } },
    inTransaction: true,
  });
  assert.deepEqual(callsFor(fake.calls, "version.aggregate")[0], {
    operation: "version.aggregate",
    args: { where: { entityId: ENTITY_ID }, _max: { version: true } },
    inTransaction: true,
  });
  assert.deepEqual(callsFor(fake.calls, "version.create")[0], {
    operation: "version.create",
    args: {
      data: {
        entityId: ENTITY_ID,
        version: 5,
        definition,
      },
    },
    inTransaction: true,
  });
});

test("createDraftVersion starts at one when the entity has no versions", async () => {
  const { calls, repository } = createRepository({ latestVersion: null });

  await repository.createDraftVersion(ENTITY_ID, { age: 4 });

  assert.deepEqual(callsFor(calls, "version.create")[0], {
    operation: "version.create",
    args: {
      data: {
        entityId: ENTITY_ID,
        version: 1,
        definition: { age: 4 },
      },
    },
    inTransaction: true,
  });
});

test("createDraftVersion reports not_found without allocating a version", async () => {
  const fake = createRepository({ transactionEntity: null });

  assert.deepEqual(
    await fake.repository.createDraftVersion(ENTITY_ID, { age: 4 }),
    { status: "not_found" },
  );
  assert.equal(fake.transactionCount, 1);
  assert.equal(callsFor(fake.calls, "version.aggregate").length, 0);
  assert.equal(callsFor(fake.calls, "version.create").length, 0);
});

test("findVersion includes its entity and deterministically ordered assets", async () => {
  const { calls, repository } = createRepository();

  assert.deepEqual(await repository.findVersion(VERSION_ID), versionWithAssets);
  assert.deepEqual(calls[0], {
    operation: "version.findUnique",
    args: {
      where: { id: VERSION_ID },
      include: {
        entity: true,
        assets: {
          orderBy: [{ sortOrder: "asc" }, { role: "asc" }, { assetId: "asc" }],
          include: { asset: true },
        },
      },
    },
    inTransaction: false,
  });
});

test("updateDraftDefinition conditionally updates a draft and reloads it", async () => {
  const { calls, repository } = createRepository({
    foundVersions: [versionWithAssets],
  });
  const definition = { appearance: { color: "blue" } };

  assert.deepEqual(
    await repository.updateDraftDefinition(VERSION_ID, definition),
    versionWithAssets,
  );
  assert.deepEqual(callsFor(calls, "version.updateMany")[0], {
    operation: "version.updateMany",
    args: {
      where: { id: VERSION_ID, status: RovelleCanonVersionStatus.DRAFT },
      data: { definition },
    },
    inTransaction: false,
  });
  assert.equal(callsFor(calls, "version.findUnique").length, 1);
});

test("updateDraftDefinition leaves locked versions unchanged", async () => {
  const { calls, repository } = createRepository({ updatedCounts: [0] });

  assert.equal(
    await repository.updateDraftDefinition(VERSION_ID, {
      appearance: { color: "blue" },
    }),
    null,
  );
  assert.deepEqual(callsFor(calls, "version.updateMany")[0], {
    operation: "version.updateMany",
    args: {
      where: { id: VERSION_ID, status: RovelleCanonVersionStatus.DRAFT },
      data: { definition: { appearance: { color: "blue" } } },
    },
    inTransaction: false,
  });
  assert.equal(callsFor(calls, "version.findUnique").length, 0);
});

test("attachAsset creates an attachment and reloads the draft in a serializable transaction", async () => {
  const fake = createRepository({
    transactionVersions: [versionWithAssets, versionWithAssets],
  });
  const request: AttachCanonAssetRequestDto = {
    assetId: ASSET_ID,
    role: "PORTRAIT",
    sortOrder: 0,
  };

  assert.deepEqual(await fake.repository.attachAsset(VERSION_ID, request), {
    status: "attached",
    version: versionWithAssets,
  });
  assert.equal(fake.transactionCount, 1);
  assert.deepEqual(callsFor(fake.calls, "$transaction")[0], {
    operation: "$transaction",
    args: { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    inTransaction: false,
  });
  assert.deepEqual(callsFor(fake.calls, "version.findUnique")[0], {
    operation: "version.findUnique",
    args: {
      where: { id: VERSION_ID },
      include: { entity: { select: { entityType: true } } },
    },
    inTransaction: true,
  });
  assert.deepEqual(callsFor(fake.calls, "canonAsset.create")[0], {
    operation: "canonAsset.create",
    args: {
      data: {
        canonVersionId: VERSION_ID,
        assetId: ASSET_ID,
        role: "PORTRAIT",
        sortOrder: 0,
      },
    },
    inTransaction: true,
  });
  assert.deepEqual(callsFor(fake.calls, "version.findUnique")[1], {
    operation: "version.findUnique",
    args: {
      where: { id: VERSION_ID },
      include: {
        entity: true,
        assets: {
          orderBy: [{ sortOrder: "asc" }, { role: "asc" }, { assetId: "asc" }],
          include: { asset: true },
        },
      },
    },
    inTransaction: true,
  });
});

test("attachAsset reports missing, locked, and duplicate draft attachment outcomes", async () => {
  const request: AttachCanonAssetRequestDto = {
    assetId: ASSET_ID,
    role: "PORTRAIT",
    sortOrder: 0,
  };

  const missing = createRepository({ transactionVersions: [null] });
  assert.deepEqual(await missing.repository.attachAsset(VERSION_ID, request), {
    status: "not_found",
  });
  assert.equal(callsFor(missing.calls, "canonAsset.create").length, 0);

  const locked = createRepository({
    transactionVersions: [
      { ...versionWithAssets, status: RovelleCanonVersionStatus.LOCKED },
    ],
  });
  assert.deepEqual(await locked.repository.attachAsset(VERSION_ID, request), {
    status: "invalid_state",
  });
  assert.equal(callsFor(locked.calls, "canonAsset.create").length, 0);

  const duplicate = createRepository({
    transactionVersions: [versionWithAssets],
    attachmentCreateError: { code: "P2002" },
  });
  assert.deepEqual(await duplicate.repository.attachAsset(VERSION_ID, request), {
    status: "conflict",
  });
});

test("detachAsset removes only the requested draft attachment in a serializable transaction", async () => {
  const fake = createRepository({
    transactionVersions: [versionWithAssets, versionWithAssets],
  });

  assert.deepEqual(await fake.repository.detachAsset(VERSION_ID, ASSET_ID), {
    status: "detached",
    version: versionWithAssets,
  });
  assert.equal(fake.transactionCount, 1);
  assert.deepEqual(callsFor(fake.calls, "$transaction")[0], {
    operation: "$transaction",
    args: { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    inTransaction: false,
  });
  assert.deepEqual(callsFor(fake.calls, "version.findUnique")[0], {
    operation: "version.findUnique",
    args: { where: { id: VERSION_ID } },
    inTransaction: true,
  });
  assert.deepEqual(callsFor(fake.calls, "canonAsset.deleteMany")[0], {
    operation: "canonAsset.deleteMany",
    args: { where: { canonVersionId: VERSION_ID, assetId: ASSET_ID } },
    inTransaction: true,
  });
  assert.equal(callsFor(fake.calls, "version.findUnique").length, 2);
});

test("detachAsset returns draft state outcomes without deleting an attachment", async () => {
  const missing = createRepository({ transactionVersions: [null] });
  assert.deepEqual(await missing.repository.detachAsset(VERSION_ID, ASSET_ID), {
    status: "not_found",
  });
  assert.equal(callsFor(missing.calls, "canonAsset.deleteMany").length, 0);

  const locked = createRepository({
    transactionVersions: [
      { ...versionWithAssets, status: RovelleCanonVersionStatus.LOCKED },
    ],
  });
  assert.deepEqual(await locked.repository.detachAsset(VERSION_ID, ASSET_ID), {
    status: "invalid_state",
  });
  assert.equal(callsFor(locked.calls, "canonAsset.deleteMany").length, 0);
});

test("lockVersion locks a draft with attachments in a serializable transaction", async () => {
  const lockedVersion = {
    ...versionWithAssets,
    status: RovelleCanonVersionStatus.LOCKED,
    lockedAt: new Date("2026-08-27T00:07:00.000Z"),
  };
  const fake = createRepository({
    transactionVersions: [
      { ...version, _count: { assets: 1 } },
      lockedVersion,
    ],
  });

  assert.deepEqual(await fake.repository.lockVersion(VERSION_ID), {
    status: "locked",
    version: lockedVersion,
  });
  assert.equal(fake.transactionCount, 1);
  assert.deepEqual(callsFor(fake.calls, "$transaction")[0], {
    operation: "$transaction",
    args: { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    inTransaction: false,
  });
  assert.deepEqual(callsFor(fake.calls, "version.findUnique")[0], {
    operation: "version.findUnique",
    args: {
      where: { id: VERSION_ID },
      include: { _count: { select: { assets: true } } },
    },
    inTransaction: true,
  });
  const update = callsFor(fake.calls, "version.updateMany")[0];
  assert.equal(update?.inTransaction, true);
  assert.deepEqual((update?.args as { where: unknown }).where, {
    id: VERSION_ID,
    status: RovelleCanonVersionStatus.DRAFT,
  });
  assert.equal(
    (update?.args as { data: { status: unknown } }).data.status,
    RovelleCanonVersionStatus.LOCKED,
  );
  assert.ok(
    (update?.args as { data: { lockedAt: unknown } }).data.lockedAt instanceof
      Date,
  );
});

test("lockVersion reports missing, non-draft, empty, and concurrently changed versions", async () => {
  const missing = createRepository({ transactionVersions: [null] });
  assert.deepEqual(await missing.repository.lockVersion(VERSION_ID), {
    status: "not_found",
  });

  const locked = createRepository({
    transactionVersions: [
      {
        ...version,
        status: RovelleCanonVersionStatus.LOCKED,
        _count: { assets: 1 },
      },
    ],
  });
  assert.deepEqual(await locked.repository.lockVersion(VERSION_ID), {
    status: "invalid_state",
  });

  const empty = createRepository({
    transactionVersions: [{ ...version, _count: { assets: 0 } }],
  });
  assert.deepEqual(await empty.repository.lockVersion(VERSION_ID), {
    status: "no_assets",
  });

  const changed = createRepository({
    transactionVersions: [{ ...version, _count: { assets: 1 } }],
    lockUpdatedCounts: [0],
  });
  assert.deepEqual(await changed.repository.lockVersion(VERSION_ID), {
    status: "invalid_state",
  });
});
