import "reflect-metadata";
import * as assert from "node:assert/strict";
import { test } from "node:test";
import {
  BadRequestException,
  HttpStatus,
  RequestMethod,
  ServiceUnavailableException,
} from "@nestjs/common";
import {
  GUARDS_METADATA,
  HTTP_CODE_METADATA,
  METHOD_METADATA,
  MODULE_METADATA,
  PATH_METADATA,
} from "@nestjs/common/constants";
import { SKIP_CORE_API_KEY } from "../../../common/decorators/skip-core-api-key.decorator";
import { AssetsModule } from "../../assets/assets.module";
import { GenerationRepository } from "../generation.repository";
import { GenerationModule } from "../generation.module";
import { RunwareWebhookGuard } from "./runware-webhook.guard";
import type { RunwareWebhookEvent } from "./runware-webhook.dto";
import { RunwareWebhookController } from "./runware-webhook.controller";
import {
  type RunwareWebhookHandleResult,
  RunwareWebhookService,
} from "./runware-webhook.service";

const TASK_ID = "423e4567-e89b-42d3-a456-426614174000";

const successBody = {
  taskType: "videoInference",
  taskUUID: TASK_ID,
  status: "success",
  videoUUID: "runware-output-id",
  cost: 0.25,
  token: "body-token-must-not-be-forwarded",
};

const successEvent: RunwareWebhookEvent = {
  kind: "success",
  taskId: TASK_ID,
  providerOutputId: "runware-output-id",
  costUsd: "0.25",
  videoUrl: null,
};

function createController(
  result: RunwareWebhookHandleResult = {
    accepted: true,
    disposition: "completed",
    generationId: "generation-1",
  },
  error?: unknown,
) {
  const events: RunwareWebhookEvent[] = [];
  const service = {
    async handle(event: RunwareWebhookEvent) {
      events.push(event);
      if (error) throw error;
      return result;
    },
  };

  return {
    events,
    controller: new RunwareWebhookController(
      service as unknown as RunwareWebhookService,
    ),
  };
}

test("normalizes the raw body before delegating and wraps a completed result", async () => {
  const { controller, events } = createController();

  const result = await controller.handle(successBody);

  assert.deepEqual(result, {
    ok: true,
    data: {
      accepted: true,
      disposition: "completed",
      generationId: "generation-1",
    },
  });
  assert.deepEqual(events, [successEvent]);
});

test("wraps duplicate and unknown-task dispositions without changing them", async () => {
  for (const disposition of ["duplicate", "unknown_task"] as const) {
    const { controller, events } = createController({
      accepted: true,
      disposition,
    });

    const result = await controller.handle(successBody);

    assert.deepEqual(result, {
      ok: true,
      data: { accepted: true, disposition },
    });
    assert.deepEqual(events, [successEvent]);
  }
});

test("surfaces parser BadRequestException without calling the service", async () => {
  const { controller, events } = createController();

  await assert.rejects(
    () => controller.handle({ ...successBody, taskUUID: "not-a-uuid" }),
    (error: unknown) =>
      error instanceof BadRequestException && error.getStatus() === 400,
  );
  assert.deepEqual(events, []);
});

test("surfaces a retryable missing-R2 ServiceUnavailableException", async () => {
  const missingR2 = new ServiceUnavailableException(
    "Runware output is not available in R2 yet",
  );
  const { controller, events } = createController(undefined, missingR2);

  await assert.rejects(
    () => controller.handle(successBody),
    (error: unknown) =>
      error instanceof ServiceUnavailableException &&
      error === missingR2 &&
      error.getStatus() === 503,
  );
  assert.deepEqual(events, [successEvent]);
});

test("does not log the webhook body or query token", async () => {
  const { controller } = createController();
  const calls: unknown[][] = [];
  const methods = ["debug", "error", "info", "log", "warn"] as const;
  const originals = Object.fromEntries(
    methods.map((method) => [method, console[method]]),
  ) as Record<(typeof methods)[number], (...args: unknown[]) => void>;

  try {
    for (const method of methods) {
      console[method] = (...args: unknown[]) => calls.push(args);
    }
    await controller.handle({ ...successBody, queryToken: "query-token" });
  } finally {
    for (const method of methods) {
      console[method] = originals[method];
    }
  }

  assert.deepEqual(calls, []);
});

test("uses the narrow public route and webhook-only auth metadata", () => {
  assert.equal(
    Reflect.getMetadata(PATH_METADATA, RunwareWebhookController),
    "rovelle/webhooks",
  );
  assert.equal(
    Reflect.getMetadata(SKIP_CORE_API_KEY, RunwareWebhookController),
    true,
  );
  assert.deepEqual(
    Reflect.getMetadata(GUARDS_METADATA, RunwareWebhookController),
    [RunwareWebhookGuard],
  );

  const handler = RunwareWebhookController.prototype.handle;
  assert.equal(Reflect.getMetadata(PATH_METADATA, handler), "runware");
  assert.equal(
    Reflect.getMetadata(METHOD_METADATA, handler),
    RequestMethod.POST,
  );
  assert.equal(Reflect.getMetadata(HTTP_CODE_METADATA, handler), HttpStatus.OK);
  assert.deepEqual(
    Object.getOwnPropertyNames(RunwareWebhookController.prototype).filter(
      (name) => name !== "constructor",
    ),
    ["handle"],
  );
});

test("registers the controller, guard, and service while reusing AssetsModule", () => {
  const imports = Reflect.getMetadata(
    MODULE_METADATA.IMPORTS,
    GenerationModule,
  );
  const controllers = Reflect.getMetadata(
    MODULE_METADATA.CONTROLLERS,
    GenerationModule,
  );
  const providers = Reflect.getMetadata(
    MODULE_METADATA.PROVIDERS,
    GenerationModule,
  );

  assert.ok(imports.includes(AssetsModule));
  assert.ok(controllers.includes(RunwareWebhookController));
  assert.ok(providers.includes(RunwareWebhookGuard));
  assert.ok(providers.includes(RunwareWebhookService));
  assert.ok(providers.includes(GenerationRepository));
});
