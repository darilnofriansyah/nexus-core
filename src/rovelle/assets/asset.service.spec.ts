import * as assert from "node:assert/strict";
import { test } from "node:test";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import {
  RovelleAssetStatus,
  RovelleAssetType,
  type RovelleAsset,
} from "../../generated/prisma/client";
import type { CreateAssetReservationRequestDto } from "./dto/asset.dto";
import {
  AssetRepository,
  type ReservedAssetFenceResult,
} from "./asset.repository";
import { AssetService } from "./asset.service";
import type {
  R2ObjectMetadata,
  R2PresignedRequest,
  R2StorageService,
} from "./r2-storage.service";

const ASSET_ID = "550e8400-e29b-41d4-a716-446655440000";
const EPISODE_ID = "123e4567-e89b-42d3-a456-426614174000";

const reservedAsset: RovelleAsset = {
  id: ASSET_ID,
  episodeId: EPISODE_ID,
  assetType: RovelleAssetType.SOURCE,
  status: RovelleAssetStatus.RESERVED,
  mediaType: "text/plain",
  storageKey: `ringmaster/assets/${ASSET_ID}`,
  originalFilename: "source.txt",
  byteSize: null,
  etag: null,
  createdAt: new Date("2026-08-27T00:00:00.000Z"),
  updatedAt: new Date("2026-08-27T00:00:00.000Z"),
};

const availableAsset: RovelleAsset = {
  ...reservedAsset,
  status: RovelleAssetStatus.AVAILABLE,
  byteSize: 42n,
  etag: "etag-42",
};

const putUrl: R2PresignedRequest = {
  method: "PUT",
  url: "https://signed.example/put",
  headers: { "content-type": "text/plain" },
  expiresAt: "2026-08-27T00:15:00.000Z",
};

const getUrl: R2PresignedRequest = {
  method: "GET",
  url: "https://signed.example/get",
  headers: {},
  expiresAt: "2026-08-27T00:15:00.000Z",
};

class StubAssetRepository implements Pick<
  AssetRepository,
  | "episodeExists"
  | "createReserved"
  | "findById"
  | "markAvailable"
  | "withReservedAsset"
