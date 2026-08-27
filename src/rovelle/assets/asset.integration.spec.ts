import * as assert from "node:assert/strict";
import {
  after,
  afterEach,
  before,
  beforeEach,
  describe,
  test,
} from "node:test";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../../database/prisma.service";
import {
  RovelleAssetStatus,
  RovelleAssetType,
} from "../../generated/prisma/client";
import { AssetRepository } from "./asset.repository";
import { AssetService } from "./asset.service";
import type {
  R2ObjectMetadata,
  R2PresignedRequest,
  R2StorageService,
} from "./r2-storage.service";

const testDatabaseUrl = process.env.ROVELLE_TEST_DATABASE_URL;
const originalDatabaseUrl = process.env.DATABASE_URL;
const unknownEpisodeId = "123e4567-e89b-42d3-a456-426614174000";

class FakeR2Storage {
  readonly putCalls: Array<{ key: string; mediaType: string }> = [];
  readonly headCalls: string[] = [];
  readonly getCalls: string[] = [];

  assertConfigured(): void {}

  async createPutUrl(
    key: string,
    mediaType: string,
  ): Promise<R2PresignedRequest> {
    this.putCalls.push({ key, mediaType });
    return {
      method: "PUT",
      url: `https://fake-r2.test/${key}`,
      headers: { "content-type": mediaType },
      expiresAt: "2099-01-01T00:00:00.000Z",
    };
  }

  async createGetUrl(key: string): Promise<R2PresignedRequest> {
    this.getCalls.push(key);
    return {
      method: "GET",
      url: `https://fake-r2.test/${key}`,
      headers: {},
      expiresAt: "2099-01-01T00:00:00.000Z",
    };
  }

  async headObject(key: string): Promise<R2ObjectMetadata> {
    this.headCalls.push(key);
    return {
      byteSize: 12n,
      etag: "etag-12",
      contentType: "text/plain",
    };
  }
}

describe("Rovelle asset registry", { skip: !testDatabaseUrl }, () => {
  let prisma!: PrismaService;
  let service!: AssetService;
  let storage!: FakeR2Storage;

  before(async () => {
    process.env.DATABASE_URL = testDatabaseUrl;
    prisma = new PrismaService();
    await cleanRovelleTables();
  });

  beforeEach(() => {
    storage = new FakeR2Storage();
    service = new AssetService(
      new AssetRepository(prisma),
      storage as unknown as R2StorageService,
    );
  });

  afterEach(cleanRovelleTables);

  after(async () => {
    await prisma?.onModuleDestroy();

    if (originalDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = originalDatabaseUrl;
    }
  });

  async function cleanRovelleTables(): Promise<void> {
    if (!prisma) return;

    await prisma.client.rovelleAsset.deleteMany();
    await prisma.client.rovelleShot.deleteMany();
    await prisma.client.rovelleEpisode.deleteMany();
  }

  async function createEpisode(code: string) {
    return prisma.client.rovelleEpisode.create({
      data: { code, title: "Asset registry test episode" },
    });
  }

  test("persists the asset lifecycle and exposes bigint metadata as strings", async () => {
    const episode = await createEpisode("ASSET-001");
    const reserved = await service.reserve({
      assetType: RovelleAssetType.SOURCE,
      mediaType: "text/plain",
      originalFilename: "source.txt",
      episodeId: episode.id,
    });

    assert.equal(reserved.asset.status, RovelleAssetStatus.RESERVED);
    assert.equal(reserved.asset.episodeId, episode.id);
    assert.equal(reserved.asset.byteSize, null);
    assert.equal("storageKey" in reserved.asset, false);

    const reservedRow = await prisma.client.rovelleAsset.findUnique({
      where: { id: reserved.asset.id },
    });
    assert.ok(reservedRow);
    assert.equal(reservedRow.status, RovelleAssetStatus.RESERVED);
    assert.equal(reservedRow.episodeId, episode.id);
    assert.equal(reservedRow.byteSize, null);
    assert.deepEqual(storage.putCalls, [
      { key: reservedRow.storageKey, mediaType: "text/plain" },
    ]);

    const confirmed = await service.confirmUpload(reserved.asset.id);

    assert.equal(confirmed.status, RovelleAssetStatus.AVAILABLE);
    assert.equal(confirmed.byteSize, "12");
    assert.deepEqual(storage.headCalls, [reservedRow.storageKey]);

    const availableRow = await prisma.client.rovelleAsset.findUnique({
      where: { id: reserved.asset.id },
    });
    assert.ok(availableRow);
    assert.equal(availableRow.status, RovelleAssetStatus.AVAILABLE);
    assert.equal(availableRow.byteSize, 12n);
    assert.equal(availableRow.etag, "etag-12");

    const confirmedAgain = await service.confirmUpload(reserved.asset.id);
    assert.deepEqual(confirmedAgain, confirmed);
    assert.deepEqual(storage.headCalls, [reservedRow.storageKey]);

    const read = await service.createReadUrl(reserved.asset.id);
    assert.equal(read.asset.status, RovelleAssetStatus.AVAILABLE);
    assert.equal(read.asset.byteSize, "12");
    assert.equal("storageKey" in read.asset, false);
    assert.deepEqual(storage.getCalls, [reservedRow.storageKey]);

    const fetched = await service.getAsset(reserved.asset.id);
    assert.equal(fetched.byteSize, "12");
    assert.equal("storageKey" in fetched, false);
  });

  test("rejects a reservation for a nonexistent episode", async () => {
    await assert.rejects(
      () =>
        service.reserve({
          assetType: RovelleAssetType.SOURCE,
          mediaType: "text/plain",
          episodeId: unknownEpisodeId,
        }),
      NotFoundException,
    );

    assert.equal(storage.putCalls.length, 0);
    assert.equal(await prisma.client.rovelleAsset.count(), 0);
  });

  test("rejects a new PUT URL for an AVAILABLE asset", async () => {
    const episode = await createEpisode("ASSET-003");
    const reserved = await service.reserve({
      assetType: RovelleAssetType.SOURCE,
      mediaType: "text/plain",
      episodeId: episode.id,
    });
    await service.confirmUpload(reserved.asset.id);

    await assert.rejects(
      () => service.createUploadUrl(reserved.asset.id),
      BadRequestException,
    );
    assert.equal(storage.putCalls.length, 1);
  });
});
