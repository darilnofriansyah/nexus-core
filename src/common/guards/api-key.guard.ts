import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';
import { readEnv } from '../../config/env';

@Injectable()
export class ApiKeyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
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

