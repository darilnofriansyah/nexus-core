import * as assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  RovelleAssetStatus,
  RovelleAssetType,
  RovelleRenderJobStatus,
  RovelleRenderProfile,
  RovelleRenderStatus,
  type RovelleAsset,
  type RovelleRender,
  type RovelleRenderJob,
} from '../../generated/prisma/client';
import type { AssetDto } from '../assets/dto/asset.dto';
import type { RenderSpecV1 } from './render-spec';
import type { RenderDto, RenderJobDto } from './render-mapper';
import { toRenderDto, toRenderJobDto } from './render-mapper';

const RENDER_ID = '550e8400-e29b-41d4-a716-446655440000';
const RENDER_REQUEST_ID = '650e8400-e29b-41d4-a716-446655440000';
const EPISODE_ID = '750e8400-e29b-41d4-a716-446655440000';
const OUTPUT_ASSET_ID = '850e8400-e29b-41d4-a716-446655440000';
const FIRST_JOB_ID = '950e8400-e29b-41d4-a716-446655440000';
const SECOND_JOB_ID = 'a50e8400-e29b-41d4-a716-446655440000';

const spec: RenderSpecV1 = {
  version: 1,
  profile: 'VERTICAL_SHORT_V1',
  output: {
    container: 'mp4',
    width: 1080,
    height: 1920,
    frameRate: 30,
    videoCodec: 'libx264',
    pixelFormat: 'yuv420p',
    audioCodec: 'aac',
    audioSampleRate: 48000,
  },
  shots: [],
  audio: { assetId: OUTPUT_ASSET_ID, mediaType: 'audio/mpeg', byteSize: '1', etag: null },
  captions: null,
};

const outputAsset: RovelleAsset = {
  id: OUTPUT_ASSET_ID,
  episodeId: EPISODE_ID,
  assetType: RovelleAssetType.RENDER,
  status: RovelleAssetStatus.AVAILABLE,
  mediaType: 'video/mp4',
  storageKey: 'private/render.mp4',
  originalFilename: 'render.mp4',
  byteSize: 42n,
  etag: 'asset-etag',
  createdAt: new Date('2026-08-29T01:00:00.000Z'),
  updatedAt: new Date('2026-08-29T01:01:00.000Z'),
};

function job(id: string, attempt: number): RovelleRenderJob {
  return {
    id,
    clientRequestId: `${attempt}50e8400-e29b-41d4-a716-446655440000`,
    renderId: RENDER_ID,
    attempt,
    status: attempt === 1 ? RovelleRenderJobStatus.SUCCEEDED : RovelleRenderJobStatus.QUEUED,
    availableAt: new Date(`2026-08-29T01:0${attempt}:00.000Z`),
    workerId: attempt === 1 ? 'worker-a' : null,
    leaseToken: 'secret-lease-token',
    claimedAt: attempt === 1 ? new Date('2026-08-29T01:02:00.000Z') : null,
    heartbeatAt: null,
    leaseExpiresAt: null,
    startedAt: attempt === 1 ? new Date('2026-08-29T01:03:00.000Z') : null,
    finishedAt: attempt === 1 ? new Date('2026-08-29T01:04:00.000Z') : null,
    errorCode: null,
    errorMessage: null,
    createdAt: new Date('2026-08-29T00:00:00.000Z'),
    updatedAt: new Date('2026-08-29T00:05:00.000Z'),
  };
}

const firstJob = job(FIRST_JOB_ID, 2);
const secondJob = job(SECOND_JOB_ID, 1);

const render = {
  id: RENDER_ID,
  clientRequestId: RENDER_REQUEST_ID,
  episodeId: EPISODE_ID,
  attempt: 1,
  profile: RovelleRenderProfile.VERTICAL_SHORT_V1,
  status: RovelleRenderStatus.COMPLETED,
  specVersion: 1,
  spec,
  specHash: 'a'.repeat(64),
  outputAssetId: OUTPUT_ASSET_ID,
  completedAt: new Date('2026-08-29T01:05:00.000Z'),
  createdAt: new Date('2026-08-29T00:00:00.000Z'),
  updatedAt: new Date('2026-08-29T01:05:00.000Z'),
  outputAsset,
  jobs: [firstJob, secondJob],
} as unknown as RovelleRender & {
  outputAsset: RovelleAsset;
  jobs: RovelleRenderJob[];
};

describe('Rovelle render mapping', () => {
  test('maps a job to its public DTO, ISO dates, requestId, and no lease secret', () => {
    const mapped = toRenderJobDto(firstJob);
    const expected: RenderJobDto = {
      id: FIRST_JOB_ID,
      requestId: firstJob.clientRequestId,
      attempt: 2,
      status: RovelleRenderJobStatus.QUEUED,
      availableAt: '2026-08-29T01:02:00.000Z',
      workerId: null,
      claimedAt: null,
      heartbeatAt: null,
      leaseExpiresAt: null,
      startedAt: null,
      finishedAt: null,
      errorCode: null,
      errorMessage: null,
      createdAt: '2026-08-29T00:00:00.000Z',
      updatedAt: '2026-08-29T00:05:00.000Z',
    };

    assert.deepEqual(mapped, expected);
    assert.equal('leaseToken' in mapped, false);
    assert.equal('workerSecret' in mapped, false);
  });

  test('maps a render with nested public asset, preserves spec, sorts jobs, and strips storage key', () => {
    const mapped = toRenderDto(render);
    const expectedAsset: AssetDto = {
      id: OUTPUT_ASSET_ID,
      episodeId: EPISODE_ID,
      assetType: RovelleAssetType.RENDER,
      status: RovelleAssetStatus.AVAILABLE,
      mediaType: 'video/mp4',
      originalFilename: 'render.mp4',
      byteSize: '42',
      etag: 'asset-etag',
      createdAt: '2026-08-29T01:00:00.000Z',
      updatedAt: '2026-08-29T01:01:00.000Z',
    };

    const expected: RenderDto = {
      id: RENDER_ID,
      requestId: RENDER_REQUEST_ID,
      episodeId: EPISODE_ID,
      attempt: 1,
      profile: 'VERTICAL_SHORT_V1',
      status: RovelleRenderStatus.COMPLETED,
      specVersion: 1,
      specHash: 'a'.repeat(64),
      spec,
      outputAsset: expectedAsset,
      jobs: [toRenderJobDto(secondJob), toRenderJobDto(firstJob)],
      completedAt: '2026-08-29T01:05:00.000Z',
      createdAt: '2026-08-29T00:00:00.000Z',
      updatedAt: '2026-08-29T01:05:00.000Z',
    };

    assert.deepEqual(mapped, expected);
    assert.equal(mapped.spec, spec);
    assert.equal('storageKey' in mapped.outputAsset, false);
    assert.equal(mapped.jobs[0]?.attempt, 1);
    assert.equal('leaseToken' in mapped.jobs[0]!, false);
    assert.equal('workerSecret' in mapped.jobs[0]!, false);
  });

  test('rejects unsupported render spec versions', () => {
    assert.throws(
      () => toRenderDto({ ...render, specVersion: 2 }),
      /unsupported render spec version/,
    );
  });
});
