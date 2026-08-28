import 'reflect-metadata';
import * as assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { SkipCoreApiKey } from '../decorators/skip-core-api-key.decorator';
import { ApiKeyGuard } from './api-key.guard';

const originalCoreApiKey = process.env.CORE_API_KEY;

afterEach(() => {
  if (originalCoreApiKey === undefined) {
    delete process.env.CORE_API_KEY;
  } else {
    process.env.CORE_API_KEY = originalCoreApiKey;
  }
});

function contextFor(
  handler: Function,
  controller: Function,
  providedApiKey?: string,
): ExecutionContext {
  const request = {
    header: () => providedApiKey,
  } as unknown as Request;

  return {
    getHandler: () => handler,
    getClass: () => controller,
    switchToHttp: () => ({
      getRequest: () => request,
    }),
  } as unknown as ExecutionContext;
}

function guard(): ApiKeyGuard {
  return new ApiKeyGuard(new Reflector());
}

test('allows requests when the Core API key is unset', () => {
  delete process.env.CORE_API_KEY;

  assert.equal(guard().canActivate(contextFor(() => undefined, class {})), true);
});

test('allows requests with a matching Core API key header', () => {
  process.env.CORE_API_KEY = 'core-secret';

  assert.equal(
    guard().canActivate(
      contextFor(() => undefined, class {}, 'core-secret'),
    ),
    true,
  );
});

test('rejects requests with a missing or wrong Core API key header', () => {
  process.env.CORE_API_KEY = 'core-secret';
  const apiKeyGuard = guard();

  assert.throws(
    () => apiKeyGuard.canActivate(contextFor(() => undefined, class {})),
    (error: unknown) =>
      error instanceof UnauthorizedException &&
      error.message === 'Invalid Core API key',
  );
  assert.throws(
    () => apiKeyGuard.canActivate(contextFor(() => undefined, class {}, 'wrong')),
    (error: unknown) =>
      error instanceof UnauthorizedException &&
      error.message === 'Invalid Core API key',
  );
});

test('skips the Core API key for handler metadata', () => {
  process.env.CORE_API_KEY = 'core-secret';
  class Controller {
    @SkipCoreApiKey()
    handle() {
      return undefined;
    }
  }
  const handler = Controller.prototype.handle;

  assert.equal(guard().canActivate(contextFor(handler, Controller)), true);
});

test('keeps undecorated handlers protected by the Core API key', () => {
  process.env.CORE_API_KEY = 'core-secret';

  assert.throws(
    () => guard().canActivate(contextFor(() => undefined, class {})),
    UnauthorizedException,
  );
});

test('supports Core API key skip metadata on the controller class', () => {
  process.env.CORE_API_KEY = 'core-secret';
  @SkipCoreApiKey()
  class Controller {
    handle() {
      return undefined;
    }
  }

  assert.equal(
    guard().canActivate(
      contextFor(Controller.prototype.handle, Controller),
    ),
    true,
  );
});
