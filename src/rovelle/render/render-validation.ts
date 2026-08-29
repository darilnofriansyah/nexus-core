import { BadRequestException } from "@nestjs/common";
import type {
  CreateRenderRequestDto,
  RetryRenderRequestDto,
} from "./dto/render.dto";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requireObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new BadRequestException("request must be an object");
  }

  return value as Record<string, unknown>;
}

function requireUuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value.trim())) {
    throw new BadRequestException(`${field} must be a valid UUID`);
  }

  return value.trim();
}

function optionalUuid(value: unknown, field: string): string | null | undefined {
  if (value === null || value === undefined) return value;

  return requireUuid(value, field);
}

export function normalizeCreateRenderRequest(
  input: unknown,
): CreateRenderRequestDto {
  const request = requireObject(input);

  return {
    requestId: requireUuid(request.requestId, "requestId"),
    audioAssetId: requireUuid(request.audioAssetId, "audioAssetId"),
    captionAssetId: optionalUuid(request.captionAssetId, "captionAssetId"),
  };
}

export function normalizeRetryRenderRequest(
  input: unknown,
): RetryRenderRequestDto {
  const request = requireObject(input);

  return { requestId: requireUuid(request.requestId, "requestId") };
}
