import { readEnv } from "../config/env";

export interface RenderWorkerConfig {
  workerId: string;
  pollMs: number;
  leaseSeconds: number;
  heartbeatSeconds: number;
  recoverySeconds: number;
  tempDir: string;
  ffmpegPath: string;
  ffprobePath: string;
}

function boundedInteger(
  name: string,
  value: number | undefined,
  minimum: number,
  maximum: number,
): number {
  if (
    value === undefined ||
    !Number.isInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new Error(`Invalid render worker ${name}`);
  }
  return value;
}

function nonblank(name: string, value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) throw new Error(`Invalid render worker ${name}`);
  return trimmed;
}

export function readRenderWorkerConfig(): RenderWorkerConfig {
  const env = readEnv();
  const workerId = nonblank("worker ID", env.renderWorkerId);
  if (workerId.length > 120) throw new Error("Invalid render worker ID");

  const pollMs = boundedInteger("poll interval", env.renderWorkerPollMs, 250, 60000);
  const leaseSeconds = boundedInteger(
    "lease duration",
    env.renderWorkerLeaseSeconds,
    60,
    900,
  );
  const heartbeatSeconds = env.renderWorkerHeartbeatSeconds;
  if (
    heartbeatSeconds === undefined ||
    !Number.isInteger(heartbeatSeconds) ||
    heartbeatSeconds <= 0 ||
    heartbeatSeconds >= leaseSeconds / 2
  ) {
    throw new Error("Invalid render worker heartbeat interval");
  }

  return {
    workerId,
    pollMs,
    leaseSeconds,
    heartbeatSeconds,
    recoverySeconds: boundedInteger(
      "recovery interval",
      env.renderWorkerRecoverySeconds,
      10,
      300,
    ),
    tempDir: nonblank("temporary directory", env.renderWorkerTempDir),
    ffmpegPath: nonblank("ffmpeg path", env.renderFfmpegPath),
    ffprobePath: nonblank("ffprobe path", env.renderFfprobePath),
  };
}
