import { Injectable } from "@nestjs/common";
import {
  Prisma,
  RovelleAssetStatus,
  RovelleAssetType,
  RovelleEpisodeStatus,
  RovelleGenerationStatus,
  RovelleRenderJobStatus,
  RovelleRenderStatus,
  RovelleShotStatus,
} from "../../generated/prisma/client";
import { PrismaService } from "../../database/prisma.service";
import {
  buildRenderSpecV1,
  hashRenderSpec,
  stableRenderSpecJson,
} from "./render-spec";

const RENDER_INCLUDE = {
  outputAsset: true,
  jobs: { orderBy: { attempt: "asc" } },
} satisfies Prisma.RovelleRenderInclude;

const UNSAFE_SPEC_METADATA = /storageKey|url|token|secret|authorization|https?:\/\//i;

export type InternalRenderRecord = Prisma.RovelleRenderGetPayload<{
  include: typeof RENDER_INCLUDE;
}>;

export type CreateRenderResult =
  | { status: "created"; render: InternalRenderRecord }
  | { status: "existing"; render: InternalRenderRecord }
  | { status: "episode_not_found" }
  | { status: "invalid_episode_state" }
  | { status: "no_shots" }
  | { status: "shot_not_approved"; shotId: string }
  | { status: "approved_generation_invalid"; shotId: string }
  | { status: "audio_invalid" }
  | { status: "caption_invalid" };

export interface CreateQueuedRenderInput {
  clientRequestId: string;
  episodeId: string;
  audioAssetId: string;
  captionAssetId: string | null;
  outputAssetId: string;
  outputStorageKey: string;
}

class EpisodeRenderStateChangedError extends Error {}

@Injectable()
export class RenderRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findRender(id: string): Promise<InternalRenderRecord | null> {
    return this.prisma.client.rovelleRender.findUnique({
      where: { id },
      include: RENDER_INCLUDE,
    });
  }

  async listEpisodeRenders(
    episodeId: string,
  ): Promise<InternalRenderRecord[]> {
    return this.prisma.client.rovelleRender.findMany({
      where: { episodeId },
      orderBy: { attempt: "desc" },
      include: RENDER_INCLUDE,
    });
  }

  async createQueuedRender(
    input: CreateQueuedRenderInput,
  ): Promise<CreateRenderResult> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.prisma.client.$transaction(
          async (tx) => this.createInTransaction(tx, input),
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
      } catch (error) {
        if (error instanceof EpisodeRenderStateChangedError) {
          return { status: "invalid_episode_state" };
        }
        if (isUniqueConstraintError(error)) {
          const existing = await this.findByRequestId(input.clientRequestId);
          if (existing) return { status: "existing", render: existing };
        }
        if (attempt < 2 && isSerializableTransactionError(error)) continue;
        throw error;
      }
    }
  }

  private async findByRequestId(
    clientRequestId: string,
  ): Promise<InternalRenderRecord | null> {
    return this.prisma.client.rovelleRender.findUnique({
      where: { clientRequestId },
      include: RENDER_INCLUDE,
    });
  }

  private async createInTransaction(
    tx: Prisma.TransactionClient,
    input: CreateQueuedRenderInput,
  ): Promise<CreateRenderResult> {
    const existing = await tx.rovelleRender.findUnique({
      where: { clientRequestId: input.clientRequestId },
      include: RENDER_INCLUDE,
    });
    if (existing) return { status: "existing", render: existing };

    const episode = await tx.rovelleEpisode.findUnique({
      where: { id: input.episodeId },
      select: { id: true, status: true },
    });
    if (!episode) return { status: "episode_not_found" };
    if (episode.status !== RovelleEpisodeStatus.GENERATION_APPROVED) {
      return { status: "invalid_episode_state" };
    }

    const shots = await tx.rovelleShot.findMany({
      where: { episodeId: input.episodeId },
      orderBy: { sequence: "asc" },
      include: { approvedGeneration: { include: { outputAsset: true } } },
    });
    if (shots.length === 0) return { status: "no_shots" };

    for (const shot of shots) {
      if (shot.status !== RovelleShotStatus.APPROVED) {
        return { status: "shot_not_approved", shotId: shot.id };
      }
      if (!hasAuthoritativeApprovedGeneration(shot, input.episodeId)) {
        return { status: "approved_generation_invalid", shotId: shot.id };
      }
    }

    const audio = await tx.rovelleAsset.findUnique({
      where: { id: input.audioAssetId },
    });
    if (!isAudioSource(audio, input.episodeId)) return { status: "audio_invalid" };

    const captions = await this.loadCaption(tx, input.captionAssetId, input.episodeId);
    if (captions === undefined) return { status: "caption_invalid" };

    const latest = await tx.rovelleRender.aggregate({
      where: { episodeId: input.episodeId },
      _max: { attempt: true },
    });
    const renderAttempt = (latest._max.attempt ?? 0) + 1;
    const spec = buildRenderSpecV1({
      shots: shots.map((shot) => ({
        sequence: shot.sequence,
        shotId: shot.id,
        generationId: shot.approvedGenerationId!,
        targetDurationSeconds: shot.targetDurationSeconds ?? 0,
        video: snapshotAsset(shot.approvedGeneration!.outputAsset),
      })),
      audio: snapshotAsset(audio),
      captions: captions === null ? null : snapshotAsset(captions),
    });

    await tx.rovelleAsset.create({
      data: {
        id: input.outputAssetId,
        episodeId: input.episodeId,
        assetType: RovelleAssetType.RENDER,
        status: RovelleAssetStatus.RESERVED,
        mediaType: "video/mp4",
        storageKey: input.outputStorageKey,
        originalFilename: null,
      },
    });
    const created = await tx.rovelleRender.create({
      data: {
        clientRequestId: input.clientRequestId,
        episodeId: input.episodeId,
        attempt: renderAttempt,
        status: RovelleRenderStatus.QUEUED,
        specVersion: 1,
        spec: toPersistedSpec(spec),
        specHash: hashRenderSpec(spec),
        outputAssetId: input.outputAssetId,
      },
    });
    await tx.rovelleRenderJob.create({
      data: {
        clientRequestId: input.clientRequestId,
        renderId: created.id,
        attempt: 1,
        status: RovelleRenderJobStatus.QUEUED,
        availableAt: new Date(),
      },
    });
    const transitioned = await tx.rovelleEpisode.updateMany({
      where: {
        id: input.episodeId,
        status: RovelleEpisodeStatus.GENERATION_APPROVED,
      },
      data: { status: RovelleEpisodeStatus.RENDERING },
    });
    if (transitioned.count !== 1) throw new EpisodeRenderStateChangedError();

    const render = await tx.rovelleRender.findUnique({
      where: { id: created.id },
      include: RENDER_INCLUDE,
    });
    if (!render) throw new EpisodeRenderStateChangedError();
    return { status: "created", render };
  }

  private async loadCaption(
    tx: Prisma.TransactionClient,
    captionAssetId: string | null,
    episodeId: string,
  ) {
    if (captionAssetId === null) return null;
    const caption = await tx.rovelleAsset.findUnique({
      where: { id: captionAssetId },
    });
    return isCaptionSource(caption, episodeId) ? caption : undefined;
  }
}

