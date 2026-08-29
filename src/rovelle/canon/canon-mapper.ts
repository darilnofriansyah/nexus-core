import type {
  RovelleAsset,
  RovelleCanonAsset,
  RovelleCanonEntity,
  RovelleCanonVersion,
} from '../../generated/prisma/client';
import { toAssetDto } from '../assets/asset-mapper';
import type {
  CanonEntityDto,
  CanonVersionDto,
} from './dto/canon.dto';

export type CanonVersionWithAssets = RovelleCanonVersion & {
  entity: RovelleCanonEntity;
  assets: Array<RovelleCanonAsset & { asset: RovelleAsset }>;
};

export function toCanonEntityDto(entity: RovelleCanonEntity): CanonEntityDto {
  return {
    id: entity.id,
    code: entity.code,
    displayName: entity.displayName,
    entityType: entity.entityType,
    description: entity.description,
    createdAt: entity.createdAt.toISOString(),
    updatedAt: entity.updatedAt.toISOString(),
  };
}

export function toCanonVersionDto(
  version: CanonVersionWithAssets,
): CanonVersionDto {
  const assets = [...version.assets].sort((left, right) => {
    return (
      left.sortOrder - right.sortOrder ||
      compareStrings(left.role, right.role) ||
      compareStrings(left.asset.id, right.asset.id)
    );
  });

  return {
    id: version.id,
    entityId: version.entityId,
    version: version.version,
    status: version.status,
    definition: version.definition as Record<string, unknown>,
    lockedAt: version.lockedAt?.toISOString() ?? null,
    createdAt: version.createdAt.toISOString(),
    updatedAt: version.updatedAt.toISOString(),
    entity: toCanonEntityDto(version.entity),
    assets: assets.map((attachment) => ({
      role: attachment.role,
      sortOrder: attachment.sortOrder,
      asset: toAssetDto(attachment.asset),
    })),
  };
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
