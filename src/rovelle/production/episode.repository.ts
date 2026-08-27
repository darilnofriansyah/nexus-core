import { Injectable } from "@nestjs/common";
import {
  Prisma,
  RovelleEpisode,
  RovelleEpisodeStatus,
  RovelleShot,
  RovelleShotStatus,
} from "../../generated/prisma/client";
import { PrismaService } from "../../database/prisma.service";
import { CreateEpisodeRequestDto, ShotInputDto } from "./dto/episode.dto";

const includeShots = {
  shots: { orderBy: { sequence: "asc" as const } },
} satisfies Prisma.RovelleEpisodeInclude;

export type EpisodeWithShots = RovelleEpisode & {
  shots: RovelleShot[];
};

export type MarkReadyResult =
  | { status: "ready"; episode: EpisodeWithShots }
  | { status: "not_found" }
  | { status: "invalid_state" }
  | { status: "no_shots" };

type MarkReadyTransactionResult =
  | { status: "ready" }
  | { status: "not_found" }
  | { status: "invalid_state" }
  | { status: "no_shots" };

class MarkReadyInvalidStateError extends Error {}

@Injectable()
export class EpisodeRepository {
  constructor(private readonly prisma: PrismaService) {}

  async createEpisode({
    code,
    title,
    targetDurationSeconds,
  }: CreateEpisodeRequestDto): Promise<EpisodeWithShots> {
    return this.prisma.client.rovelleEpisode.create({
      data: {
        code,
        title,
        targetDurationSeconds,
      },
      include: includeShots,
    });
  }

  async findEpisode(id: string): Promise<EpisodeWithShots | null> {
    return this.prisma.client.rovelleEpisode.findUnique({
      where: { id },
      include: includeShots,
    });
  }

  async updateBrief(
    id: string,
    brief: Record<string, unknown>,
  ): Promise<EpisodeWithShots | null> {
    const result = await this.prisma.client.rovelleEpisode.updateMany({
      where: {
        id,
        status: RovelleEpisodeStatus.DRAFT,
      },
      data: {
        brief: brief as Prisma.InputJsonValue,
      },
    });

    return result.count === 1 ? this.findEpisode(id) : null;
  }

  async transitionStatus(
    id: string,
    from: RovelleEpisodeStatus,
    to: RovelleEpisodeStatus,
  ): Promise<EpisodeWithShots | null> {
    const result = await this.prisma.client.rovelleEpisode.updateMany({
      where: { id, status: from },
      data: { status: to },
    });

    return result.count === 1 ? this.findEpisode(id) : null;
  }

  async replaceShots(
    episodeId: string,
    shots: ShotInputDto[],
  ): Promise<EpisodeWithShots | null> {
    const replaced = await this.prisma.client.$transaction(async (tx) => {
      const episode = await tx.rovelleEpisode.findUnique({
        where: { id: episodeId },
      });

      if (!episode || episode.status !== RovelleEpisodeStatus.PREPRODUCTION) {
        return false;
      }

      const guarded = await tx.rovelleEpisode.updateMany({
        where: {
          id: episodeId,
          status: RovelleEpisodeStatus.PREPRODUCTION,
        },
        data: { status: RovelleEpisodeStatus.PREPRODUCTION },
      });

      if (guarded.count !== 1) {
        return false;
      }

      await tx.rovelleShot.deleteMany({
        where: { episodeId },
      });

      if (shots.length > 0) {
        await tx.rovelleShot.createMany({
          data: shots.map((shot) => ({
            episodeId,
            sequence: shot.sequence,
            name: shot.name ?? null,
            direction: shot.direction,
            targetDurationSeconds: shot.targetDurationSeconds ?? null,
          })),
        });
      }

      return true;
    });

    return replaced ? this.findEpisode(episodeId) : null;
  }

  async markReady(id: string): Promise<MarkReadyResult> {
    let transactionResult: MarkReadyTransactionResult;

    try {
      transactionResult = await this.prisma.client.$transaction(async (tx) => {
        const episode = await tx.rovelleEpisode.findUnique({
          where: { id },
        });

        if (!episode) {
          return { status: "not_found" } as const;
        }

        if (episode.status !== RovelleEpisodeStatus.PREPRODUCTION) {
          return { status: "invalid_state" } as const;
        }

        const shotCount = await tx.rovelleShot.count({
          where: { episodeId: id },
        });

        if (shotCount === 0) {
          return { status: "no_shots" } as const;
        }

        await tx.rovelleShot.updateMany({
          where: { episodeId: id },
          data: { status: RovelleShotStatus.READY_TO_GENERATE },
        });

        const updated = await tx.rovelleEpisode.updateMany({
          where: {
            id,
            status: RovelleEpisodeStatus.PREPRODUCTION,
          },
          data: { status: RovelleEpisodeStatus.READY_TO_GENERATE },
        });

        if (updated.count !== 1) {
          throw new MarkReadyInvalidStateError();
        }

        return { status: "ready" } as const;
      });
    } catch (error) {
      if (error instanceof MarkReadyInvalidStateError) {
        return { status: "invalid_state" };
      }
      throw error;
    }

    if (transactionResult.status !== "ready") {
      return transactionResult;
    }

    const episode = await this.findEpisode(id);
    return episode ? { status: "ready", episode } : { status: "invalid_state" };
  }
}
