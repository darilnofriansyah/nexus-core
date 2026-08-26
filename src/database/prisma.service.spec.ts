import * as assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { PrismaService } from './prisma.service';

const originalDatabaseUrl = process.env.DATABASE_URL;
const originalPoolMax = process.env.PRISMA_DATABASE_POOL_MAX;
const originalConnectionTimeout =
  process.env.PRISMA_DATABASE_CONNECTION_TIMEOUT_MS;

afterEach(() => {
  if (originalDatabaseUrl === undefined) {
    delete process.env.DATABASE_URL;
  } else {
    process.env.DATABASE_URL = originalDatabaseUrl;
  }

  if (originalPoolMax === undefined) {
    delete process.env.PRISMA_DATABASE_POOL_MAX;
  } else {
    process.env.PRISMA_DATABASE_POOL_MAX = originalPoolMax;
  }

  if (originalConnectionTimeout === undefined) {
    delete process.env.PRISMA_DATABASE_CONNECTION_TIMEOUT_MS;
  } else {
    process.env.PRISMA_DATABASE_CONNECTION_TIMEOUT_MS =
      originalConnectionTimeout;
  }
});

describe('PrismaService', () => {
  test('stays unconfigured when DATABASE_URL is absent', async () => {
    delete process.env.DATABASE_URL;

    const service = new PrismaService();

    assert.equal(service.isConfigured, false);
    assert.throws(
      () => service.client,
      /DATABASE_URL is not configured/,
    );

    await service.onModuleDestroy();
  });

  test('constructs a Prisma client when DATABASE_URL is configured', async () => {
    process.env.DATABASE_URL =
      'postgresql://postgres:postgres@127.0.0.1:5432/nexus_test';
    process.env.PRISMA_DATABASE_POOL_MAX = '3';
    process.env.PRISMA_DATABASE_CONNECTION_TIMEOUT_MS = '2500';

    const service = new PrismaService();

    assert.equal(service.isConfigured, true);
    assert.ok(service.client);

    await service.onModuleDestroy();
  });
});
