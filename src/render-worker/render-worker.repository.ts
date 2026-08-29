import { randomUUID } from "node:crypto";
import { Injectable } from "@nestjs/common";
import {
  Prisma,
  RovelleAssetStatus,
  RovelleEpisodeStatus,
  RovelleRenderStatus,
} from "../generated/prisma/client";
import { PrismaService } from "../database/prisma.service";
import { type RenderSpecV1 } from "../rovelle/render/render-spec";

export interface ClaimedRenderJob {
  jobId: string;
  renderId: string;
  episodeId: string;
  leaseToken: string;
  workerId: string;
  renderSpec: RenderSpecV1;
  specHash: string;
  outputAsset: {
    id: string;
    storageKey: string;
    status: RovelleAssetStatus;
    mediaType: string;
  };
}

type ClaimCandidate = { id: string; renderId: string };
type ExpiredJobCount = { count: number };
type RenderIdRow = { renderId: string };

class QueueStateChangedError extends Error {}

@Injectable()
export class RenderWorkerRepository {
  constructor(private readonly prisma: PrismaService) {}

  async claimNext(input: {
    workerId: string;
    leaseSeconds: number;
  }): Promise<ClaimedRenderJob | null> {
    const leaseToken = randomUUID();

    return this.prisma.client.$transaction(async (tx) => {
      const [candidate] = await tx.$queryRaw<ClaimCandidate[]>(Prisma.sql`
        SELECT id::text AS "id", render_id::text AS "renderId"
        FROM "rovelle_render_jobs"
        WHERE status = 'QUEUED'
          AND available_at <= now()
        ORDER BY available_at ASC, created_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      `);
      if (!candidate) return null;

      const claimed = await tx.$executeRaw(Prisma.sql`
        UPDATE "rovelle_render_jobs"
        SET status = 'RUNNING',
            worker_id = ${input.workerId},
            lease_token = ${leaseToken}::uuid,
            claimed_at = now(),
            heartbeat_at = now(),
            lease_expires_at = now() + ${input.leaseSeconds}::integer * interval '1 second',
            started_at = COALESCE(started_at, now()),
            updated_at = now()
        WHERE id = ${candidate.id}::uuid
          AND status = 'QUEUED'
      `);
      if (claimed !== 1) throw new QueueStateChangedError();

      const runningRender = await tx.rovelleRender.updateMany({
        where: { id: candidate.renderId, status: RovelleRenderStatus.QUEUED },
        data: { status: RovelleRenderStatus.RUNNING },
      });
      if (runningRender.count !== 1) throw new QueueStateChangedError();

      const render = await tx.rovelleRender.findUnique({
        where: { id: candidate.renderId },
        select: {
          id: true,
          episodeId: true,
          spec: true,
          specHash: true,
          outputAsset: {
            select: { id: true, storageKey: true, status: true, mediaType: true },
          },
        },
      });
      if (!render) throw new QueueStateChangedError();

      return {
        jobId: candidate.id,
        renderId: render.id,
        episodeId: render.episodeId,
        leaseToken,
        workerId: input.workerId,
        renderSpec: render.spec as unknown as RenderSpecV1,
        specHash: render.specHash,
        outputAsset: render.outputAsset,
      };
    });
  }

  async heartbeat(input: {
    jobId: string;
    leaseToken: string;
    leaseSeconds: number;
  }): Promise<boolean> {
    const updated = await this.prisma.client.$executeRaw(Prisma.sql`
      UPDATE "rovelle_render_jobs"
      SET heartbeat_at = now(),
          lease_expires_at = now() + ${input.leaseSeconds}::integer * interval '1 second',
          updated_at = now()
      WHERE id = ${input.jobId}::uuid
        AND status = 'RUNNING'
        AND lease_token = ${input.leaseToken}::uuid
        AND lease_expires_at > now()
    `);
    return updated === 1;
  }

