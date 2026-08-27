import { randomUUID } from "node:crypto";
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  RovelleAsset,
  RovelleAssetStatus,
} from "../../generated/prisma/client";
import type {
  AssetDto,
  AssetReadUrlDto,
  AssetReservationDto,
  CreateAssetReservationRequestDto,
} from "./dto/asset.dto";
import { toAssetDto } from "./asset-mapper";
import {
  normalizeAssetReservationRequest,
  buildAssetStorageKey,
} from "./asset-validation";
import { AssetRepository } from "./asset.repository";
import { R2StorageService } from "./r2-storage.service";

@Injectable()
export class AssetService {
  constructor(
    private readonly repository: AssetRepository,
    private readonly storage: R2StorageService,
  ) {}

  async reserve(
    request: CreateAssetReservationRequestDto,
  ): Promise<AssetReservationDto> {
    const normalized = normalizeAssetReservationRequest(request);
    this.storage.assertConfigured();

    if (
      normalized.episodeId &&
      !(await this.repository.episodeExists(normalized.episodeId))
    ) {
      throw new NotFoundException("Rovelle episode not found");
    }

    const id = randomUUID();
    const asset = await this.repository.createReserved({
      id,
      episodeId: normalized.episodeId ?? null,
      assetType: normalized.assetType,
      mediaType: normalized.mediaType,
      storageKey: buildAssetStorageKey(id),
      originalFilename: normalized.originalFilename ?? null,
    });
    const upload = await this.storage.createPutUrl(
      asset.storageKey,
      asset.mediaType,
    );

    return { asset: toAssetDto(asset), upload };
  }

  async getAsset(id: string): Promise<AssetDto> {
    return toAssetDto(await this.findAssetOrThrow(id));
  }

  async createUploadUrl(id: string): Promise<AssetReservationDto> {
    const asset = await this.findAssetOrThrow(id);

    if (asset.status !== RovelleAssetStatus.RESERVED) {
      throw new BadRequestException("Available assets cannot be overwritten");
    }

    const upload = await this.storage.createPutUrl(
      asset.storageKey,
      asset.mediaType,
    );
    return { asset: toAssetDto(asset), upload };
  }

  async confirmUpload(id: string): Promise<AssetDto> {
    const asset = await this.findAssetOrThrow(id);

    if (asset.status === RovelleAssetStatus.AVAILABLE) {
      return toAssetDto(asset);
    }

    const metadata = await this.storage.headObject(asset.storageKey);
    if (!metadata) {
      throw new BadRequestException("R2 object is not available");
    }
    if (metadata.byteSize === 0n) {
      throw new BadRequestException("R2 object is empty");
    }
    if (
      metadata.contentType !== null &&
      metadata.contentType.trim().toLowerCase() !==
        asset.mediaType.toLowerCase()
    ) {
      throw new BadRequestException(
        "R2 object content type does not match asset",
      );
    }

    const updated = await this.repository.markAvailable(id, {
      byteSize: metadata.byteSize,
      etag: metadata.etag,
    });
    if (!updated || updated.status !== RovelleAssetStatus.AVAILABLE) {
      throw new BadRequestException("Asset state changed before confirmation");
    }

    return toAssetDto(updated);
  }

  async createReadUrl(id: string): Promise<AssetReadUrlDto> {
    const asset = await this.findAssetOrThrow(id);

    if (asset.status !== RovelleAssetStatus.AVAILABLE) {
      throw new BadRequestException("Asset is not available for reading");
    }

    const read = await this.storage.createGetUrl(asset.storageKey);
    return { asset: toAssetDto(asset), read };
  }

  private async findAssetOrThrow(id: string): Promise<RovelleAsset> {
    const asset = await this.repository.findById(id);

    if (!asset) {
      throw new NotFoundException("Rovelle asset not found");
    }

    return asset;
  }
}
