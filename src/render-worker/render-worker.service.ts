import { Inject, Injectable, Logger } from "@nestjs/common";

import { FfmpegRunner } from "./ffmpeg-runner";
import {
  RenderJobProcessor,
  type RenderJobProcessResult,
} from "./render-job.processor";
import { FfprobeService } from "./ffprobe.service";
import {
  RenderWorkerRepository,
  type ClaimedRenderJob,
} from "./render-worker.repository";
import { TempWorkspaceService } from "./temp-workspace.service";
import type { RenderWorkerConfig } from "./worker-config";

export const RENDER_WORKER_CONFIG = Symbol("RENDER_WORKER_CONFIG");
export const RENDER_WORKER_SLEEP = Symbol("RENDER_WORKER_SLEEP");

export type RenderWorkerSleep = (
  delayMs: number,
  signal: AbortSignal,
) => Promise<void>;

export const renderWorkerSleep: RenderWorkerSleep = (delayMs, signal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }

    const timer = setTimeout(finish, delayMs);
    signal.addEventListener("abort", finish, { once: true });

    function finish(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    }
  });

@Injectable()
export class RenderWorkerService {
  private readonly logger = new Logger(RenderWorkerService.name);
  private readonly shutdownController = new AbortController();
  private stopping = false;
  private runPromise: Promise<void> | null = null;
  private recoveryPromise: Promise<void> | null = null;

  constructor(
    private readonly repository: RenderWorkerRepository,
    private readonly processor: RenderJobProcessor,
    private readonly workspaceService: TempWorkspaceService,
    private readonly ffmpegRunner: FfmpegRunner,
    private readonly ffprobeService: FfprobeService,
    @Inject(RENDER_WORKER_CONFIG)
    private readonly config: RenderWorkerConfig,
    @Inject(RENDER_WORKER_SLEEP)
    private readonly sleep: RenderWorkerSleep = renderWorkerSleep,
  ) {}

  run(): Promise<void> {
    if (!this.runPromise) this.runPromise = this.runLoop();
    return this.runPromise;
  }

  requestShutdown(): void {
    if (this.stopping) return;
    this.stopping = true;
    this.shutdownController.abort();
    this.ffmpegRunner.terminateActiveProcess();
  }

  private async runLoop(): Promise<void> {
    if (this.stopping) return;

    await this.startup();
    if (this.stopping) return;

    const recoveryTimer = setInterval(
      () => this.startRecovery(),
      this.config.recoverySeconds * 1000,
    );

    try {
      while (!this.stopping) {
        let job;
        try {
          job = await this.repository.claimNext({
            workerId: this.config.workerId,
            leaseSeconds: this.config.leaseSeconds,
          });
        } catch (error) {
          if (this.stopping) break;
          this.logWorker("claim_failed", safeErrorCode(error, "CLAIM_FAILED"));
          await this.waitForPoll();
          continue;
        }

        if (!job) {
          await this.waitForPoll();
          continue;
        }

        await this.processJob(job);
      }
    } finally {
      clearInterval(recoveryTimer);
      if (this.recoveryPromise) await this.recoveryPromise;
    }
  }

  private async startup(): Promise<void> {
    const startedAt = Date.now();
    try {
      // cleanupStale first ensures the configured root, then removes old job dirs.
      await this.workspaceService.cleanupStale();
      await this.ffmpegRunner.verifyBinary();
      await this.ffprobeService.verifyBinary();
      await this.repository.recoverExpiredLeases();
    } catch (error) {
      this.logWorker(
        "startup_failed",
        safeErrorCode(error, "WORKER_STARTUP_FAILED"),
        Date.now() - startedAt,
      );
      throw error;
    }
  }

  private async processJob(job: ClaimedRenderJob): Promise<void> {
    const startedAt = Date.now();
    try {
      const result = await this.processor.process(
        job,
        this.shutdownController.signal,
      );
      this.logJob(job.jobId, job.renderId, result, Date.now() - startedAt);
    } catch (error) {
      this.logJob(
        job.jobId,
        job.renderId,
        {
          outcome: this.stopping ? "shutdown" : "failed",
          errorCode: safeErrorCode(error, "RENDER_WORKER_FAILED"),
        },
        Date.now() - startedAt,
      );
    }
  }

  private async waitForPoll(): Promise<void> {
    try {
      await this.sleep(this.config.pollMs, this.shutdownController.signal);
    } catch (error) {
      if (!this.stopping) throw error;
    }
  }

  private startRecovery(): void {
    if (this.stopping || this.recoveryPromise) return;

    const task = this.repository
      .recoverExpiredLeases()
      .then(() => undefined)
      .catch((error: unknown) => {
        this.logWorker(
          "recovery_failed",
          safeErrorCode(error, "RECOVERY_FAILED"),
        );
      });
    this.recoveryPromise = task;
    void task.then(() => {
      if (this.recoveryPromise === task) this.recoveryPromise = null;
    });
  }

  private logJob(
    jobId: string,
    renderId: string,
    result: RenderJobProcessResult | { outcome: string; errorCode: string },
    elapsedMs: number,
  ): void {
    const fields: Record<string, string | number> = {
      workerId: this.config.workerId,
      jobId,
      renderId,
      outcome: result.outcome,
      elapsedMs: Math.max(0, elapsedMs),
    };
    if ("errorCode" in result)
      fields.errorCode = sanitizeErrorCode(result.errorCode);
    this.logger.log(JSON.stringify(fields));
  }

  private logWorker(outcome: string, errorCode: string, elapsedMs = 0): void {
    this.logger.log(
      JSON.stringify({
        workerId: this.config.workerId,
        outcome,
        errorCode: sanitizeErrorCode(errorCode),
        elapsedMs: Math.max(0, elapsedMs),
      }),
    );
  }
}

function safeErrorCode(error: unknown, fallback: string): string {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return fallback;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string"
    ? sanitizeErrorCode(code) || fallback
    : fallback;
}

function sanitizeErrorCode(value: string): string {
  return value.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 120);
}
