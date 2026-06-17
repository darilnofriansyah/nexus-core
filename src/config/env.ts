export interface CoreApiEnv {
  nodeEnv: string;
  port: number;
  databaseUrl?: string;
  coreApiKey?: string;
}

export function readEnv(): CoreApiEnv {
  return {
    nodeEnv: process.env.NODE_ENV ?? 'development',
    port: Number(process.env.PORT ?? 3001),
    databaseUrl: process.env.DATABASE_URL,
    coreApiKey: process.env.CORE_API_KEY,
  };
}

