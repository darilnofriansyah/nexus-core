import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { readEnv } from '../config/env';

@Injectable()
export class DatabaseService implements OnModuleDestroy {
  private readonly pool?: Pool;

  constructor() {
    const env = readEnv();

    if (env.databaseUrl) {
      this.pool = new Pool({ connectionString: env.databaseUrl });
    }
  }

  get isConfigured(): boolean {
    return Boolean(this.pool);
  }

  async query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values: unknown[] = [],
  ): Promise<QueryResult<T>> {
    if (!this.pool) {
      throw new Error('DATABASE_URL is not configured');
    }

    return this.pool.query<T>(text, values);
  }

  async withTransaction<T>(
    callback: (client: Pick<PoolClient, 'query'>) => Promise<T>,
  ): Promise<T> {
    if (!this.pool) {
      throw new Error('DATABASE_URL is not configured');
    }

    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async onModuleDestroy() {
    await this.pool?.end();
  }
}
