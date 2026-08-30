import { join } from "node:path";

import { Injectable, Logger } from "@nestjs/common";

import { hashRenderSpec } from "../rovelle/render/render-spec";
import { RenderWorkerError } from "./media-transfer.service";
import type {
  RenderWorkspace,
  TempWorkspaceService,
} from "./temp-workspace.service";
import type { RenderWorkerConfig } from "./worker-config";
import type {
  ClaimedRenderJob,
  RenderWorkerRepository,
} from "./render-worker.repository";
import type { MediaTransferService } from "./media-transfer.service";
import type { FfmpegRunner } from "./ffmpeg-runner";
import type { FfprobeService } from "./ffprobe.service";

export interface RenderJobProcessResult {
  outcome: "completed" | "failed" | "lease_lost" | "shutdown";
}

export type RenderJobProcessorConfig = Pick<
  RenderWorkerConfig,
  "leaseSeconds" | "heartbeatSeconds"
>;

@Injectable()
export class RenderJobProcessor {
  private readonly logger = new Logger(RenderJobProcessor.name);

  constructor(
    private readonly repository: RenderWorkerRepository,
    private readonly workspaceService: TempWorkspaceService,
    private readonly mediaTransfer: MediaTransferService,
    private readonly ffmpegRunner: FfmpegRunner,
    private readonly ffprobeService: FfprobeService,
    private readonly config: RenderJobProcessorConfig,
  ) {}

