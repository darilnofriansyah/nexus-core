import { Controller, Get } from '@nestjs/common';
import { ok } from '../common/dto/api-response.dto';
import { readEnv } from '../config/env';

@Controller('health')
export class HealthController {
  @Get()
  check() {
    const env = readEnv();

    return ok({
      service: 'veyra-core-api',
      status: 'ok',
      environment: env.nodeEnv,
    });
  }
}

