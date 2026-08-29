import * as assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  RovelleAssetStatus,
  RovelleAssetType,
  RovelleCanonEntityType,
  RovelleCanonVersionStatus,
  type RovelleAsset,
  type RovelleCanonAsset,
  type RovelleCanonEntity,
  type RovelleCanonVersion,
} from '../../generated/prisma/client';
import type {
  CanonAssetDto,
  CanonEntityDto,
  CanonVersionDto,
} from './dto/canon.dto';
import { toCanonEntityDto, toCanonVersionDto } from './canon-mapper';

const ENTITY_ID = '550e8400-e29b-41d4-a716-446655440000';
const VERSION_ID = '123e4567-e89b-42d3-a456-426614174000';
const FIRST_ASSET_ID = '223e4567-e89b-42d3-a456-426614174000';
const SECOND_ASSET_ID = '323e4567-e89b-42d3-a456-426614174000';

const entity: RovelleCanonEntity = {
  id: ENTITY_ID,
  code: 'KOKO',
  displayName: 'Koko',
  entityType: RovelleCanonEntityType.CHARACTER,
  description: 'The lead character',
  createdAt: new Date('2026-08-27T00:00:00.000Z'),
  updatedAt: new Date('2026-08-27T00:01:00.000Z'),
};

function asset(id: string, storageKey: string): RovelleAsset {
  return {
    id,
    episodeId: null,
    assetType: RovelleAssetType.CHARACTER_REFERENCE,
    status: RovelleAssetStatus.AVAILABLE,
    mediaType: 'image/png',
    storageKey,
    originalFilename: `${id}.png`,
    byteSize: 123n,
    etag: `etag-${id}`,
    createdAt: new Date('2026-08-27T00:02:00.000Z'),
    updatedAt: new Date('2026-08-27T00:03:00.000Z'),
  };
}

const firstAsset = asset(FIRST_ASSET_ID, 'private/first-key');
const secondAsset = asset(SECOND_ASSET_ID, 'private/second-key');

function canonAsset(
  assetValue: RovelleAsset,
  role: string,
  sortOrder: number,
): RovelleCanonAsset & { asset: RovelleAsset } {
  return {
    canonVersionId: VERSION_ID,
    assetId: assetValue.id,
    role,
    sortOrder,
    createdAt: new Date('2026-08-27T00:04:00.000Z'),
    asset: assetValue,
  };
}

const version = {
  id: VERSION_ID,
  entityId: ENTITY_ID,
  version: 1,
  status: RovelleCanonVersionStatus.LOCKED,
  definition: { appearance: { color: 'yellow' } },
  lockedAt: new Date('2026-08-27T00:05:00.000Z'),
  createdAt: new Date('2026-08-27T00:06:00.000Z'),
  updatedAt: new Date('2026-08-27T00:07:00.000Z'),
  entity,
  assets: [
    canonAsset(secondAsset, 'PORTRAIT', 2),
    canonAsset(firstAsset, 'TURNAROUND', 1),
    canonAsset(secondAsset, 'ALTERNATE', 1),
  ],
} as RovelleCanonVersion & {
  entity: RovelleCanonEntity;
  assets: Array<RovelleCanonAsset & { asset: RovelleAsset }>;
};

describe('Rovelle canon mapping', () => {
  test('maps an entity to its external DTO and ISO dates', () => {
    const mapped = toCanonEntityDto(entity);
    const expected: CanonEntityDto = {
      id: ENTITY_ID,
      code: 'KOKO',
      displayName: 'Koko',
      entityType: RovelleCanonEntityType.CHARACTER,
      description: 'The lead character',
      createdAt: '2026-08-27T00:00:00.000Z',
      updatedAt: '2026-08-27T00:01:00.000Z',
    };

    assert.deepEqual(mapped, expected);
  });

  test('maps a version with nested entity and deterministically sorted asset DTOs', () => {
    const mapped = toCanonVersionDto(version);
    const expectedAssets: CanonAssetDto[] = [
      {
        role: 'ALTERNATE',
        sortOrder: 1,
        asset: {
          id: SECOND_ASSET_ID,
          episodeId: null,
          assetType: RovelleAssetType.CHARACTER_REFERENCE,
          status: RovelleAssetStatus.AVAILABLE,
          mediaType: 'image/png',
          originalFilename: `${SECOND_ASSET_ID}.png`,
          byteSize: '123',
          etag: `etag-${SECOND_ASSET_ID}`,
          createdAt: '2026-08-27T00:02:00.000Z',
          updatedAt: '2026-08-27T00:03:00.000Z',
        },
      },
      {
        role: 'TURNAROUND',
        sortOrder: 1,
        asset: {
          id: FIRST_ASSET_ID,
          episodeId: null,
          assetType: RovelleAssetType.CHARACTER_REFERENCE,
          status: RovelleAssetStatus.AVAILABLE,
          mediaType: 'image/png',
          originalFilename: `${FIRST_ASSET_ID}.png`,
          byteSize: '123',
          etag: `etag-${FIRST_ASSET_ID}`,
          createdAt: '2026-08-27T00:02:00.000Z',
          updatedAt: '2026-08-27T00:03:00.000Z',
        },
      },
      {
        role: 'PORTRAIT',
        sortOrder: 2,
        asset: {
          id: SECOND_ASSET_ID,
          episodeId: null,
          assetType: RovelleAssetType.CHARACTER_REFERENCE,
          status: RovelleAssetStatus.AVAILABLE,
          mediaType: 'image/png',
          originalFilename: `${SECOND_ASSET_ID}.png`,
          byteSize: '123',
          etag: `etag-${SECOND_ASSET_ID}`,
          createdAt: '2026-08-27T00:02:00.000Z',
          updatedAt: '2026-08-27T00:03:00.000Z',
        },
      },
    ];
    const expected: CanonVersionDto = {
      id: VERSION_ID,
      entityId: ENTITY_ID,
      version: 1,
      status: RovelleCanonVersionStatus.LOCKED,
      definition: { appearance: { color: 'yellow' } },
      lockedAt: '2026-08-27T00:05:00.000Z',
      createdAt: '2026-08-27T00:06:00.000Z',
      updatedAt: '2026-08-27T00:07:00.000Z',
      entity: {
        id: ENTITY_ID,
        code: 'KOKO',
        displayName: 'Koko',
        entityType: RovelleCanonEntityType.CHARACTER,
        description: 'The lead character',
        createdAt: '2026-08-27T00:00:00.000Z',
        updatedAt: '2026-08-27T00:01:00.000Z',
      },
      assets: expectedAssets,
    };

    assert.deepEqual(mapped, expected);
    assert.deepEqual(version.assets.map(({ role, sortOrder }) => ({ role, sortOrder })), [
      { role: 'PORTRAIT', sortOrder: 2 },
      { role: 'TURNAROUND', sortOrder: 1 },
      { role: 'ALTERNATE', sortOrder: 1 },
    ]);
    assert.equal('storageKey' in mapped, false);
    assert.equal(
      mapped.assets.some((attachment) => 'storageKey' in attachment.asset),
      false,
    );
  });

  test('maps nullable entity and lock fields without storage keys', () => {
    const mapped = toCanonVersionDto({
      ...version,
      entity: { ...entity, description: null },
      lockedAt: null,
    });

    assert.equal(mapped.lockedAt, null);
    assert.equal(mapped.entity.description, null);
    assert.equal('storageKey' in mapped, false);
    assert.equal('storageKey' in mapped.entity, false);
  });
});
