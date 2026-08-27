import * as assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  RovelleAssetStatus,
  RovelleAssetType,
  type RovelleAsset,
} from '../../generated/prisma/client';
import type {
  AssetDto,
  AssetReadUrlDto,
  AssetReservationDto,
} from './dto/asset.dto';
import { toAssetDto } from './asset-mapper';

const asset: RovelleAsset = {
  id: '550e8400-e29b-41d4-a716-446655440000',
  episodeId: '123e4567-e89b-42d3-a456-426614174000',
  assetType: RovelleAssetType.SOURCE,
  status: RovelleAssetStatus.AVAILABLE,
  mediaType: 'text/plain',
  storageKey: 'ringmaster/assets/550e8400-e29b-41d4-a716-446655440000',
  originalFilename: 'source.txt',
  byteSize: 123n,
  etag: 'etag-123',
  createdAt: new Date('2026-08-27T00:00:00.000Z'),
  updatedAt: new Date('2026-08-27T00:01:00.000Z'),
};

describe('Rovelle asset mapping', () => {
  test('maps database values to the external asset DTO', () => {
    const mapped = toAssetDto(asset);

    const expected: AssetDto = {
      id: asset.id,
      episodeId: asset.episodeId,
      assetType: asset.assetType,
      status: asset.status,
      mediaType: asset.mediaType,
      originalFilename: asset.originalFilename,
      byteSize: '123',
      etag: asset.etag,
      createdAt: '2026-08-27T00:00:00.000Z',
      updatedAt: '2026-08-27T00:01:00.000Z',
    };

    assert.deepEqual(mapped, expected);
    assert.equal('storageKey' in mapped, false);
  });

  test('maps nullable database values without exposing storage keys', () => {
    const mapped = toAssetDto({
      ...asset,
      episodeId: null,
      originalFilename: null,
      byteSize: null,
      etag: null,
    });

    assert.deepEqual(mapped, {
      id: asset.id,
      episodeId: null,
      assetType: asset.assetType,
      status: asset.status,
      mediaType: asset.mediaType,
      originalFilename: null,
      byteSize: null,
      etag: null,
      createdAt: asset.createdAt.toISOString(),
      updatedAt: asset.updatedAt.toISOString(),
    });
    assert.equal(Object.keys(mapped).includes('storageKey'), false);
  });

  test('models reservation and read responses around private PUT and GET descriptors', () => {
    const upload = {
      method: 'PUT' as const,
      url: 'https://signed.example/put',
      headers: { 'content-type': 'text/plain' },
      expiresAt: '2026-08-27T00:15:00.000Z',
    };
    const read = {
      method: 'GET' as const,
      url: 'https://signed.example/get',
      headers: {},
      expiresAt: '2026-08-27T00:15:00.000Z',
    };
    const reservation: AssetReservationDto = { asset: toAssetDto(asset), upload };
    const readResponse: AssetReadUrlDto = { asset: toAssetDto(asset), read };

    assert.equal(reservation.upload.method, 'PUT');
    assert.equal(readResponse.read.method, 'GET');
    assert.equal('storageKey' in reservation.asset, false);
    assert.equal('storageKey' in readResponse.asset, false);
  });
});
