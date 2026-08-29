import { BadRequestException } from '@nestjs/common';
import { RovelleCanonEntityType } from '../../generated/prisma/client';
import type {
  AttachCanonAssetRequestDto,
  CreateCanonEntityRequestDto,
  CreateCanonVersionRequestDto,
  PinCanonVersionRequestDto,
} from './dto/canon.dto';

const CANON_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CANON_ENTITY_TYPES = new Set<RovelleCanonEntityType>(
  Object.values(RovelleCanonEntityType) as RovelleCanonEntityType[],
);

function requireObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new BadRequestException('request must be an object');
  }

  return value as Record<string, unknown>;
}

function requireCanonCode(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new BadRequestException(`${field} must be a string`);
  }

  const normalized = value.trim().toUpperCase();
  if (!CANON_CODE_PATTERN.test(normalized)) {
    throw new BadRequestException(
      `${field} must match ^[A-Z][A-Z0-9_]{0,63}$`,
    );
  }

  return normalized;
}

function requireTrimmedString(
  value: unknown,
  field: string,
  maxLength: number,
): string {
  if (typeof value !== 'string') {
    throw new BadRequestException(`${field} must be a string`);
  }

  const normalized = value.trim();
  if (!normalized) {
    throw new BadRequestException(`${field} is required`);
  }
  if (normalized.length > maxLength) {
    throw new BadRequestException(
      `${field} must be at most ${maxLength} characters`,
    );
  }

  return normalized;
}

function optionalTrimmedString(
  value: unknown,
  field: string,
  maxLength: number,
): string | null | undefined {
  if (value === null || value === undefined) {
    return value;
  }
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

function requireEntityType(value: unknown): RovelleCanonEntityType {
  if (
    typeof value !== 'string' ||
    !CANON_ENTITY_TYPES.has(value as RovelleCanonEntityType)
  ) {
    throw new BadRequestException(
      'entityType must be a valid Rovelle canon entity type',
    );
  }

  return value as RovelleCanonEntityType;
}

function requireUuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value.trim())) {
    throw new BadRequestException(`${field} must be a valid UUID`);
  }

  return value.trim();
}

function requireDefinition(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new BadRequestException(
      'definition must be a non-empty plain object',
    );
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new BadRequestException(
      'definition must be a non-empty plain object',
    );
  }

  const definition = value as Record<string, unknown>;
  if (Object.keys(definition).length === 0) {
    throw new BadRequestException(
      'definition must be a non-empty plain object',
    );
  }

  return { ...definition };
}

function requireSortOrder(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > 999
  ) {
    throw new BadRequestException('sortOrder must be an integer from 0 to 999');
  }

  return value;
}

export function normalizeCreateCanonEntityRequest(
  input: unknown,
): CreateCanonEntityRequestDto {
  const request = requireObject(input);

  return {
    code: requireCanonCode(request.code, 'code'),
    displayName: requireTrimmedString(request.displayName, 'displayName', 120),
    entityType: requireEntityType(request.entityType),
    description: optionalTrimmedString(request.description, 'description', 4000),
  };
}

export function normalizeCanonVersionRequest(
  input: unknown,
): CreateCanonVersionRequestDto {
  const request = requireObject(input);

  return { definition: requireDefinition(request.definition) };
}

export function normalizeAttachCanonAssetRequest(
  input: unknown,
): AttachCanonAssetRequestDto {
  const request = requireObject(input);

  return {
    assetId: requireUuid(request.assetId, 'assetId'),
    role: requireCanonCode(request.role, 'role'),
    sortOrder:
      request.sortOrder === undefined ? 0 : requireSortOrder(request.sortOrder),
  };
}

export function normalizePinCanonVersionRequest(
  input: unknown,
): PinCanonVersionRequestDto {
  const request = requireObject(input);

  return {
    canonVersionId: requireUuid(request.canonVersionId, 'canonVersionId'),
  };
}
