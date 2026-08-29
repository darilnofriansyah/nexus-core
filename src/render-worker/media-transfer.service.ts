import { createReadStream, createWriteStream } from "node:fs";
import { rm, stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";

import { Injectable, Optional } from "@nestjs/common";

import { AssetService } from "../rovelle/assets/asset.service";
import {
  R2StorageService,
  type R2ObjectMetadata,
} from "../rovelle/assets/r2-storage.service";

export interface FrozenAssetExpectation {
  assetId: string;
  mediaType: string;
  byteSize: string;
  etag: string | null;
}

export class RenderWorkerError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RenderWorkerError";
  }
}

type StreamingRequestInit = RequestInit & { duplex: "half" };

@Injectable()
export class MediaTransferService {
  constructor(
    private readonly assetService: AssetService,
    private readonly storage: R2StorageService,
    @Optional()
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async downloadFrozenAsset(input: {
    expected: FrozenAssetExpectation;
    destinationPath: string;
  }): Promise<void> {
    let removeOnFailure = false;

    try {
      removeOnFailure = !(await pathExists(input.destinationPath));
      const readUrl = await this.assetService.createReadUrl(
        input.expected.assetId,
      );
      assertFrozenAssetMetadata(readUrl.asset, input.expected);

      const response = await this.fetchImpl(readUrl.download.url, {
        method: "GET",
        headers: readUrl.download.headers,
      });
      if (response.status < 200 || response.status >= 300) {
        throw new RenderWorkerError(
          "SOURCE_DOWNLOAD_FAILED",
          "Frozen asset download failed",
        );
      }
      if (!response.body) {
        throw new RenderWorkerError(
          "SOURCE_DOWNLOAD_FAILED",
          "Frozen asset response has no body",
        );
      }

      await pipeline(
        Readable.fromWeb(
          response.body as unknown as NodeReadableStream<Uint8Array>,
        ),
        createWriteStream(input.destinationPath, { flags: "wx" }),
      );

      const downloaded = await stat(input.destinationPath, { bigint: true });
      const expectedByteSize = parseExpectedByteSize(input.expected.byteSize);
      if (downloaded.size !== expectedByteSize) {
        throw new RenderWorkerError(
          "SOURCE_SIZE_MISMATCH",
          "Frozen asset size does not match its metadata",
        );
      }

      const responseEtag = response.headers.get("etag");
      if (
        input.expected.etag !== null &&
        responseEtag !== null &&
        normalizeEtag(input.expected.etag) !== normalizeEtag(responseEtag)
      ) {
        throw new RenderWorkerError(
          "SOURCE_ETAG_MISMATCH",
          "Frozen asset ETag does not match its metadata",
        );
      }
    } catch (error) {
      await removePartialFile(input.destinationPath, removeOnFailure);
      if (error instanceof RenderWorkerError) throw error;
      throw new RenderWorkerError(
        "SOURCE_DOWNLOAD_FAILED",
        "Frozen asset download failed",
      );
    }
  }

  async uploadRenderOutput(input: {
    storageKey: string;
    sourcePath: string;
  }): Promise<{ byteSize: bigint; etag: string | null }> {
    let localByteSize: bigint;
    try {
      const source = await stat(input.sourcePath, { bigint: true });
      if (!source.isFile() || source.size === 0n) {
        throw new RenderWorkerError(
          "OUTPUT_UPLOAD_FAILED",
          "Render output must be a non-empty file",
        );
      }
      localByteSize = source.size;
    } catch (error) {
      if (error instanceof RenderWorkerError) throw error;
      throw new RenderWorkerError(
        "OUTPUT_UPLOAD_FAILED",
        "Render output upload failed",
      );
    }

    let putUrl: string;
    try {
      putUrl = (
        await this.storage.createProviderPutUrl(input.storageKey)
      ).url;
    } catch {
      throw new RenderWorkerError(
        "OUTPUT_UPLOAD_FAILED",
        "Render output upload failed",
      );
    }

    try {
      const response = await this.fetchImpl(
        putUrl,
        {
          method: "PUT",
          body: createReadStream(input.sourcePath),
          duplex: "half",
        } as unknown as StreamingRequestInit,
      );
      if (response.status < 200 || response.status >= 300) {
        throw new RenderWorkerError(
          "OUTPUT_UPLOAD_FAILED",
          "Render output upload failed",
        );
      }
    } catch (error) {
      if (error instanceof RenderWorkerError) throw error;
      throw new RenderWorkerError(
        "OUTPUT_UPLOAD_FAILED",
        "Render output upload failed",
      );
    }

    let metadata: R2ObjectMetadata | null;
    try {
      metadata = await this.storage.headObject(input.storageKey);
    } catch {
      throw new RenderWorkerError(
        "OUTPUT_VERIFY_FAILED",
        "Render output verification failed",
      );
    }
    if (
      !metadata ||
      metadata.byteSize === 0n ||
      metadata.byteSize !== localByteSize
    ) {
      throw new RenderWorkerError(
        "OUTPUT_VERIFY_FAILED",
        "Render output verification failed",
      );
    }

    return { byteSize: metadata.byteSize, etag: metadata.etag };
  }
}

function assertFrozenAssetMetadata(
  asset: { id: string; mediaType: string },
  expected: FrozenAssetExpectation,
): void {
  if (asset.id !== expected.assetId || asset.mediaType !== expected.mediaType) {
    throw new RenderWorkerError(
      "SOURCE_METADATA_MISMATCH",
      "Frozen asset metadata does not match its expectation",
    );
  }
}

function parseExpectedByteSize(value: string): bigint {
  try {
    const byteSize = BigInt(value);
    if (byteSize < 0n) throw new Error("negative byte size");
    return byteSize;
  } catch {
    throw new RenderWorkerError(
      "SOURCE_METADATA_MISMATCH",
      "Frozen asset byte size metadata is invalid",
    );
  }
}

function normalizeEtag(value: string): string {
  return value.trim().replace(/^"|"$/g, "");
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isErrno(error, "ENOENT")) return false;
    throw error;
  }
}

async function removePartialFile(path: string, shouldRemove: boolean): Promise<void> {
  if (!shouldRemove) return;
  try {
    await rm(path, { force: true });
  } catch {
    // Preserve the transfer error when best-effort cleanup cannot finish.
  }
}

function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}
