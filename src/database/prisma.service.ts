import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { readEnv } from '../config/env';
import { PrismaClient } from '../generated/prisma/client';

@Injectable()
export class PrismaService implements OnModuleDestroy {
  private readonly prisma?: PrismaClient;

  constructor() {
    const env = readEnv();

    if (env.databaseUrl) {
      const adapter = new PrismaPg({
        connectionString: env.databaseUrl,
        max: env.prismaDatabasePoolMax,
        connectionTimeoutMillis: env.prismaDatabaseConnectionTimeoutMs,
      });

      this.prisma = new PrismaClient({ adapter });
    }
  }

  get isConfigured(): boolean {
    return Boolean(this.prisma);
  }

  get client(): PrismaClient {
    if (!this.prisma) {
      throw new Error('DATABASE_URL is not configured');
    }

    return this.prisma;
  }

  async onModuleDestroy(): Promise<void> {
    await this.prisma?.$disconnect();
  }
}
