import { BadRequestException } from '@nestjs/common';
import { RovelleAssetType } from '../../generated/prisma/client';
import type { CreateAssetReservationRequestDto } from './dto/asset.dto';

const MEDIA_TYPE_PATTERN =
  /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ASSET_TYPES = new Set<RovelleAssetType>(
  Object.values(RovelleAssetType) as RovelleAssetType[],
);

function requireObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new BadRequestException('request must be an object');
  }

  return value as Record<string, unknown>;
}

function requireAssetType(value: unknown): RovelleAssetType {
  if (typeof value !== 'string' || !ASSET_TYPES.has(value as RovelleAssetType)) {
    throw new BadRequestException('assetType must be a valid Rovelle asset type');
  }

  return value as RovelleAssetType;
}

function requireMediaType(value: unknown): string {
  if (typeof value !== 'string') {
    throw new BadRequestException('mediaType must be a string');
  }

  const normalized = value.trim().toLowerCase();
  if (
    normalized.length === 0 ||
    normalized.length > 127 ||
    !MEDIA_TYPE_PATTERN.test(normalized)
  ) {
    throw new BadRequestException(
      'mediaType must be a valid type/subtype of at most 127 characters',
    );
  }

  return normalized;
}

function optionalTrimmedString(
  value: unknown,
  field: string,
  maxLength: number,
): string | null | undefined {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'string') {
    throw new BadRequestException(`${field} must be a string`);
  }

  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new BadRequestException(
      `${field} must be at most ${maxLength} characters`,
    );
  }

  return normalized;
}

function optionalUuid(value: unknown, field: string): string | null | undefined {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'string' || !UUID_PATTERN.test(value.trim())) {
    throw new BadRequestException(`${field} must be a valid UUID`);
  }

  return value.trim();
}

export function normalizeAssetReservationRequest(
  input: unknown,
): CreateAssetReservationRequestDto {
  const request = requireObject(input);

  return {
    assetType: requireAssetType(request.assetType),
    mediaType: requireMediaType(request.mediaType),
    originalFilename: optionalTrimmedString(
      request.originalFilename,
      'originalFilename',
      255,
    ),
    episodeId: optionalUuid(request.episodeId, 'episodeId'),
  };
}

export function buildAssetStorageKey(assetId: string): string {
  assertAssetId(assetId);

  return `ringmaster/assets/${assetId}`;
}

export function assertAssetId(assetId: string): void {
  if (typeof assetId !== 'string' || !UUID_PATTERN.test(assetId)) {
    throw new BadRequestException('assetId must be a valid UUID');
  }
}
