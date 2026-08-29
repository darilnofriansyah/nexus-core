import type {
  RovelleCanonEntityType,
  RovelleCanonVersionStatus,
} from '../../../generated/prisma/client';
import type { AssetDto } from '../../assets/dto/asset.dto';

export interface CreateCanonEntityRequestDto {
  code: string;
  displayName: string;
  entityType: RovelleCanonEntityType;
  description?: string | null;
}

export interface CreateCanonVersionRequestDto {
  definition: Record<string, unknown>;
}

export interface UpdateCanonVersionRequestDto {
  definition: Record<string, unknown>;
}

export interface AttachCanonAssetRequestDto {
  assetId: string;
  role: string;
  sortOrder?: number;
}

export interface PinCanonVersionRequestDto {
  canonVersionId: string;
}

export interface CanonEntityDto {
  id: string;
  code: string;
  displayName: string;
  entityType: RovelleCanonEntityType;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CanonAssetDto {
  role: string;
  sortOrder: number;
  asset: AssetDto;
}

export interface CanonVersionDto {
  id: string;
  entityId: string;
  version: number;
  status: RovelleCanonVersionStatus;
  definition: Record<string, unknown>;
  lockedAt: string | null;
  createdAt: string;
  updatedAt: string;
  entity: CanonEntityDto;
  assets: CanonAssetDto[];
}

export interface CanonPinDto {
  source: 'EPISODE' | 'SHOT';
  version: CanonVersionDto;
}
