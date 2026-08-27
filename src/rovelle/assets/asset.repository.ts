import { Injectable } from "@nestjs/common";
import {
  RovelleAsset,
  RovelleAssetStatus,
  RovelleAssetType,
} from "../../generated/prisma/client";
import { PrismaService } from "../../database/prisma.service";

export type ReservedAssetFenceResult<T> =
  | { kind: "missing" }
  | { kind: "not_reserved"; asset: RovelleAsset }
  | { kind: "reserved"; value: T };

@Injectable()
export class AssetRepository {
  constructor(private readonly prisma: PrismaService) {}

  async episodeExists(episodeId: string): Promise<boolean> {
    const count = await this.prisma.client.rovelleEpisode.count({
      where: { id: episodeId },
    });

    return count > 0;
  }

  async createReserved(input: {
    id: string;
    episodeId: string | null;
    assetType: RovelleAssetType;
    mediaType: string;
    storageKey: string;
    originalFilename: string | null;
  }): Promise<RovelleAsset> {
    return this.prisma.client.rovelleAsset.create({
      data: {
        id: input.id,
        episodeId: input.episodeId,
        assetType: input.assetType,
        status: RovelleAssetStatus.RESERVED,
        mediaType: input.mediaType,
        storageKey: input.storageKey,
        originalFilename: input.originalFilename,
      },
    });
  }

  async findById(id: string): Promise<RovelleAsset | null> {
    return this.prisma.client.rovelleAsset.findUnique({
      where: { id },
    });
  }

  async markAvailable(
    id: string,
    metadata: { byteSize: bigint; etag: string | null },
  ): Promise<RovelleAsset | null> {
    await this.prisma.client.rovelleAsset.updateMany({
      where: {
        id,
        status: RovelleAssetStatus.RESERVED,
      },
      data: {
        status: RovelleAssetStatus.AVAILABLE,
        byteSize: metadata.byteSize,
        etag: metadata.etag,
      },
    });

    return this.findById(id);
  }

  async withReservedAsset<T>(
    id: string,
    callback: (asset: RovelleAsset) => Promise<T>,
  ): Promise<ReservedAssetFenceResult<T>> {
    return this.prisma.client.$transaction(async (tx) => {
      const locked = await tx.rovelleAsset.updateMany({
        where: {
          id,
          status: RovelleAssetStatus.RESERVED,
        },
        data: { status: RovelleAssetStatus.RESERVED },
      });
      const asset = await tx.rovelleAsset.findUnique({
        where: { id },
      });

      if (!asset) return { kind: "missing" };
      if (locked.count !== 1 || asset.status !== RovelleAssetStatus.RESERVED) {
        return { kind: "not_reserved", asset };
      }

      return {
        kind: "reserved",
        value: await callback(asset),
      };
    });
  }
}
