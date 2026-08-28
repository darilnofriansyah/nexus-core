import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { readEnv } from '../../config/env';
import { SKIP_CORE_API_KEY } from '../decorators/skip-core-api-key.decorator';

@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const skip = this.reflector.getAllAndOverride<boolean>(
      SKIP_CORE_API_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (skip) {
      return true;
    }

    const expectedApiKey = readEnv().coreApiKey;

    if (!expectedApiKey) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const providedApiKey = request.header('x-core-api-key');

    if (providedApiKey === expectedApiKey) {
      return true;
    }

    throw new UnauthorizedException('Invalid Core API key');
  }
}
