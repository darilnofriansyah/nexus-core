import { BadRequestException } from '@nestjs/common';
import type {
  CreateEpisodeRequestDto,
  ReplaceEpisodeShotsRequestDto,
  ShotInputDto,
  UpdateEpisodeBriefRequestDto,
} from './dto/episode.dto';

function requireObject(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new BadRequestException(`${field} must be an object`);
  }

  return value as Record<string, unknown>;
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

function optionalPositiveInteger(
  value: unknown,
  field: string,
  maxValue: number,
): number | null | undefined {
  if (value === null || value === undefined) {
    return value;
  }

  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > maxValue
  ) {
    throw new BadRequestException(
      `${field} must be an integer from 1 to ${maxValue}`,
    );
  }

  return value;
}

function requirePositiveInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new BadRequestException(
      `${field} must be an integer greater than or equal to 1`,
    );
  }

  return value;
}

export function normalizeCreateEpisodeRequest(
  input: unknown,
): CreateEpisodeRequestDto {
  const request = requireObject(input, 'request');

  return {
    code: requireTrimmedString(request.code, 'code', 32),
    title: requireTrimmedString(request.title, 'title', 200),
    targetDurationSeconds: optionalPositiveInteger(
      request.targetDurationSeconds,
      'targetDurationSeconds',
      3600,
    ),
  };
}

export function normalizeBriefRequest(
  input: unknown,
): UpdateEpisodeBriefRequestDto {
  const request = requireObject(input, 'request');
  const brief = request.brief;

  if (
    brief === null ||
    typeof brief !== 'object' ||
    Array.isArray(brief) ||
    Object.keys(brief).length === 0
  ) {
    throw new BadRequestException('brief must be a non-empty object');
  }

  return { brief: { ...(brief as Record<string, unknown>) } };
}

export function normalizeShotsRequest(
  input: unknown,
): ReplaceEpisodeShotsRequestDto {
  const request = requireObject(input, 'request');

  if (!Array.isArray(request.shots)) {
    throw new BadRequestException('shots must be an array');
  }

  const sequences = new Set<number>();
  const shots: ShotInputDto[] = [];

  for (const [index, value] of request.shots.entries()) {
    const shot = requireObject(value, `shots[${index}]`);
    const sequence = requirePositiveInteger(
      shot.sequence,
      `shots[${index}].sequence`,
    );

    if (sequences.has(sequence)) {
      throw new BadRequestException(
        `shots[${index}].sequence must be unique`,
      );
    }
    sequences.add(sequence);

    shots.push({
      sequence,
      name: optionalTrimmedString(shot.name, `shots[${index}].name`, 120),
      direction: requireTrimmedString(
        shot.direction,
        `shots[${index}].direction`,
        4000,
      ),
      targetDurationSeconds: optionalPositiveInteger(
        shot.targetDurationSeconds,
        `shots[${index}].targetDurationSeconds`,
        300,
      ),
    });
  }

  return { shots };
}
