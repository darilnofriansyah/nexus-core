import * as assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  ExecutionContext,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import { Request } from "express";
import { RunwareWebhookGuard } from "./runware-webhook.guard";

const WEBHOOK_TOKEN = "runware-webhook-token-0123456789abcdef";
const originalWebhookToken = process.env.RUNWARE_WEBHOOK_TOKEN;

afterEach(() => {
  if (originalWebhookToken === undefined) {
    delete process.env.RUNWARE_WEBHOOK_TOKEN;
  } else {
    process.env.RUNWARE_WEBHOOK_TOKEN = originalWebhookToken;
  }
});

function contextFor(token: unknown): ExecutionContext {
  const request = { query: { token } } as unknown as Request;

  return {
    switchToHttp: () => ({
      getRequest: () => request,
    }),
  } as unknown as ExecutionContext;
}

function guard(): RunwareWebhookGuard {
  return new RunwareWebhookGuard();
}

test("rejects missing or short configured webhook tokens as unavailable", () => {
  delete process.env.RUNWARE_WEBHOOK_TOKEN;
  assert.throws(
    () => guard().canActivate(contextFor(WEBHOOK_TOKEN)),
    ServiceUnavailableException,
  );

  process.env.RUNWARE_WEBHOOK_TOKEN = "too-short";
  assert.throws(
    () => guard().canActivate(contextFor(WEBHOOK_TOKEN)),
    ServiceUnavailableException,
  );
});

test("rejects absent or wrong query tokens as unauthorized", () => {
  process.env.RUNWARE_WEBHOOK_TOKEN = WEBHOOK_TOKEN;

  assert.throws(
    () => guard().canActivate(contextFor(undefined)),
    UnauthorizedException,
  );
  assert.throws(
    () => guard().canActivate(contextFor("wrong-token")),
    UnauthorizedException,
  );
});

test("allows an exact query token", () => {
  process.env.RUNWARE_WEBHOOK_TOKEN = WEBHOOK_TOKEN;

  assert.equal(guard().canActivate(contextFor(WEBHOOK_TOKEN)), true);
});

test("rejects an array query token", () => {
  process.env.RUNWARE_WEBHOOK_TOKEN = WEBHOOK_TOKEN;

  assert.throws(
    () => guard().canActivate(contextFor([WEBHOOK_TOKEN])),
    UnauthorizedException,
  );
});
