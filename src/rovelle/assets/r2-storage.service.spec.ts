import * as assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { ServiceUnavailableException } from '@nestjs/common';
import { R2UrlSigner } from './r2-storage.providers';
import { R2StorageService } from './r2-storage.service';

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

type StubCommand = PutObjectCommand | GetObjectCommand | HeadObjectCommand;

class StubS3Client {
  readonly commands: StubCommand[] = [];
  response: unknown = {};
  error: unknown;
  destroyed = false;

  async send(command: StubCommand): Promise<unknown> {
    this.commands.push(command);
    if (this.error) throw this.error;
    return this.response;
  }

  destroy(): void {
    this.destroyed = true;
  }
}

interface SignerCall {
  command: Parameters<R2UrlSigner>[1];
  options: Parameters<R2UrlSigner>[2] | undefined;
}

function createSigner(url = 'https://signed.example/object'): {
  signer: R2UrlSigner;
  calls: SignerCall[];
} {
  const calls: SignerCall[] = [];
  const signer = (async (
    _client: Parameters<R2UrlSigner>[0],
    command: Parameters<R2UrlSigner>[1],
    options?: Parameters<R2UrlSigner>[2],
  ) => {
    calls.push({ command, options });
    return url;
  }) as R2UrlSigner;

  return { signer, calls };
}

function configureR2(ttl?: string): void {
  process.env.R2_ACCOUNT_ID = 'account';
  process.env.R2_ACCESS_KEY_ID = 'access-key';
  process.env.R2_SECRET_ACCESS_KEY = 'secret-key';
  process.env.R2_BUCKET = 'private-bucket';
  if (ttl === undefined) delete process.env.R2_PRESIGN_TTL_SECONDS;
  else process.env.R2_PRESIGN_TTL_SECONDS = ttl;
}

function createService(client: StubS3Client | null, signer: R2UrlSigner) {
  return new R2StorageService(
    client as unknown as S3Client | null,
    signer,
  );
}

afterEach(() => {
  for (const key of r2EnvKeys) {
    const value = originalR2Env.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('R2 storage service', () => {
  test('rejects every storage operation when R2 is unconfigured', async () => {
    for (const key of r2EnvKeys) delete process.env[key];
    const { signer } = createSigner();
    const service = createService(null, signer);

    assert.throws(
      () => service.assertConfigured(),
      ServiceUnavailableException,
    );
    await assert.rejects(
      () => service.createPutUrl('asset/key', 'image/png'),
      ServiceUnavailableException,
    );
    await assert.rejects(
      () => service.createGetUrl('asset/key'),
      ServiceUnavailableException,
    );
    await assert.rejects(
      () => service.headObject('asset/key'),
      ServiceUnavailableException,
    );
  });

  test('signs PUT with the exact content type and returns that header', async () => {
    configureR2('1200');
    const client = new StubS3Client();
    const { signer, calls } = createSigner('https://signed.example/put');
    const service = createService(client, signer);
    const before = Date.now();

    const result = await service.createPutUrl(
      'episodes/episode-1/source.mp4',
      'video/mp4',
    );
    const after = Date.now();

    assert.equal(calls.length, 1);
    assert.ok(calls[0].command instanceof PutObjectCommand);
    assert.deepEqual(calls[0].command.input, {
      Bucket: 'private-bucket',
      Key: 'episodes/episode-1/source.mp4',
      ContentType: 'video/mp4',
    });
    assert.deepEqual(calls[0].options, {
      expiresIn: 1200,
      signableHeaders: new Set(['content-type']),
    });
    assert.equal(result.method, 'PUT');
    assert.equal(result.url, 'https://signed.example/put');
    assert.deepEqual(result.headers, { 'content-type': 'video/mp4' });
    assert.ok(
      Date.parse(result.expiresAt) >= before + 1200 * 1000,
    );
    assert.ok(Date.parse(result.expiresAt) <= after + 1200 * 1000);
  });

  test('signs GET with the bucket and key and no request headers', async () => {
    configureR2();
    const client = new StubS3Client();
    const { signer, calls } = createSigner('https://signed.example/get');
    const service = createService(client, signer);

    const result = await service.createGetUrl('episodes/episode-1/source.mp4');

    assert.equal(calls.length, 1);
    assert.ok(calls[0].command instanceof GetObjectCommand);
    assert.deepEqual(calls[0].command.input, {
      Bucket: 'private-bucket',
      Key: 'episodes/episode-1/source.mp4',
    });
    assert.deepEqual(calls[0].options, { expiresIn: 900 });
    assert.equal(result.method, 'GET');
    assert.equal(result.url, 'https://signed.example/get');
    assert.deepEqual(result.headers, {});
    assert.ok(Number.isFinite(Date.parse(result.expiresAt)));
  });

  test('normalizes HEAD metadata and strips quoted ETags', async () => {
    configureR2();
    const client = new StubS3Client();
    client.response = {
      ContentLength: 42,
      ETag: '"etag-42"',
      ContentType: 'image/png',
    };
    const { signer } = createSigner();
    const service = createService(client, signer);

    const result = await service.headObject('episodes/episode-1/source.png');

    assert.ok(client.commands[0] instanceof HeadObjectCommand);
    assert.deepEqual(client.commands[0].input, {
      Bucket: 'private-bucket',
      Key: 'episodes/episode-1/source.png',
    });
    assert.deepEqual(result, {
      byteSize: 42n,
      etag: 'etag-42',
      contentType: 'image/png',
    });
  });

  test('returns null for NotFound and HTTP 404 errors', async () => {
    configureR2();
    const client = new StubS3Client();
    const { signer } = createSigner();
    const service = createService(client, signer);

    client.error = Object.assign(new Error('missing'), { name: 'NotFound' });
    assert.equal(await service.headObject('missing-by-name'), null);

    client.error = Object.assign(new Error('missing'), {
      $metadata: { httpStatusCode: 404 },
    });
    assert.equal(await service.headObject('missing-by-status'), null);
  });

  test('rethrows forbidden and unexpected HEAD errors', async () => {
    configureR2();
    const client = new StubS3Client();
    const { signer } = createSigner();
    const service = createService(client, signer);
    const forbidden = Object.assign(new Error('forbidden'), {
      $metadata: { httpStatusCode: 403 },
    });
    const unexpected = new Error('network failure');

    client.error = forbidden;
    await assert.rejects(
      () => service.headObject('forbidden'),
      (error) => error === forbidden,
    );

    client.error = unexpected;
    await assert.rejects(
      () => service.headObject('unexpected'),
      (error) => error === unexpected,
    );
  });

  test('destroys the configured S3 client on module shutdown', () => {
    configureR2();
    const client = new StubS3Client();
    const { signer } = createSigner();
    const service = createService(client, signer);

    service.onModuleDestroy();

    assert.equal(client.destroyed, true);
  });
});
