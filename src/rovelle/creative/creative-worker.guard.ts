import { timingSafeEqual } from "node:crypto";
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import type { Request } from "express";
import { readEnv } from "../../config/env";

@Injectable()
export class CreativeWorkerGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const env = readEnv();
    const expected = env.rovelleCreativeWorkerKey;
    if (
      !env.rovelleCreativeEnabled ||
      !expected ||
      Buffer.byteLength(expected) < 32
    ) {
      throw new ServiceUnavailableException(
        "Creative worker access is not configured",
      );
    }

    const request = context.switchToHttp().getRequest<Request>();
    const provided = request.header("x-rovelle-worker-key");
    if (typeof provided !== "string" || !sameSecret(expected, provided)) {
      throw new UnauthorizedException("Invalid creative worker key");
    }

    return true;
  }
}

function sameSecret(expected: string, provided: string): boolean {
  const expectedBytes = Buffer.from(expected, "utf8");
  const providedBytes = Buffer.from(provided, "utf8");
  return (
    expectedBytes.length === providedBytes.length &&
    timingSafeEqual(expectedBytes, providedBytes)
  );
}
