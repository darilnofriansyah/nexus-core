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
  runwareWebhookBaseUrl?: string;
  runwareWebhookToken?: string;
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
    runwareWebhookBaseUrl: process.env.RUNWARE_WEBHOOK_BASE_URL,
    runwareWebhookToken: process.env.RUNWARE_WEBHOOK_TOKEN,
  };
}