  async recoverExpiredLeases(): Promise<number> {
    const recovered = await this.prisma.client.$transaction((tx) =>
      tx.$queryRaw<ExpiredJobCount[]>(Prisma.sql`
        WITH expired_jobs AS (
          UPDATE "rovelle_render_jobs"
          SET status = 'FAILED',
              finished_at = now(),
              error_code = 'WORKER_LEASE_EXPIRED',
              error_message = 'Worker lease expired',
              updated_at = now()
          WHERE status = 'RUNNING'
            AND lease_expires_at < now()
          RETURNING render_id
        ), failed_renders AS (
          UPDATE "rovelle_renders" render
          SET status = 'FAILED', updated_at = now()
          FROM expired_jobs job
          WHERE render.id = job.render_id
            AND render.status = 'RUNNING'
          RETURNING render.id
        )
        SELECT count(*)::integer AS "count"
        FROM expired_jobs
      `),
    );
    return recovered[0]?.count ?? 0;
  }

  async completeJob(input: {
    jobId: string;
    leaseToken: string;
    byteSize: bigint;
    etag: string | null;
  }): Promise<"completed" | "lease_lost"> {
    return this.prisma.client.$transaction(async (tx) => {
      const renderId = await this.finishLeasedJob(tx, input, "SUCCEEDED", null, null);
      if (!renderId) return "lease_lost";

      const render = await tx.rovelleRender.findUnique({
        where: { id: renderId },
        select: { id: true, episodeId: true, outputAssetId: true },
      });
      if (!render) throw new QueueStateChangedError();

      const output = await tx.rovelleAsset.updateMany({
        where: { id: render.outputAssetId, status: RovelleAssetStatus.RESERVED },
        data: {
          status: RovelleAssetStatus.AVAILABLE,
          byteSize: input.byteSize,
          etag: input.etag,
        },
      });
      if (output.count !== 1) throw new QueueStateChangedError();

      const completed = await tx.rovelleRender.updateMany({
        where: { id: render.id, status: RovelleRenderStatus.RUNNING },
        data: { status: RovelleRenderStatus.COMPLETED, completedAt: new Date() },
      });
      if (completed.count !== 1) throw new QueueStateChangedError();

      await tx.rovelleEpisode.updateMany({
        where: { id: render.episodeId, status: RovelleEpisodeStatus.RENDERING },
        data: { status: RovelleEpisodeStatus.FINAL_REVIEW },
      });
      return "completed";
    });
  }

  async failJob(input: {
    jobId: string;
    leaseToken: string;
    errorCode: string;
    errorMessage: string;
  }): Promise<"failed" | "lease_lost"> {
    const errorCode = sanitize(input.errorCode, 120, "RENDER_WORKER_FAILED");
    const errorMessage = sanitize(input.errorMessage, 4000, "Render worker failed");

    return this.prisma.client.$transaction(async (tx) => {
      const renderId = await this.finishLeasedJob(tx, input, "FAILED", errorCode, errorMessage);
      if (!renderId) return "lease_lost";

      const failed = await tx.rovelleRender.updateMany({
        where: { id: renderId, status: RovelleRenderStatus.RUNNING },
        data: { status: RovelleRenderStatus.FAILED },
      });
      if (failed.count !== 1) throw new QueueStateChangedError();
      return "failed";
    });
  }

  private async finishLeasedJob(
    tx: Prisma.TransactionClient,
    input: { jobId: string; leaseToken: string },
    status: "SUCCEEDED" | "FAILED",
    errorCode: string | null,
    errorMessage: string | null,
  ): Promise<string | null> {
    const [job] = await tx.$queryRaw<RenderIdRow[]>(Prisma.sql`
      UPDATE "rovelle_render_jobs"
      SET status = ${status}::"RovelleRenderJobStatus",
          finished_at = now(),
          error_code = ${errorCode},
          error_message = ${errorMessage},
          updated_at = now()
      WHERE id = ${input.jobId}::uuid
        AND status = 'RUNNING'
        AND lease_token = ${input.leaseToken}::uuid
        AND lease_expires_at > now()
      RETURNING render_id::text AS "renderId"
    `);
    return job?.renderId ?? null;
  }
}

function sanitize(value: string, maximumLength: number, fallback: string): string {
  return value.trim().slice(0, maximumLength) || fallback;
}
