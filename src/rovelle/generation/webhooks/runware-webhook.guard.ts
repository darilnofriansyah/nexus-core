import { timingSafeEqual } from "node:crypto";
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import type { Request } from "express";
import { readEnv } from "../../../config/env";

const MIN_WEBHOOK_TOKEN_LENGTH = 32;

@Injectable()
export class RunwareWebhookGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const configuredToken = readEnv().runwareWebhookToken?.trim();
    if (
      !configuredToken ||
      configuredToken.length < MIN_WEBHOOK_TOKEN_LENGTH
    ) {
      throw new ServiceUnavailableException(
        "Runware webhook token is not configured",
      );
    }

    const request = context.switchToHttp().getRequest<Request>();
    const providedToken = request.query?.token;

    if (
      typeof providedToken !== "string" ||
      !matchesToken(configuredToken, providedToken)
    ) {
      throw new UnauthorizedException("Invalid Runware webhook token");
    }

    return true;
  }
}

function matchesToken(expected: string, provided: string): boolean {
  const expectedBuffer = Buffer.from(expected, "utf8");
  const providedBuffer = Buffer.from(provided, "utf8");

  return (
    expectedBuffer.length === providedBuffer.length &&
    timingSafeEqual(expectedBuffer, providedBuffer)
  );
}