function hasAuthoritativeApprovedGeneration(
  shot: {
    id: string;
    approvedGenerationId: string | null;
    approvedGeneration: {
      id: string;
      shotId: string;
      status: RovelleGenerationStatus;
      outputAsset: {
        episodeId: string | null;
        status: RovelleAssetStatus;
        assetType: RovelleAssetType;
        mediaType: string;
        etag: string | null;
      };
    } | null;
  },
  episodeId: string,
): boolean {
  const generation = shot.approvedGeneration;
  if (!generation || shot.approvedGenerationId !== generation.id) return false;
  if (generation.shotId !== shot.id || generation.status !== RovelleGenerationStatus.COMPLETED) {
    return false;
  }
  const output = generation.outputAsset;
  return (
    output.episodeId === episodeId &&
    output.status === RovelleAssetStatus.AVAILABLE &&
    output.assetType === RovelleAssetType.GENERATION &&
    output.mediaType.startsWith("video/") &&
    hasSafeSnapshotMetadata(output)
  );
}

function isAudioSource(
  asset: {
    episodeId: string | null;
    status: RovelleAssetStatus;
    assetType: RovelleAssetType;
    mediaType: string;
    byteSize: bigint | null;
    etag: string | null;
  } | null,
  episodeId: string,
): asset is NonNullable<typeof asset> {
  return (
    asset !== null &&
    asset.episodeId === episodeId &&
    asset.status === RovelleAssetStatus.AVAILABLE &&
    asset.assetType === RovelleAssetType.AUDIO_MASTER &&
    asset.mediaType.startsWith("audio/") &&
    asset.byteSize !== null &&
    hasSafeSnapshotMetadata(asset)
  );
}

function isCaptionSource(
  asset: {
    episodeId: string | null;
    status: RovelleAssetStatus;
    assetType: RovelleAssetType;
    mediaType: string;
    byteSize: bigint | null;
    etag: string | null;
  } | null,
  episodeId: string,
): asset is NonNullable<typeof asset> {
  return (
    asset !== null &&
    asset.episodeId === episodeId &&
    asset.status === RovelleAssetStatus.AVAILABLE &&
    asset.assetType === RovelleAssetType.CAPTION &&
    (asset.mediaType === "text/vtt" || asset.mediaType === "application/x-subrip") &&
    asset.byteSize !== null &&
    hasSafeSnapshotMetadata(asset)
  );
}

function snapshotAsset(asset: {
  id: string;
  mediaType: string;
  byteSize: bigint | null;
  etag: string | null;
}) {
  return {
    assetId: asset.id,
    mediaType: asset.mediaType,
    byteSize: asset.byteSize!.toString(),
    etag: asset.etag,
  };
}

function hasSafeSnapshotMetadata(asset: {
  mediaType: string;
  etag?: string | null;
}): boolean {
  return (
    !UNSAFE_SPEC_METADATA.test(asset.mediaType) &&
    (asset.etag === null || asset.etag === undefined || !UNSAFE_SPEC_METADATA.test(asset.etag))
  );
}

function toPersistedSpec(spec: Parameters<typeof stableRenderSpecJson>[0]): Prisma.InputJsonValue {
  const persisted: unknown = JSON.parse(stableRenderSpecJson(spec));
  if (!isPrismaInputJsonValue(persisted)) {
    throw new TypeError("render spec must be JSON serializable");
  }
  return persisted;
}

function isPrismaInputJsonValue(value: unknown): value is Prisma.InputJsonValue {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every(
      (entry) => entry === null || isPrismaInputJsonValue(entry),
    );
  }
  if (value === null || typeof value !== "object") return false;
  return Object.values(value).every(
    (entry) => entry === null || isPrismaInputJsonValue(entry),
  );
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && "code" in error && error.code === "P2002"
  );
}

function isSerializableTransactionError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  if ("code" in error && error.code === "P2034") return true;
  if (!("cause" in error)) return false;

  const cause = error.cause;
  return (
    typeof cause === "object" &&
    cause !== null &&
    "originalCode" in cause &&
    cause.originalCode === "40001"
  );
}
