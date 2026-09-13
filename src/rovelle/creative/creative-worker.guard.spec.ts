import "reflect-metadata";
import * as assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  ServiceUnavailableException,
  UnauthorizedException,
  type ExecutionContext,
} from "@nestjs/common";
import type { Request } from "express";
import { CreativeWorkerGuard } from "./creative-worker.guard";

const ENV_KEYS = [
  "ROVELLE_CREATIVE_ENABLED",
  "ROVELLE_CREATIVE_WORKER_KEY",
] as const;
const originalEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = originalEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function contextFor(providedKey?: string): ExecutionContext {
  const request = {
    header: (name: string) =>
      name === "x-rovelle-worker-key" ? providedKey : undefined,
  } as unknown as Request;
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

test("fails closed when the creative worker key is not configured", () => {
  process.env.ROVELLE_CREATIVE_ENABLED = "true";
  delete process.env.ROVELLE_CREATIVE_WORKER_KEY;

  assert.throws(
    () => new CreativeWorkerGuard().canActivate(contextFor("anything")),
    ServiceUnavailableException,
  );
});

test("rejects an absent or wrong worker header", () => {
  process.env.ROVELLE_CREATIVE_ENABLED = "true";
  process.env.ROVELLE_CREATIVE_WORKER_KEY =
    "worker-secret-0123456789-0123456789";
  const guard = new CreativeWorkerGuard();

  assert.throws(() => guard.canActivate(contextFor()), UnauthorizedException);
  assert.throws(
    () => guard.canActivate(contextFor("wrong-length")),
    UnauthorizedException,
  );
  assert.throws(
    () => guard.canActivate(contextFor("worker-secret-0123456789-0123456788")),
    UnauthorizedException,
  );
});

test("allows an exact worker key match", () => {
  const key = "worker-secret-0123456789-0123456789";
  process.env.ROVELLE_CREATIVE_ENABLED = "true";
  process.env.ROVELLE_CREATIVE_WORKER_KEY = key;

  assert.equal(new CreativeWorkerGuard().canActivate(contextFor(key)), true);
});

test("worker routes remain closed while creative mode is disabled", () => {
  delete process.env.ROVELLE_CREATIVE_ENABLED;
  process.env.ROVELLE_CREATIVE_WORKER_KEY =
    "worker-secret-0123456789-0123456789";

  assert.throws(
    () =>
      new CreativeWorkerGuard().canActivate(
        contextFor(process.env.ROVELLE_CREATIVE_WORKER_KEY),
      ),
    ServiceUnavailableException,
  );
});
