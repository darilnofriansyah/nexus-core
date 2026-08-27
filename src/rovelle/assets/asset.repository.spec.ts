import * as assert from "node:assert/strict";
import { test } from "node:test";
import { PrismaService } from "../../database/prisma.service";
import {
  RovelleAssetStatus,
  RovelleAssetType,
  type RovelleAsset,
} from "../../generated/prisma/client";
import { AssetRepository } from "./asset.repository";
import type { ReservedAssetFenceResult } from "./asset.repository";

type RepositoryCall = {
  operation: string;
  args: unknown;
};

const asset: RovelleAsset = {
  id: "550e8400-e29b-41d4-a716-446655440000",
  episodeId: "123e4567-e89b-42d3-a456-426614174000",
  assetType: RovelleAssetType.SOURCE,
  status: RovelleAssetStatus.RESERVED,
  mediaType: "text/plain",
  storageKey: "ringmaster/assets/550e8400-e29b-41d4-a716-446655440000",
  originalFilename: "source.txt",
  byteSize: null,
  etag: null,
  createdAt: new Date("2026-08-27T00:00:00.000Z"),
  updatedAt: new Date("2026-08-27T00:00:00.000Z"),
};

function createRepository(
  options: {
    episodeCount?: number;
    createdAsset?: RovelleAsset;
    foundAssets?: Array<RovelleAsset | null>;
    updateCount?: number;
  } = {},
) {
  const calls: RepositoryCall[] = [];
  const foundAssets = [...(options.foundAssets ?? [asset])];
  const client = {
    rovelleEpisode: {
      count: async (args: unknown) => {
        calls.push({ operation: "episode.count", args });
        return options.episodeCount ?? 1;
      },
    },
    rovelleAsset: {
      create: async (args: unknown) => {
        calls.push({ operation: "asset.create", args });
        return options.createdAsset ?? asset;
      },
      findUnique: async (args: unknown) => {
        calls.push({ operation: "asset.findUnique", args });
        return foundAssets.shift() ?? null;
      },
      updateMany: async (args: unknown) => {
        calls.push({ operation: "asset.updateMany", args });
        return { count: options.updateCount ?? 1 };
      },
    },
  };

  return {
    calls,
    repository: new AssetRepository({ client } as unknown as PrismaService),
  };
}

test("episodeExists checks the Rovelle episode count", async () => {
  const { calls, repository } = createRepository({ episodeCount: 0 });

  assert.equal(
    await repository.episodeExists("123e4567-e89b-42d3-a456-426614174000"),
    false,
  );
  assert.deepEqual(calls[0], {
    operation: "episode.count",
    args: { where: { id: "123e4567-e89b-42d3-a456-426614174000" } },
  });
});

test("createReserved persists the Core-owned asset fields and RESERVED status", async () => {
  const { calls, repository } = createRepository();
  const input = {
    id: asset.id,
    episodeId: asset.episodeId,
    assetType: asset.assetType,
    mediaType: asset.mediaType,
    storageKey: asset.storageKey,
    originalFilename: asset.originalFilename,
  };

  await repository.createReserved(input);

  assert.deepEqual(calls[0], {
    operation: "asset.create",
    args: {
      data: {
        id: asset.id,
        episodeId: asset.episodeId,
        assetType: RovelleAssetType.SOURCE,
        status: RovelleAssetStatus.RESERVED,
        mediaType: "text/plain",
        storageKey: asset.storageKey,
        originalFilename: "source.txt",
      },
    },
  });
});

test("findById loads an asset by UUID", async () => {
  const { calls, repository } = createRepository();

  assert.equal(await repository.findById(asset.id), asset);
  assert.deepEqual(calls[0], {
    operation: "asset.findUnique",
    args: { where: { id: asset.id } },
  });
});

test("markAvailable conditionally updates RESERVED assets and stores metadata", async () => {
  const { calls, repository } = createRepository();

  await repository.markAvailable(asset.id, {
    byteSize: 42n,
    etag: "etag-42",
  });

  assert.deepEqual(calls, [
    {
      operation: "asset.updateMany",
      args: {
        where: { id: asset.id, status: RovelleAssetStatus.RESERVED },
        data: {
          status: RovelleAssetStatus.AVAILABLE,
          byteSize: 42n,
          etag: "etag-42",
        },
      },
    },
    {
      operation: "asset.findUnique",
      args: { where: { id: asset.id } },
    },
  ]);
});

test("markAvailable reloads the current asset after a conditional update miss", async () => {
  const current: RovelleAsset = {
    ...asset,
    status: RovelleAssetStatus.AVAILABLE,
    byteSize: 84n,
    etag: "new-etag",
  };
  const { calls, repository } = createRepository({
    updateCount: 0,
    foundAssets: [current],
  });

  assert.equal(
    await repository.markAvailable(asset.id, {
      byteSize: 42n,
      etag: "old-etag",
    }),
    current,
  );
  assert.equal(calls.at(-1)?.operation, "asset.findUnique");
});

test("withReservedAsset fences the RESERVED check and callback in a transaction", async () => {
  const calls: RepositoryCall[] = [];
  const transactionClient = {
    rovelleAsset: {
      updateMany: async (args: unknown) => {
        calls.push({ operation: "asset.updateMany", args });
        return { count: 1 };
      },
      findUnique: async (args: unknown) => {
        calls.push({ operation: "asset.findUnique", args });
        return asset;
      },
    },
  };
  const prisma = {
    client: {
      $transaction: async <T>(
        callback: (tx: typeof transactionClient) => Promise<T>,
      ) => callback(transactionClient),
    },
  } as unknown as PrismaService;
  const repository = new AssetRepository(prisma);

  const result = await repository.withReservedAsset(
    asset.id,
    async (lockedAsset) => lockedAsset.id,
  );

  assert.deepEqual(result, {
    kind: "reserved",
    value: asset.id,
  } satisfies ReservedAssetFenceResult<string>);
  assert.deepEqual(calls, [
    {
      operation: "asset.updateMany",
      args: {
        where: { id: asset.id, status: RovelleAssetStatus.RESERVED },
        data: { status: RovelleAssetStatus.RESERVED },
      },
    },
    {
      operation: "asset.findUnique",
      args: { where: { id: asset.id } },
    },
  ]);
});
