import * as assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { r2S3ClientProvider } from './r2-storage.providers';

const r2EnvKeys = [
  'R2_ACCOUNT_ID',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'R2_BUCKET',
  'R2_PRESIGN_TTL_SECONDS',
] as const;
const originalR2Env = new Map(
  r2EnvKeys.map((key) => [key, process.env[key]]),
);

function createClient() {
  return (r2S3ClientProvider as { useFactory: () => unknown }).useFactory();
}

afterEach(() => {
  for (const key of r2EnvKeys) {
    const value = originalR2Env.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('R2 storage providers', () => {
  test('allows Core to boot without R2 but rejects partial or invalid configuration', () => {
    for (const key of r2EnvKeys) delete process.env[key];
    assert.equal(createClient(), null);

    process.env.R2_ACCOUNT_ID = 'account';
    assert.throws(createClient, /R2 configuration is incomplete/);

    process.env.R2_ACCESS_KEY_ID = 'key';
    process.env.R2_SECRET_ACCESS_KEY = 'secret';
    process.env.R2_BUCKET = 'bucket';
    process.env.R2_PRESIGN_TTL_SECONDS = '59';
    assert.throws(createClient, /R2_PRESIGN_TTL_SECONDS/);
  });
});
