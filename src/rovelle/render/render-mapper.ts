import type {
  RovelleRender,
  RovelleRenderJob,
} from '../../generated/prisma/client';
import { toAssetDto } from '../assets/asset-mapper';
import type { AssetDto } from '../assets/dto/asset.dto';
import type { RenderSpecV1 } from './render-spec';

export interface RenderJobDto {
  id: string;
  requestId: string;
  attempt: number;
  status: RovelleRenderJob['status'];
  availableAt: string;
  workerId: string | null;
  claimedAt: string | null;
  heartbeatAt: string | null;
  leaseExpiresAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RenderDto {
  id: string;
  requestId: string;
  episodeId: string;
  attempt: number;
  profile: 'VERTICAL_SHORT_V1';
  status: RovelleRender['status'];
  specVersion: 1;
  specHash: string;
  spec: RenderSpecV1;
  outputAsset: AssetDto;
  jobs: RenderJobDto[];
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export function toRenderJobDto(job: RovelleRenderJob): RenderJobDto {
  return {
    id: job.id,
    requestId: job.clientRequestId,
    attempt: job.attempt,
    status: job.status,
    availableAt: job.availableAt.toISOString(),
    workerId: job.workerId,
    claimedAt: job.claimedAt?.toISOString() ?? null,
    heartbeatAt: job.heartbeatAt?.toISOString() ?? null,
    leaseExpiresAt: job.leaseExpiresAt?.toISOString() ?? null,
    startedAt: job.startedAt?.toISOString() ?? null,
    finishedAt: job.finishedAt?.toISOString() ?? null,
    errorCode: job.errorCode,
    errorMessage: job.errorMessage,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
  };
}

export function toRenderDto(
  render: RovelleRender & {
    outputAsset: Parameters<typeof toAssetDto>[0];
    jobs: RovelleRenderJob[];
  },
): RenderDto {
  if (render.specVersion !== 1) {
    throw new Error('unsupported render spec version');
  }

  return {
    id: render.id,
    requestId: render.clientRequestId,
    episodeId: render.episodeId,
    attempt: render.attempt,
    profile: render.profile,
    status: render.status,
    specVersion: 1,
    specHash: render.specHash,
    spec: render.spec as unknown as RenderSpecV1,
    outputAsset: toAssetDto(render.outputAsset),
    jobs: [...render.jobs]
      .sort((left, right) => left.attempt - right.attempt)
      .map(toRenderJobDto),
    completedAt: render.completedAt?.toISOString() ?? null,
    createdAt: render.createdAt.toISOString(),
    updatedAt: render.updatedAt.toISOString(),
  };
}
