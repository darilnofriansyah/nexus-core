import { SetMetadata } from '@nestjs/common';

export const SKIP_CORE_API_KEY = 'nexus.skipCoreApiKey';

export const SkipCoreApiKey = () =>
  SetMetadata(SKIP_CORE_API_KEY, true);