  async process(
    claim: ClaimedRenderJob,
    shutdownSignal: AbortSignal,
  ): Promise<RenderJobProcessResult> {
    const workController = new AbortController();
    let leaseLost = false;
    let heartbeatFailure: RenderWorkerError | null = null;
    let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
    let workspace: RenderWorkspace | undefined;

    const terminateWork = (): void => {
      if (!workController.signal.aborted) workController.abort();
      this.ffmpegRunner.terminateActiveProcess();
    };
    const onShutdown = (): void => terminateWork();
    const ensureActive = (): void => {
      if (leaseLost) {
        throw new RenderWorkerError(
          "WORKER_LEASE_LOST",
          "Render worker lease was lost",
        );
      }
      if (workController.signal.aborted) {
        throw new RenderWorkerError("WORKER_SHUTDOWN", "Worker shutdown");
      }
    };
    const heartbeat = async (): Promise<void> => {
      if (workController.signal.aborted || leaseLost) return;
      try {
        const owned = await this.repository.heartbeat({
          jobId: claim.jobId,
          leaseToken: claim.leaseToken,
          leaseSeconds: this.config.leaseSeconds,
        });
        if (!owned) {
          leaseLost = true;
          terminateWork();
        }
      } catch {
        heartbeatFailure = new RenderWorkerError(
          "WORKER_HEARTBEAT_FAILED",
          "Render worker heartbeat failed",
        );
        terminateWork();
      }
    };

    shutdownSignal.addEventListener("abort", onShutdown, { once: true });
    if (shutdownSignal.aborted) onShutdown();
    heartbeatTimer = setInterval(
      () => void heartbeat(),
      this.config.heartbeatSeconds * 1000,
    );

    try {
      workspace = await this.workspaceService.create(claim.jobId);
      ensureActive();
      if (hashRenderSpec(claim.renderSpec) !== claim.specHash) {
        throw new RenderWorkerError(
          "RENDER_SPEC_HASH_MISMATCH",
          "Render spec hash does not match the persisted render",
        );
      }

      const totalDurationSeconds = claim.renderSpec.shots.reduce(
        (sum, shot) => sum + shot.targetDurationSeconds,
        0,
      );
      if (
        !Number.isSafeInteger(totalDurationSeconds) ||
        totalDurationSeconds <= 0
      ) {
        throw new RenderWorkerError(
          "RENDER_SPEC_INVALID",
          "Render duration must be a positive integer",
        );
      }

      const normalizedPaths: string[] = [];
      const shots = [...claim.renderSpec.shots].sort(
        (left, right) => left.sequence - right.sequence,
      );
      for (const [index, shot] of shots.entries()) {
        const name = `shot-${String(index + 1).padStart(4, "0")}`;
        const sourcePath = join(workspace.shotsDir, `${name}.source`);
        const normalizedPath = join(workspace.normalizedDir, `${name}.mp4`);
        ensureActive();
        await this.mediaTransfer.downloadFrozenAsset({
          expected: shot.video,
          destinationPath: sourcePath,
          signal: workController.signal,
        });
        ensureActive();
        await this.ffprobeService.probeVideo(sourcePath, workController.signal);
        ensureActive();
        await this.ffmpegRunner.normalizeShot(
          {
            sourcePath,
            outputPath: normalizedPath,
            durationSeconds: shot.targetDurationSeconds,
          },
          workController.signal,
        );
        ensureActive();
        normalizedPaths.push(normalizedPath);
      }

      ensureActive();
      await this.mediaTransfer.downloadFrozenAsset({
        expected: claim.renderSpec.audio,
        destinationPath: workspace.audioPath,
        signal: workController.signal,
      });
      ensureActive();

      const caption = claim.renderSpec.captions;
      const captionPath = caption
        ? caption.format === "WEBVTT"
          ? workspace.captionVttPath
          : workspace.captionSrtPath
        : null;
      if (caption && captionPath) {
        ensureActive();
        await this.mediaTransfer.downloadFrozenAsset({
          expected: caption,
          destinationPath: captionPath,
          signal: workController.signal,
        });
        ensureActive();
      }

      ensureActive();
      await this.ffmpegRunner.concatenate(
        normalizedPaths,
        workspace.concatListPath,
        workspace.concatenatedVideoPath,
        workController.signal,
      );
      ensureActive();
      await this.ffmpegRunner.muxFinal(
        {
          concatenatedVideoPath: workspace.concatenatedVideoPath,
          audioPath: workspace.audioPath,
          captionPath,
          captionFormat: caption?.format ?? null,
          durationSeconds: totalDurationSeconds,
          outputPath: workspace.finalOutputPath,
        },
        workController.signal,
      );
      ensureActive();
      await this.ffprobeService.verifyMaster(
        {
          path: workspace.finalOutputPath,
          expectedDurationSeconds: totalDurationSeconds,
          captionsExpected: caption !== null,
        },
        workController.signal,
      );
      ensureActive();
      const uploaded = await this.mediaTransfer.uploadRenderOutput({
        storageKey: claim.outputAsset.storageKey,
        sourcePath: workspace.finalOutputPath,
        signal: workController.signal,
      });
      ensureActive();
      const completed = await this.repository.completeJob({
        jobId: claim.jobId,
        leaseToken: claim.leaseToken,
        byteSize: uploaded.byteSize,
        etag: uploaded.etag,
      });
      return { outcome: completed };
    } catch (error) {
      if (leaseLost) return { outcome: "lease_lost" };
      const shutdown = shutdownSignal.aborted;
      const failure = shutdown
        ? new RenderWorkerError("WORKER_SHUTDOWN", "Worker shutdown")
        : (heartbeatFailure ??
          (error instanceof RenderWorkerError
            ? error
            : new RenderWorkerError(
                "RENDER_WORKER_FAILED",
                "Render worker failed",
              )));
      const result = await this.repository.failJob({
        jobId: claim.jobId,
        leaseToken: claim.leaseToken,
        errorCode: failure.code,
        errorMessage: failure.message,
      });
      return {
        outcome:
          result === "lease_lost"
            ? "lease_lost"
            : shutdown
              ? "shutdown"
              : "failed",
      };
    } finally {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      shutdownSignal.removeEventListener("abort", onShutdown);
      if (workspace) {
        try {
          await this.workspaceService.remove(workspace);
        } catch {
          this.logger.warn("Render workspace cleanup failed");
        }
      }
    }
  }
}
