import { hostname } from "node:os";

export interface CoreApiEnv {
  nodeEnv: string;
  port: number;
  databaseUrl?: string;
  prismaDatabasePoolMax: number;
  prismaDatabaseConnectionTimeoutMs: number;
  coreApiKey?: string;
  openAiApiKey?: string;
  openAiTimeoutMs: number;
  veyraMiniAppBaseUrl?: string;
  r2AccountId?: string;
  r2AccessKeyId?: string;
  r2SecretAccessKey?: string;
  r2Bucket?: string;
  r2PresignTtlSeconds: number;
  runwareApiKey?: string;
  runwareApiBaseUrl: string;
  runwareVideoModel: string;
  runwareSubmitTimeoutMs: number;
  runwareWebhookBaseUrl?: string;
  runwareWebhookToken?: string;
  renderWorkerId?: string;
  renderWorkerPollMs?: number;
  renderWorkerLeaseSeconds?: number;
  renderWorkerHeartbeatSeconds?: number;
  renderWorkerRecoverySeconds?: number;
  renderWorkerTempDir?: string;
  renderFfmpegPath?: string;
  renderFfprobePath?: string;
}

export function readEnv(): CoreApiEnv {
  return {
    nodeEnv: process.env.NODE_ENV ?? "development",
    port: Number(process.env.PORT ?? 3001),
    databaseUrl: process.env.DATABASE_URL,
    prismaDatabasePoolMax: Number(process.env.PRISMA_DATABASE_POOL_MAX ?? 5),
    prismaDatabaseConnectionTimeoutMs: Number(
      process.env.PRISMA_DATABASE_CONNECTION_TIMEOUT_MS ?? 5000,
    ),
    coreApiKey: process.env.CORE_API_KEY,
    openAiApiKey: process.env.OPENAI_API_KEY,
    openAiTimeoutMs: Number(process.env.OPENAI_TIMEOUT_MS ?? 20000),
    veyraMiniAppBaseUrl: process.env.VEYRA_MINI_APP_BASE_URL,
    r2AccountId: process.env.R2_ACCOUNT_ID,
    r2AccessKeyId: process.env.R2_ACCESS_KEY_ID,
    r2SecretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    r2Bucket: process.env.R2_BUCKET,
    r2PresignTtlSeconds: Number(process.env.R2_PRESIGN_TTL_SECONDS ?? 900),
    runwareApiKey: process.env.RUNWARE_API_KEY,
    runwareApiBaseUrl:
      process.env.RUNWARE_API_BASE_URL ?? "https://api.runware.ai/v1",
    runwareVideoModel: process.env.RUNWARE_VIDEO_MODEL ?? "vidu:2@0",
    runwareSubmitTimeoutMs: Number(
      process.env.RUNWARE_SUBMIT_TIMEOUT_MS ?? 15000,
    ),
    runwareWebhookBaseUrl: process.env.RUNWARE_WEBHOOK_BASE_URL,
    runwareWebhookToken: process.env.RUNWARE_WEBHOOK_TOKEN,
    renderWorkerId: process.env.RENDER_WORKER_ID?.trim() || hostname(),
    renderWorkerPollMs: Number(process.env.RENDER_WORKER_POLL_MS ?? 2000),
    renderWorkerLeaseSeconds: Number(
      process.env.RENDER_WORKER_LEASE_SECONDS ?? 120,
    ),
    renderWorkerHeartbeatSeconds: Number(
      process.env.RENDER_WORKER_HEARTBEAT_SECONDS ?? 30,
    ),
    renderWorkerRecoverySeconds: Number(
      process.env.RENDER_WORKER_RECOVERY_SECONDS ?? 30,
    ),
    renderWorkerTempDir:
      process.env.RENDER_WORKER_TEMP_DIR ?? "/tmp/rovelle-render-worker",
    renderFfmpegPath: process.env.RENDER_FFMPEG_PATH ?? "/usr/bin/ffmpeg",
    renderFfprobePath: process.env.RENDER_FFPROBE_PATH ?? "/usr/bin/ffprobe",
  };
}
