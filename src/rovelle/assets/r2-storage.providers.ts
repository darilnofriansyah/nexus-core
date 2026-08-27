import { S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Provider } from '@nestjs/common';
import { readEnv } from '../../config/env';

export const R2_S3_CLIENT = Symbol('R2_S3_CLIENT');
export const R2_URL_SIGNER = Symbol('R2_URL_SIGNER');

export type R2UrlSigner = typeof getSignedUrl;

export const r2S3ClientProvider: Provider = {
  provide: R2_S3_CLIENT,
  useFactory: (): S3Client | null => {
    const env = readEnv();
    const values = [
      env.r2AccountId,
      env.r2AccessKeyId,
      env.r2SecretAccessKey,
      env.r2Bucket,
    ];
    const configuredCount = values.filter(Boolean).length;

    if (configuredCount === 0) return null;
    if (configuredCount !== values.length) {
      throw new Error('R2 configuration is incomplete');
    }
    if (
      !Number.isInteger(env.r2PresignTtlSeconds) ||
      env.r2PresignTtlSeconds < 60 ||
      env.r2PresignTtlSeconds > 3600
    ) {
      throw new Error(
        'R2_PRESIGN_TTL_SECONDS must be an integer from 60 to 3600',
      );
    }

    return new S3Client({
      region: 'auto',
      endpoint: `https://${env.r2AccountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: env.r2AccessKeyId!,
        secretAccessKey: env.r2SecretAccessKey!,
      },
    });
  },
};

export const r2UrlSignerProvider: Provider = {
  provide: R2_URL_SIGNER,
  useValue: getSignedUrl,
};