> {
  episodeExistsResult = true;
  asset: RovelleAsset | null = reservedAsset;
  markAvailableResult?: RovelleAsset | null;
  createRequest?: unknown;
  markAvailableRequest?: unknown;
  findCalls = 0;

  async episodeExists(_episodeId: string): Promise<boolean> {
    return this.episodeExistsResult;
  }

  async createReserved(input: {
    id: string;
    episodeId: string | null;
    assetType: RovelleAssetType;
    mediaType: string;
    storageKey: string;
    originalFilename: string | null;
  }): Promise<RovelleAsset> {
    this.createRequest = input;
    this.asset = {
      ...reservedAsset,
      ...input,
      status: RovelleAssetStatus.RESERVED,
    };
    return this.asset;
  }

  async findById(_id: string): Promise<RovelleAsset | null> {
    this.findCalls += 1;
    return this.asset;
  }

  async withReservedAsset<T>(
    _id: string,
    callback: (asset: RovelleAsset) => Promise<T>,
  ): Promise<ReservedAssetFenceResult<T>> {
    if (!this.asset) return { kind: "missing" };
    if (this.asset.status !== RovelleAssetStatus.RESERVED) {
      return { kind: "not_reserved", asset: this.asset };
    }
    return { kind: "reserved", value: await callback(this.asset) };
  }

  async markAvailable(
    _id: string,
    metadata: { byteSize: bigint; etag: string | null },
  ): Promise<RovelleAsset | null> {
    this.markAvailableRequest = metadata;
    if (this.markAvailableResult !== undefined) {
      this.asset = this.markAvailableResult;
      return this.markAvailableResult;
    }
    this.asset = {
      ...(this.asset ?? reservedAsset),
      status: RovelleAssetStatus.AVAILABLE,
      byteSize: metadata.byteSize,
      etag: metadata.etag,
    };
    return this.asset;
  }
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

class CoordinatedAssetRepository extends StubAssetRepository {
  readonly fenceStarted = deferred<void>();
  readonly releaseFence = deferred<void>();
  private fenceInUse = false;
  private firstFind = true;

  override async findById(_id: string): Promise<RovelleAsset | null> {
    const snapshot = this.asset;
    if (!this.fenceInUse && this.firstFind) {
      this.firstFind = false;
      this.fenceStarted.resolve(undefined);
      await this.releaseFence.promise;
    }
    return snapshot;
  }

  override async withReservedAsset<T>(
    _id: string,
    callback: (asset: RovelleAsset) => Promise<T>,
  ): Promise<ReservedAssetFenceResult<T>> {
    this.fenceInUse = true;
    const snapshot = this.asset;
    this.fenceStarted.resolve(undefined);
    await this.releaseFence.promise;

    if (!this.asset) return { kind: "missing" };
    if (this.asset.status !== RovelleAssetStatus.RESERVED) {
      return { kind: "not_reserved", asset: this.asset };
    }
    return {
      kind: "reserved",
      value: await callback(snapshot ?? this.asset),
    };
  }
}

class StubR2Storage {
  assertConfiguredCalls = 0;
  putCalls: Array<{ key: string; mediaType: string }> = [];
  getCalls: string[] = [];
  headCalls: string[] = [];
  headResult: R2ObjectMetadata | null = {
    byteSize: 42n,
    etag: "etag-42",
    contentType: "text/plain",
  };

  assertConfigured(): void {
    this.assertConfiguredCalls += 1;
  }

  async createPutUrl(
    key: string,
    mediaType: string,
  ): Promise<R2PresignedRequest> {
    this.putCalls.push({ key, mediaType });
    return putUrl;
  }

  async createGetUrl(key: string): Promise<R2PresignedRequest> {
    this.getCalls.push(key);
    return getUrl;
  }

  async headObject(key: string): Promise<R2ObjectMetadata | null> {
    this.headCalls.push(key);
    return this.headResult;
  }
}

function createService() {
  const repository = new StubAssetRepository();
  const storage = new StubR2Storage();
  return {
    repository,
    storage,
    service: new AssetService(
      repository as unknown as AssetRepository,
      storage as unknown as R2StorageService,
    ),
  };
}

function reservationRequest(
  overrides: Partial<CreateAssetReservationRequestDto> = {},
): CreateAssetReservationRequestDto {
  return {
    assetType: RovelleAssetType.SOURCE,
    mediaType: "text/plain",
    originalFilename: "source.txt",
    episodeId: EPISODE_ID,
    ...overrides,
  };
}

test("reserve rejects an unknown episode before creating an asset", async () => {
  const { repository, storage, service } = createService();
  repository.episodeExistsResult = false;

  await assert.rejects(
    () => service.reserve(reservationRequest()),
    NotFoundException,
  );
  assert.equal(repository.createRequest, undefined);
  assert.equal(storage.putCalls.length, 0);
});

test("reserve checks storage configuration before persistence", async () => {
  const { repository, storage, service } = createService();

  await service.reserve(reservationRequest());

  assert.equal(storage.assertConfiguredCalls, 1);
  assert.ok(repository.createRequest);
});

test("reserve generates the asset UUID and Core-owned storage key", async () => {
  const { repository, storage, service } = createService();

  const result = await service.reserve(
    reservationRequest({ mediaType: " TEXT/PLAIN " }),
  );
  const request = repository.createRequest as {
    id: string;
    storageKey: string;
  };

  assert.match(
    request.id,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
  assert.equal(request.storageKey, `ringmaster/assets/${request.id}`);
  assert.deepEqual(storage.putCalls, [
    { key: request.storageKey, mediaType: "text/plain" },
  ]);
  assert.equal(result.asset.id, request.id);
});

test("reserve returns the mapped RESERVED asset and PUT descriptor", async () => {
  const { service } = createService();

  const result = await service.reserve(reservationRequest());

  assert.equal(result.asset.status, RovelleAssetStatus.RESERVED);
  assert.deepEqual(result.upload, putUrl);
  assert.equal("storageKey" in result.asset, false);
});

test("createUploadUrl renews a PUT URL for a RESERVED asset", async () => {
  const { storage, service } = createService();

  const result = await service.createUploadUrl(ASSET_ID);

  assert.deepEqual(storage.putCalls, [
    { key: reservedAsset.storageKey, mediaType: reservedAsset.mediaType },
  ]);
  assert.equal(result.asset.status, RovelleAssetStatus.RESERVED);
  assert.deepEqual(result.upload, putUrl);
});

test("createUploadUrl rejects AVAILABLE assets", async () => {
  const { repository, storage, service } = createService();
  repository.asset = availableAsset;

  await assert.rejects(
    () => service.createUploadUrl(ASSET_ID),
    BadRequestException,
  );
  assert.equal(storage.putCalls.length, 0);
});

test("getAsset returns metadata without calling R2", async () => {
  const { storage, service } = createService();

  const result = await service.getAsset(ASSET_ID);

  assert.equal(result.id, ASSET_ID);
  assert.equal(storage.headCalls.length, 0);
  assert.equal(storage.putCalls.length, 0);
  assert.equal(storage.getCalls.length, 0);
});

test("confirmUpload rejects a missing R2 object", async () => {
  const { storage, service } = createService();
  storage.headResult = null;

  await assert.rejects(
    () => service.confirmUpload(ASSET_ID),
    BadRequestException,
  );
});

test("confirmUpload rejects a zero-byte R2 object", async () => {
  const { storage, service } = createService();
  storage.headResult = { ...storage.headResult!, byteSize: 0n };

  await assert.rejects(
    () => service.confirmUpload(ASSET_ID),
    BadRequestException,
  );
});

test("confirmUpload rejects a reported content-type mismatch", async () => {
  const { storage, service } = createService();
  storage.headResult = { ...storage.headResult!, contentType: "image/png" };

  await assert.rejects(
    () => service.confirmUpload(ASSET_ID),
    BadRequestException,
  );
});

test("confirmUpload marks a matching object AVAILABLE with its metadata", async () => {
  const { repository, storage, service } = createService();
  storage.headResult = {
    byteSize: 84n,
    etag: "etag-84",
    contentType: " TEXT/PLAIN ",
  };

  const result = await service.confirmUpload(ASSET_ID);

  assert.deepEqual(repository.markAvailableRequest, {
    byteSize: 84n,
    etag: "etag-84",
  });
  assert.equal(result.status, RovelleAssetStatus.AVAILABLE);
  assert.equal(result.byteSize, "84");
  assert.equal(result.etag, "etag-84");
});

test("confirmUpload is idempotent for an AVAILABLE asset", async () => {
  const { repository, storage, service } = createService();
  repository.asset = availableAsset;

  const result = await service.confirmUpload(ASSET_ID);

  assert.equal(result.status, RovelleAssetStatus.AVAILABLE);
  assert.equal(storage.headCalls.length, 0);
  assert.equal(repository.markAvailableRequest, undefined);
});

test("confirmUpload rejects when the conditional update reloads a RESERVED asset", async () => {
  const { repository, service } = createService();
  repository.markAvailableResult = reservedAsset;

  await assert.rejects(
    () => service.confirmUpload(ASSET_ID),
    BadRequestException,
  );
  assert.equal(repository.asset?.status, RovelleAssetStatus.RESERVED);
});

test("createReadUrl requires an AVAILABLE asset", async () => {
  const { storage, service } = createService();

  await assert.rejects(
    () => service.createReadUrl(ASSET_ID),
    BadRequestException,
  );
  assert.equal(storage.getCalls.length, 0);
});

test("createReadUrl returns a GET descriptor without exposing the storage key", async () => {
  const { repository, storage, service } = createService();
  repository.asset = availableAsset;

  const result = await service.createReadUrl(ASSET_ID);

  assert.deepEqual(storage.getCalls, [availableAsset.storageKey]);
  assert.deepEqual(result.download, getUrl);
  assert.equal(result.asset.status, RovelleAssetStatus.AVAILABLE);
  assert.equal("storageKey" in result.asset, false);
});

test("createUploadUrl does not sign after a concurrent confirmation", async () => {
  const repository = new CoordinatedAssetRepository();
  const storage = new StubR2Storage();
  const service = new AssetService(
    repository as unknown as AssetRepository,
    storage as unknown as R2StorageService,
  );

  const pending = service.createUploadUrl(ASSET_ID);
  await repository.fenceStarted.promise;
  await service.confirmUpload(ASSET_ID);
  repository.releaseFence.resolve(undefined);

  await assert.rejects(() => pending, BadRequestException);
  assert.equal(storage.putCalls.length, 0);
});

test("asset operations reject a missing asset", async () => {
  for (const operation of [
    "getAsset",
    "createUploadUrl",
    "confirmUpload",
    "createReadUrl",
  ] as const) {
    const { repository, service } = createService();
    repository.asset = null;
    await assert.rejects(() => service[operation](ASSET_ID), NotFoundException);
  }
});
