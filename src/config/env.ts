export interface CoreApiEnv {
  nodeEnv: string;
  port: number;
  databaseUrl?: string;
  coreApiKey?: string;
  openAiApiKey?: string;
  openAiTimeoutMs: number;
}

export function readEnv(): CoreApiEnv {
  return {
    nodeEnv: process.env.NODE_ENV ?? 'development',
    port: Number(process.env.PORT ?? 3001),
    databaseUrl: process.env.DATABASE_URL,
    coreApiKey: process.env.CORE_API_KEY,
    openAiApiKey: process.env.OPENAI_API_KEY,
    openAiTimeoutMs: Number(process.env.OPENAI_TIMEOUT_MS ?? 20000),
  };
}
