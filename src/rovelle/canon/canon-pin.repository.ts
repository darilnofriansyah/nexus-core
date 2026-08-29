import { Injectable } from "@nestjs/common";
import {
  Prisma,
  RovelleCanonVersionStatus,
  type RovelleEpisode,
  type RovelleEpisodeCanonPin,
  type RovelleShot,
} from "../../generated/prisma/client";
import { PrismaService } from "../../database/prisma.service";
import type { CanonVersionWithAssets } from "./canon.repository";
import { canEditCanonPins } from "./canon-pin-policy";

const includeCanonVersion = {
  entity: true,
  assets: {
    orderBy: [
      { sortOrder: "asc" as const },
      { role: "asc" as const },
      { assetId: "asc" as const },
    ],
    include: { asset: true },
  },
} satisfies Prisma.RovelleCanonVersionInclude;

const includePinVersion = {
  canonVersion: { include: includeCanonVersion },
};

const includeEffectiveShotPins = {
  episode: {
    include: {
      canonPins: {
        orderBy: { canonEntityId: "asc" as const },
        include: includePinVersion,
      },
    },
  },
  canonPins: {
    orderBy: { canonEntityId: "asc" as const },
    include: includePinVersion,
  },
} satisfies Prisma.RovelleShotInclude;

export type CanonPinRecord = Pick<
  RovelleEpisodeCanonPin,
  "canonEntityId" | "canonVersionId" | "createdAt" | "updatedAt"
>;

export type CanonPinWithVersion = CanonPinRecord & {
  canonVersion: CanonVersionWithAssets;
};

export type EffectiveShotPins = RovelleShot & {
  episode: RovelleEpisode & { canonPins: CanonPinWithVersion[] };
  canonPins: CanonPinWithVersion[];
};

export type PinMutationResult =
  | { status: "pinned"; pin: CanonPinRecord }
  | { status: "unpinned" }
  | { status: "not_found" }
  | { status: "episode_locked" }
  | { status: "version_not_locked" }
  | { status: "entity_mismatch" };

type PinVersionValidation =
  | { status: "valid" }
  | { status: "not_found" }
  | { status: "version_not_locked" }
  | { status: "entity_mismatch" };

@Injectable()
export class CanonPinRepository {
  constructor(private readonly prisma: PrismaService) {}

  async pinEpisodeVersion(
    episodeId: string,
    canonEntityId: string,
    canonVersionId: string,
  ): Promise<PinMutationResult> {
    return this.prisma.client.$transaction(
      async (tx) => {
        const episode = await tx.rovelleEpisode.findUnique({
          where: { id: episodeId },
        });
        if (!episode) return { status: "not_found" };
        if (!canEditCanonPins(episode.status)) {
          return { status: "episode_locked" };
        }

        const validation = await this.validateLockedVersion(
          tx,
          canonEntityId,
          canonVersionId,
        );
        if (validation.status !== "valid") return validation;

        const pin = await tx.rovelleEpisodeCanonPin.upsert({
          where: { episodeId_canonEntityId: { episodeId, canonEntityId } },
          update: { canonVersionId },
          create: { episodeId, canonEntityId, canonVersionId },
        });
        return { status: "pinned", pin };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }

  async unpinEpisodeEntity(
    episodeId: string,
    canonEntityId: string,
  ): Promise<PinMutationResult> {
    return this.prisma.client.$transaction(
      async (tx) => {
        const episode = await tx.rovelleEpisode.findUnique({
          where: { id: episodeId },
        });
        if (!episode) return { status: "not_found" };
        if (!canEditCanonPins(episode.status)) {
          return { status: "episode_locked" };
        }

        await tx.rovelleEpisodeCanonPin.deleteMany({
          where: { episodeId, canonEntityId },
        });
        return { status: "unpinned" };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }

  async listEpisodePins(episodeId: string): Promise<CanonPinWithVersion[]> {
    return this.prisma.client.rovelleEpisodeCanonPin.findMany({
      where: { episodeId },
      orderBy: { canonEntityId: "asc" },
      include: includePinVersion,
    });
  }

  async pinShotVersion(
    shotId: string,
    canonEntityId: string,
    canonVersionId: string,
  ): Promise<PinMutationResult> {
    return this.prisma.client.$transaction(
      async (tx) => {
        const shot = await tx.rovelleShot.findUnique({
          where: { id: shotId },
          include: { episode: { select: { status: true } } },
        });
        if (!shot) return { status: "not_found" };
        if (!canEditCanonPins(shot.episode.status)) {
          return { status: "episode_locked" };
        }

        const validation = await this.validateLockedVersion(
          tx,
          canonEntityId,
          canonVersionId,
        );
        if (validation.status !== "valid") return validation;

        const pin = await tx.rovelleShotCanonPin.upsert({
          where: { shotId_canonEntityId: { shotId, canonEntityId } },
          update: { canonVersionId },
          create: { shotId, canonEntityId, canonVersionId },
        });
        return { status: "pinned", pin };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }

  async unpinShotEntity(
    shotId: string,
    canonEntityId: string,
  ): Promise<PinMutationResult> {
    return this.prisma.client.$transaction(
      async (tx) => {
        const shot = await tx.rovelleShot.findUnique({
          where: { id: shotId },
          include: { episode: { select: { status: true } } },
        });
        if (!shot) return { status: "not_found" };
        if (!canEditCanonPins(shot.episode.status)) {
          return { status: "episode_locked" };
        }

        await tx.rovelleShotCanonPin.deleteMany({
          where: { shotId, canonEntityId },
        });
        return { status: "unpinned" };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }

  async getEffectiveShotPins(
    shotId: string,
  ): Promise<EffectiveShotPins | null> {
    return this.prisma.client.rovelleShot.findUnique({
      where: { id: shotId },
      include: includeEffectiveShotPins,
    });
  }

  private async validateLockedVersion(
    tx: Prisma.TransactionClient,
    canonEntityId: string,
    canonVersionId: string,
  ): Promise<PinVersionValidation> {
    const version = await tx.rovelleCanonVersion.findUnique({
      where: { id: canonVersionId },
      include: { entity: true },
    });
    if (!version) return { status: "not_found" };
    if (version.status !== RovelleCanonVersionStatus.LOCKED) {
      return { status: "version_not_locked" };
    }
    return version.entityId === canonEntityId
      ? { status: "valid" }
      : { status: "entity_mismatch" };
  }
}
