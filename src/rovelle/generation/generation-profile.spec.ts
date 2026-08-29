import * as assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { BadRequestException } from '@nestjs/common';
import {
  Prisma,
  RovelleGenerationModality,
  RovelleGenerationProfile,
  RovelleGenerationProvider,
  RovelleGenerationStatus,
  type RovelleShotGeneration,
} from '../../generated/prisma/client';
import type {
  GenerationAttemptDto,
  SubmitShotGenerationRequestDto,
} from './dto/generation.dto';
import {
  estimateGenerationCostUsd,
  getGenerationProfile,
  normalizeSubmitGenerationRequest,
  toGenerationAttemptDto,
} from './generation-profile';

const REQUEST_ID = '550e8400-e29b-41d4-a716-446655440000';

function assertBadRequest(action: () => unknown): void {
  assert.throws(action, BadRequestException);
}

describe('Rovelle video generation profiles', () => {
  test('defines the DRAFT profile exactly', () => {
    assert.deepEqual(getGenerationProfile('DRAFT'), {
      width: 480,
      height: 854,
      usdPerSecond: '0.115',
      pricingSource: 'RUNWARE_SEEDANCE_2_5_2026_08_28',
    });
  });

  test('defines the PRODUCTION profile exactly', () => {
    assert.deepEqual(getGenerationProfile('PRODUCTION'), {
      width: 720,
      height: 1280,
      usdPerSecond: '0.249',
      pricingSource: 'RUNWARE_SEEDANCE_2_5_2026_08_28',
    });
  });

  test('estimates costs as six-place decimal strings without binary rounding', () => {
    assert.equal(estimateGenerationCostUsd('DRAFT', 4), '0.460000');
    assert.equal(estimateGenerationCostUsd('PRODUCTION', 5), '1.245000');
    assert.equal(estimateGenerationCostUsd('DRAFT', 30), '3.450000');
  });

  test('keeps profile specifications frozen at runtime', () => {
    const profile = getGenerationProfile('DRAFT');

    assert.equal(Object.isFrozen(profile), true);
    assert.throws(() => {
      (profile as { width: number }).width = 999;
    }, TypeError);
    assert.equal(getGenerationProfile('DRAFT').width, 480);
  });

  test('rejects unsupported profiles and durations', () => {
    for (const profile of ['UNKNOWN', '', 1, null, undefined]) {
      assertBadRequest(() => getGenerationProfile(profile as never));
    }

    for (const duration of [3, 31, 4.5, 0, -1, '4', null, undefined]) {
      assertBadRequest(() =>
        estimateGenerationCostUsd('DRAFT', duration as never),
      );
    }
  });

  test('normalizes a UUID request and supported profile', () => {
    const normalized = normalizeSubmitGenerationRequest({
      requestId: `  ${REQUEST_ID}  `,
      profile: 'DRAFT',
    });

    const expected: SubmitShotGenerationRequestDto = {
      requestId: REQUEST_ID,
      profile: 'DRAFT',
    };
    assert.deepEqual(normalized, expected);
  });

  test('rejects malformed request IDs and unknown request profiles', () => {
    for (const requestId of [
      '',
      'not-a-uuid',
      '00000000-0000-0000-0000-000000000000',
      '123e4567-e89b-02d3-a456-426614174000',
      1,
      null,
      undefined,
    ]) {
      assertBadRequest(() =>
        normalizeSubmitGenerationRequest({ requestId, profile: 'DRAFT' }),
      );
    }

    for (const profile of ['', 'draft', 'UNKNOWN', 1, null, undefined]) {
      assertBadRequest(() =>
        normalizeSubmitGenerationRequest({ requestId: REQUEST_ID, profile }),
      );
    }
  });

  test('maps Decimal costs and timestamps to the external attempt DTO', () => {
    const generation = {
      id: '123e4567-e89b-42d3-a456-426614174000',
      clientRequestId: REQUEST_ID,
      shotId: '123e4567-e89b-42d3-a456-426614174001',
      attempt: 1,
      provider: RovelleGenerationProvider.RUNWARE,
      modality: RovelleGenerationModality.VIDEO,
      profile: RovelleGenerationProfile.DRAFT,
      model: 'bytedance:seedance@2.5',
      providerTaskId: '123e4567-e89b-42d3-a456-426614174002',
      prompt: 'private prompt',
      request: { width: 480 },
      status: RovelleGenerationStatus.SUBMITTED,
      outputAssetId: '123e4567-e89b-42d3-a456-426614174003',
      estimatedCostUsd: new Prisma.Decimal('0.460000'),
      pricingSource: 'RUNWARE_SEEDANCE_2_5_2026_08_28',
      actualCostUsd: new Prisma.Decimal('1.245'),
      errorCode: null,
      errorMessage: null,
      submittedAt: new Date('2026-08-28T00:00:01.000Z'),
      completedAt: null,
      createdAt: new Date('2026-08-28T00:00:00.000Z'),
      updatedAt: new Date('2026-08-28T00:00:01.000Z'),
    } as RovelleShotGeneration;

    const mapped = toGenerationAttemptDto(generation);
    const expected: GenerationAttemptDto = {
      id: generation.id,
      clientRequestId: generation.clientRequestId,
      shotId: generation.shotId,
      attempt: generation.attempt,
      provider: generation.provider,
      modality: generation.modality,
      profile: generation.profile,
      model: generation.model,
      providerTaskId: generation.providerTaskId,
      status: generation.status,
      outputAssetId: generation.outputAssetId,
      estimatedCostUsd: '0.460000',
      pricingSource: generation.pricingSource,
      actualCostUsd: '1.245000',
      errorCode: null,
      errorMessage: null,
      submittedAt: '2026-08-28T00:00:01.000Z',
      completedAt: null,
      createdAt: '2026-08-28T00:00:00.000Z',
      updatedAt: '2026-08-28T00:00:01.000Z',
    };

    assert.deepEqual(mapped, expected);
    assert.equal('prompt' in mapped, false);
    assert.equal('request' in mapped, false);
  });
});
