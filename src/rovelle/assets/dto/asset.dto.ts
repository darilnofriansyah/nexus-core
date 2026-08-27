import type {
  RovelleAssetStatus,
  RovelleAssetType,
} from '../../../generated/prisma/client';
import type { R2PresignedRequest } from '../r2-storage.service';

export interface CreateAssetReservationRequestDto {
  assetType: RovelleAssetType;
  mediaType: string;
  originalFilename?: string | null;
  episodeId?: string | null;
}

export interface AssetDto {
  id: string;
  episodeId: string | null;
  assetType: RovelleAssetType;
  status: RovelleAssetStatus;
  mediaType: string;
  originalFilename: string | null;
  byteSize: string | null;
  etag: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AssetReservationDto {
  asset: AssetDto;
  upload: R2PresignedRequest;
}

export interface AssetReadUrlDto {
  asset: AssetDto;
  read: R2PresignedRequest;
}
