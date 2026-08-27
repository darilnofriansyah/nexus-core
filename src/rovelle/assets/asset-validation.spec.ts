import * as assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { BadRequestException } from '@nestjs/common';
import {
  RovelleAssetType,
  type RovelleAssetType as RovelleAssetTypeValue,
} from '../../generated/prisma/client';
import type { CreateAssetReservationRequestDto } from './dto/asset.dto';
import {
  buildAssetStorageKey,
  normalizeAssetReservationRequest,
} from './asset-validation';

const ASSET_ID = '550e8400-e29b-41d4-a716-446655440000';
const EPISODE_ID = '123e4567-e89b-12d3-a456-426614174000';

function assertBadRequest(action: () => unknown): void {
  assert.throws(action, BadRequestException);
}

function request(
  overrides: Partial<CreateAssetReservationRequestDto> = {},
): CreateAssetReservationRequestDto {
  return {
    assetType: RovelleAssetType.SOURCE,
    mediaType: 'text/plain',
    ...overrides,
  };
}

describe('Rovelle asset input validation', () => {
  test('accepts only the generated asset type enum values', () => {
    for (const assetType of Object.values(RovelleAssetType)) {
      const normalized = normalizeAssetReservationRequest(request({ assetType }));

      assert.equal(normalized.assetType, assetType);
    }

    for (const assetType of [
      '',
      'source',
      ' SOURCE ',
      'UNKNOWN',
      1,
      null,
      undefined,
    ]) {
      assertBadRequest(() =>
        normalizeAssetReservationRequest(
          request({ assetType: assetType as RovelleAssetTypeValue }),
        ),
      );
    }
  });

  test('trims and lowercases a valid media type', () => {
    const normalized = normalizeAssetReservationRequest(
      request({ mediaType: '  Application/Vnd.Acme+JSON  ' }),
    );

    assert.equal(normalized.mediaType, 'application/vnd.acme+json');
  });

  test('enforces the exact media type pattern and 127-character limit', () => {
    const maximum = `${'a'.repeat(63)}/${'b'.repeat(63)}`;
    assert.equal(maximum.length, 127);
    assert.equal(normalizeAssetReservationRequest(request({ mediaType: maximum })).mediaType, maximum);

    for (const mediaType of [
      '',
      'plain',
      '/plain',
      'text/',
      'text/plain; charset=utf-8',
      '*/*',
      `${'a'.repeat(64)}/${'b'.repeat(63)}`,
      1,
      null,
      undefined,
    ]) {
      assertBadRequest(() =>
        normalizeAssetReservationRequest(
          request({ mediaType: mediaType as string }),
        ),
      );
    }
  });

  test('normalizes optional filenames and accepts the 255-character boundary', () => {
    const normalized = normalizeAssetReservationRequest(
      request({
        originalFilename: '  source.mp4  ',
        episodeId: `  ${EPISODE_ID}  `,
      }),
    );

    assert.equal(normalized.originalFilename, 'source.mp4');
    assert.equal(normalized.episodeId, EPISODE_ID);
    assert.equal(
      normalizeAssetReservationRequest(
        request({ originalFilename: 'x'.repeat(255) }),
      ).originalFilename,
      'x'.repeat(255),
    );

    for (const originalFilename of [
      'x'.repeat(256),
      1,
      {},
      [],
    ]) {
      assertBadRequest(() =>
        normalizeAssetReservationRequest(
          request({ originalFilename: originalFilename as string }),
        ),
      );
    }

    assert.equal(
      normalizeAssetReservationRequest(request({ originalFilename: null }))
        .originalFilename,
      null,
    );
    assert.equal(
      normalizeAssetReservationRequest(request()).originalFilename,
      undefined,
    );
  });

  test('requires a generic UUID for an optional episode ID', () => {
    for (const episodeId of [
      EPISODE_ID,
      '123e4567-e89b-52d3-a456-426614174000',
      '123E4567-E89B-52D3-A456-426614174000',
    ]) {
      assert.equal(
        normalizeAssetReservationRequest(request({ episodeId })).episodeId,
        episodeId,
      );
    }

    for (const episodeId of [
      '',
      '00000000-0000-0000-0000-000000000000',
      '123e4567-e89b-02d3-a456-426614174000',
      '123e4567-e89b-42d3-c456-426614174000',
      '123e4567e89b42d3a456426614174000',
      'not-a-uuid',
      1,
      {},
      [],
    ]) {
      assertBadRequest(() =>
        normalizeAssetReservationRequest(
          request({ episodeId: episodeId as string }),
        ),
      );
    }

    assert.equal(
      normalizeAssetReservationRequest(request({ episodeId: null })).episodeId,
      null,
    );
    assert.equal(normalizeAssetReservationRequest(request()).episodeId, undefined);
  });

  test('does not carry caller storage keys into the normalized request', () => {
    const normalized = normalizeAssetReservationRequest({
      ...request(),
      storageKey: 'caller/chosen-key',
    } as CreateAssetReservationRequestDto & { storageKey: string });

    assert.deepEqual(normalized, {
      ...request(),
      originalFilename: undefined,
      episodeId: undefined,
    });
    assert.equal('storageKey' in normalized, false);
  });

  test('rejects malformed request containers', () => {
    for (const input of [null, [], 'request', 1, false]) {
      assertBadRequest(() => normalizeAssetReservationRequest(input));
    }
  });

  test('builds the Core-owned storage key from a UUID asset ID', () => {
    assert.equal(
      buildAssetStorageKey(ASSET_ID),
      `ringmaster/assets/${ASSET_ID}`,
    );

    for (const assetId of [
      '',
      ' asset-id ',
      'ringmaster/assets/asset-id',
      'not-a-uuid',
      '00000000-0000-0000-0000-000000000000',
      1,
      null,
    ]) {
      assertBadRequest(() => buildAssetStorageKey(assetId as string));
    }
  });
});
