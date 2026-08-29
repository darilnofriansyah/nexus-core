import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import {
  Inject,
  Injectable,
  OnModuleDestroy,
  ServiceUnavailableException,
} from '@nestjs/common';
import { readEnv } from '../../config/env';
import {
  R2_S3_CLIENT,
  R2_URL_SIGNER,
  R2UrlSigner,
} from './r2-storage.providers';

export interface R2PresignedRequest {
  method: 'PUT' | 'GET';
  url: string;
  headers: Record<string, string>;
  expiresAt: string;
}

export interface R2ObjectMetadata {
  byteSize: bigint;
  etag: string | null;
  contentType: string | null;
}

function isNotFoundError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;

  const candidate = error as {
    name?: unknown;
    $metadata?: { httpStatusCode?: unknown };
  };
  return (
    candidate.name === 'NotFound' || candidate.$metadata?.httpStatusCode === 404
  );
}

@Injectable()
export class R2StorageService implements OnModuleDestroy {
  constructor(
    @Inject(R2_S3_CLIENT)
    private readonly client: S3Client | null,
    @Inject(R2_URL_SIGNER)
    private readonly signer: R2UrlSigner,
  ) {}

  assertConfigured(): S3Client {
    if (!this.client) {
      throw new ServiceUnavailableException('R2 storage is not configured');
    }

    return this.client;
  }

  async createPutUrl(
    key: string,
    contentType: string,
  ): Promise<R2PresignedRequest> {
    const env = readEnv();
    const client = this.assertConfigured();
    const url = await this.signer(
      client,
      new PutObjectCommand({
        Bucket: env.r2Bucket!,
        Key: key,
        ContentType: contentType,
      }),
      {
        expiresIn: env.r2PresignTtlSeconds,
        signableHeaders: new Set(['content-type']),
      },
    );

    return {
      method: 'PUT',
      url,
      headers: { 'content-type': contentType },
      expiresAt: new Date(
        Date.now() + env.r2PresignTtlSeconds * 1000,
      ).toISOString(),
    };
  }

  async createProviderPutUrl(key: string): Promise<R2PresignedRequest> {
    const env = readEnv();
    const client = this.assertConfigured();
    const url = await this.signer(
      client,
      new PutObjectCommand({
        Bucket: env.r2Bucket!,
        Key: key,
      }),
      { expiresIn: env.r2PresignTtlSeconds },
    );

    return {
      method: 'PUT',
      url,
      headers: {},
      expiresAt: new Date(
        Date.now() + env.r2PresignTtlSeconds * 1000,
      ).toISOString(),
    };
  }

  async createGetUrl(key: string): Promise<R2PresignedRequest> {
    const env = readEnv();
    const client = this.assertConfigured();
    const url = await this.signer(
      client,
      new GetObjectCommand({
        Bucket: env.r2Bucket!,
        Key: key,
      }),
      { expiresIn: env.r2PresignTtlSeconds },
    );

    return {
      method: 'GET',
      url,
      headers: {},
      expiresAt: new Date(
        Date.now() + env.r2PresignTtlSeconds * 1000,
      ).toISOString(),
    };
  }

  async headObject(key: string): Promise<R2ObjectMetadata | null> {
    const env = readEnv();
    const client = this.assertConfigured();

    try {
      const output = await client.send(
        new HeadObjectCommand({
          Bucket: env.r2Bucket!,
          Key: key,
        }),
      );

      return {
        byteSize: BigInt(output.ContentLength ?? 0),
        etag: output.ETag?.replace(/^"|"$/g, '') ?? null,
        contentType: output.ContentType ?? null,
      };
    } catch (error) {
      if (isNotFoundError(error)) return null;
      throw error;
    }
  }

  onModuleDestroy(): void {
    this.client?.destroy();
  }
}
