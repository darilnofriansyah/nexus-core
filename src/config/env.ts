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
  };
}
