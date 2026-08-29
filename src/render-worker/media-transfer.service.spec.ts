import * as assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AssetService } from "../rovelle/assets/asset.service";
import type { AssetReadUrlDto } from "../rovelle/assets/dto/asset.dto";
import type {
  R2ObjectMetadata,
  R2PresignedRequest,
  R2StorageService,
} from "../rovelle/assets/r2-storage.service";
import {
  FrozenAssetExpectation,
  MediaTransferService,
  RenderWorkerError,
} from "./media-transfer.service";

const ASSET_ID = "550e8400-e29b-41d4-a716-446655440000";
const OTHER_ASSET_ID = "650e8400-e29b-41d4-a716-446655440000";
const STORAGE_KEY = "rovelle/private/master.mp4";
const DOWNLOAD_URL = "https://signed.example/source?secret=never-log";
const UPLOAD_URL = "https://signed.example/output?secret=never-log";
const SOURCE_BYTES = Buffer.from("frozen-source");
const OUTPUT_BYTES = Buffer.from("render-output");

const expected: FrozenAssetExpectation = {
  assetId: ASSET_ID,
  mediaType: "video/mp4",
  byteSize: SOURCE_BYTES.byteLength.toString(),
  etag: "source-etag",
};

type FetchInit = RequestInit & { duplex?: "half" };
type FakeFetch = (
  input: RequestInfo | URL,
  init?: FetchInit,
) => Promise<Response>;

class FakeAssetService {
  readonly calls: string[] = [];
  assetId = ASSET_ID;
  mediaType = expected.mediaType;
  downloadUrl = DOWNLOAD_URL;
  downloadHeaders: Record<string, string> = {};

  async createReadUrl(id: string): Promise<AssetReadUrlDto> {
    this.calls.push(id);
    return {
      asset: {
        id: this.assetId,
        episodeId: null,
        assetType: "SOURCE" as AssetReadUrlDto["asset"]["assetType"],
        status: "AVAILABLE" as AssetReadUrlDto["asset"]["status"],
        mediaType: this.mediaType,
        originalFilename: null,
        byteSize: expected.byteSize,
        etag: expected.etag,
        createdAt: "2026-08-29T00:00:00.000Z",
        updatedAt: "2026-08-29T00:00:00.000Z",
      },
      download: {
        method: "GET",
        url: this.downloadUrl,
        headers: this.downloadHeaders,
        expiresAt: "2026-08-29T00:15:00.000Z",
      },
    };
  }
}

class FakeStorageService {
  readonly events: string[] = [];
  readonly putUrlCalls: string[] = [];
  readonly headCalls: string[] = [];
  putUrl = UPLOAD_URL;
  headResult: R2ObjectMetadata | null = {
    byteSize: BigInt(OUTPUT_BYTES.byteLength),
    etag: "output-etag",
    contentType: null,
  };

  async createProviderPutUrl(key: string): Promise<R2PresignedRequest> {
    this.events.push("createProviderPutUrl");
    this.putUrlCalls.push(key);
    return {
      method: "PUT",
      url: this.putUrl,
      headers: {},
      expiresAt: "2026-08-29T00:15:00.000Z",
    };
  }

  async headObject(key: string): Promise<R2ObjectMetadata | null> {
    this.events.push("headObject");
    this.headCalls.push(key);
    return this.headResult;
  }
}

async function temporaryRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "media-transfer-test-"));
}

function createService(
  assetService: FakeAssetService,
  storage: FakeStorageService,
  fetchImpl: FakeFetch,
): MediaTransferService {
  return new MediaTransferService(
    assetService as unknown as AssetService,
    storage as unknown as R2StorageService,
    fetchImpl as unknown as typeof fetch,
  );
}

function assertWorkerError(code: string) {
  return (error: unknown): boolean =>
    error instanceof RenderWorkerError && error.code === code;
}

