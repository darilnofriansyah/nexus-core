import type { RovelleAsset } from '../../generated/prisma/client';
import type { AssetDto } from './dto/asset.dto';

export function toAssetDto(asset: RovelleAsset): AssetDto {
  return {
    id: asset.id,
    episodeId: asset.episodeId,
    assetType: asset.assetType,
    status: asset.status,
    mediaType: asset.mediaType,
    originalFilename: asset.originalFilename,
    byteSize: asset.byteSize === null ? null : asset.byteSize.toString(),
    etag: asset.etag,
    createdAt: asset.createdAt.toISOString(),
    updatedAt: asset.updatedAt.toISOString(),
  };
}