test("downloads each frozen asset through a just-in-time GET and streams it to disk", async () => {
  const root = await temporaryRoot();
  try {
    const assetService = new FakeAssetService();
    const storage = new FakeStorageService();
    const calls: Array<{ url: string; init?: FetchInit }> = [];
    const service = createService(assetService, storage, async (input, init) => {
      calls.push({ url: input.toString(), init });
      return new Response(SOURCE_BYTES, {
        headers: { etag: '"source-etag"' },
      });
    });
    const destinationPath = join(root, "source.mp4");

    await service.downloadFrozenAsset({ expected, destinationPath });

    assert.deepEqual(assetService.calls, [ASSET_ID]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, DOWNLOAD_URL);
    assert.equal(calls[0]?.init?.method, "GET");
    assert.deepEqual(await readFile(destinationPath), SOURCE_BYTES);
    assert.equal((await stat(destinationPath)).size, SOURCE_BYTES.byteLength);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("creates a fresh signed read URL for every frozen asset download", async () => {
  const root = await temporaryRoot();
  try {
    const assetService = new FakeAssetService();
    const storage = new FakeStorageService();
    const service = createService(assetService, storage, async () =>
      new Response(SOURCE_BYTES, { headers: { etag: "source-etag" } }),
    );

    await service.downloadFrozenAsset({
      expected,
      destinationPath: join(root, "first.mp4"),
    });
    assetService.assetId = OTHER_ASSET_ID;
    await service.downloadFrozenAsset({
      expected: { ...expected, assetId: OTHER_ASSET_ID },
      destinationPath: join(root, "second.mp4"),
    });

    assert.deepEqual(assetService.calls, [ASSET_ID, OTHER_ASSET_ID]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a non-2xx source response without exposing its signed URL", async () => {
  const root = await temporaryRoot();
  try {
    const assetService = new FakeAssetService();
    const service = createService(assetService, new FakeStorageService(), async () =>
      new Response("denied", { status: 403 }),
    );

    await assert.rejects(
      service.downloadFrozenAsset({ expected, destinationPath: join(root, "source.mp4") }),
      assertWorkerError("SOURCE_DOWNLOAD_FAILED"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a source response with no body", async () => {
  const root = await temporaryRoot();
  try {
    const service = createService(
      new FakeAssetService(),
      new FakeStorageService(),
      async () => new Response(null, { status: 200 }),
    );

    await assert.rejects(
      service.downloadFrozenAsset({ expected, destinationPath: join(root, "source.mp4") }),
      assertWorkerError("SOURCE_DOWNLOAD_FAILED"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects source metadata when the returned asset ID or media type is not frozen", async () => {
  const root = await temporaryRoot();
  try {
    const assetService = new FakeAssetService();
    const service = createService(
      assetService,
      new FakeStorageService(),
      async () => new Response(SOURCE_BYTES),
    );

    assetService.assetId = OTHER_ASSET_ID;
    await assert.rejects(
      service.downloadFrozenAsset({ expected, destinationPath: join(root, "wrong-id.mp4") }),
      assertWorkerError("SOURCE_METADATA_MISMATCH"),
    );

    assetService.assetId = ASSET_ID;
    assetService.mediaType = "image/png";
    await assert.rejects(
      service.downloadFrozenAsset({ expected, destinationPath: join(root, "wrong-type.mp4") }),
      assertWorkerError("SOURCE_METADATA_MISMATCH"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a source size mismatch", async () => {
  const root = await temporaryRoot();
  try {
    const service = createService(
      new FakeAssetService(),
      new FakeStorageService(),
      async () => new Response("different-size", { headers: { etag: "source-etag" } }),
    );

    await assert.rejects(
      service.downloadFrozenAsset({ expected, destinationPath: join(root, "source.mp4") }),
      assertWorkerError("SOURCE_SIZE_MISMATCH"),
    );
    await assert.rejects(stat(join(root, "source.mp4")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects blank, signed, hexadecimal, and non-decimal source byte size metadata", async () => {
  const root = await temporaryRoot();
  try {
    for (const [index, byteSize] of ["", " ", "0x0d", "+13", "-13", "13.5"].entries()) {
      const service = createService(
        new FakeAssetService(),
        new FakeStorageService(),
        async () => new Response(SOURCE_BYTES, { headers: { etag: "source-etag" } }),
      );

      await assert.rejects(
        service.downloadFrozenAsset({
          expected: { ...expected, byteSize },
          destinationPath: join(root, `source-${index}.mp4`),
        }),
        assertWorkerError("SOURCE_METADATA_MISMATCH"),
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a present source ETag mismatch after normalizing quotes", async () => {
  const root = await temporaryRoot();
  try {
    const service = createService(
      new FakeAssetService(),
      new FakeStorageService(),
      async () => new Response(SOURCE_BYTES, { headers: { etag: '"different-etag"' } }),
    );

    await assert.rejects(
      service.downloadFrozenAsset({ expected, destinationPath: join(root, "source.mp4") }),
      assertWorkerError("SOURCE_ETAG_MISMATCH"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("removes a partial destination after a streaming download failure", async () => {
  const root = await temporaryRoot();
  try {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("partial"));
        controller.error(new Error("stream failed"));
      },
    });
    const service = createService(
      new FakeAssetService(),
      new FakeStorageService(),
      async () => new Response(body),
    );
    const destinationPath = join(root, "source.mp4");

    await assert.rejects(
      service.downloadFrozenAsset({ expected, destinationPath }),
      assertWorkerError("SOURCE_DOWNLOAD_FAILED"),
    );
    await assert.rejects(stat(destinationPath));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a missing output file", async () => {
  const root = await temporaryRoot();
  try {
    const service = createService(new FakeAssetService(), new FakeStorageService(), async () =>
      new Response(null),
    );

    await assert.rejects(
      service.uploadRenderOutput({ storageKey: STORAGE_KEY, sourcePath: join(root, "missing.mp4") }),
      assertWorkerError("OUTPUT_UPLOAD_FAILED"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a zero-byte output file", async () => {
  const root = await temporaryRoot();
  try {
    const sourcePath = join(root, "empty.mp4");
    await writeFile(sourcePath, "");
    const storage = new FakeStorageService();
    const service = createService(new FakeAssetService(), storage, async () =>
      new Response(null),
    );

    await assert.rejects(
      service.uploadRenderOutput({ storageKey: STORAGE_KEY, sourcePath }),
      assertWorkerError("OUTPUT_UPLOAD_FAILED"),
    );
    assert.deepEqual(storage.putUrlCalls, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("streams a PUT with no Content-Type requirement and verifies its R2 HEAD", async () => {
  const root = await temporaryRoot();
  try {
    const sourcePath = join(root, "master.mp4");
    await writeFile(sourcePath, OUTPUT_BYTES);
    const storage = new FakeStorageService();
    const calls: Array<{ url: string; init?: FetchInit }> = [];
    const service = createService(new FakeAssetService(), storage, async (input, init) => {
      calls.push({ url: input.toString(), init });
      storage.events.push("put");
      return new Response(null, { status: 200 });
    });

    const result = await service.uploadRenderOutput({ storageKey: STORAGE_KEY, sourcePath });

    assert.deepEqual(storage.putUrlCalls, [STORAGE_KEY]);
    assert.deepEqual(storage.headCalls, [STORAGE_KEY]);
    assert.deepEqual(storage.events, ["createProviderPutUrl", "put", "headObject"]);
    assert.equal(calls[0]?.url, UPLOAD_URL);
    assert.equal(calls[0]?.init?.method, "PUT");
    assert.equal(calls[0]?.init?.headers, undefined);
    assert.equal(calls[0]?.init?.duplex, "half");
    assert.ok(calls[0]?.init?.body instanceof Object);
    assert.equal(typeof (calls[0]?.init?.body as { pipe?: unknown })?.pipe, "function");
    assert.deepEqual(result, { byteSize: BigInt(OUTPUT_BYTES.byteLength), etag: "output-etag" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a non-2xx output upload without exposing its signed URL", async () => {
  const root = await temporaryRoot();
  try {
    const sourcePath = join(root, "master.mp4");
    await writeFile(sourcePath, OUTPUT_BYTES);
    const service = createService(new FakeAssetService(), new FakeStorageService(), async () =>
      new Response("denied", { status: 500 }),
    );

    await assert.rejects(
      service.uploadRenderOutput({ storageKey: STORAGE_KEY, sourcePath }),
      assertWorkerError("OUTPUT_UPLOAD_FAILED"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a missing, empty, or size-mismatched R2 output during HEAD verification", async () => {
  const root = await temporaryRoot();
  try {
    const sourcePath = join(root, "master.mp4");
    await writeFile(sourcePath, OUTPUT_BYTES);
    const storage = new FakeStorageService();
    const service = createService(new FakeAssetService(), storage, async () =>
      new Response(null, { status: 200 }),
    );

    for (const headResult of [
      null,
      { byteSize: 0n, etag: "empty", contentType: null },
      { byteSize: 1n, etag: "wrong-size", contentType: null },
    ] satisfies Array<R2ObjectMetadata | null>) {
      storage.headResult = headResult;
      await assert.rejects(
        service.uploadRenderOutput({ storageKey: STORAGE_KEY, sourcePath }),
        assertWorkerError("OUTPUT_VERIFY_FAILED"),
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
