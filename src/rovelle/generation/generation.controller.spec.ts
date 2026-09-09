import * as assert from "node:assert/strict";
import { test } from "node:test";
import {
  METHOD_METADATA,
  MODULE_METADATA,
  PATH_METADATA,
} from "@nestjs/common/constants";
import { RequestMethod } from "@nestjs/common";
import { GenerationController } from "./generation.controller";
import { GenerationModule } from "./generation.module";
import { GenerationService } from "./generation.service";
import { GENERATION_PROVIDER } from "./providers/generation-provider";
import { ViduQ3Provider } from "./providers/runware/vidu-q3.provider";
import { RunwareSubmitClient } from "./providers/runware/runware-submit.client";
import { GenerationPromptCompiler } from "./generation-prompt.compiler";
import { GenerationPreflightService } from "./generation-preflight.service";
import { GenerationRepository } from "./generation.repository";

const shotId = "shot-1";
const generationId = "generation-1";
const request = { requestId: "request-1", profile: "DRAFT" as const };
const data = { id: generationId };

function createController() {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const service = {
    submitShot: async (...args: unknown[]) => {
      calls.push({ method: "submitShot", args });
      return data;
    },
    listShotGenerations: async (...args: unknown[]) => {
      calls.push({ method: "listShotGenerations", args });
      return [data];
    },
    getGeneration: async (...args: unknown[]) => {
      calls.push({ method: "getGeneration", args });
      return data;
    },
  };

  return {
    calls,
    service,
    controller: new GenerationController(
      service as unknown as GenerationService,
    ),
  };
}

test("submits a shot generation and wraps the service result", async () => {
  const { calls, controller } = createController();

  const result = await controller.submitShot(shotId, request);

  assert.deepEqual(result, { ok: true, data });
  assert.deepEqual(calls, [{ method: "submitShot", args: [shotId, request] }]);
});

test("lists shot generations and wraps the service result", async () => {
  const { calls, controller } = createController();

  const result = await controller.listShotGenerations(shotId);

  assert.deepEqual(result, { ok: true, data: [data] });
  assert.deepEqual(calls, [{ method: "listShotGenerations", args: [shotId] }]);
});

test("gets a generation and wraps the service result", async () => {
  const { calls, controller } = createController();

  const result = await controller.getGeneration(generationId);

  assert.deepEqual(result, { ok: true, data });
  assert.deepEqual(calls, [{ method: "getGeneration", args: [generationId] }]);
});

test("exposes only the three authenticated generation routes", () => {
  assert.equal(
    Reflect.getMetadata(PATH_METADATA, GenerationController),
    "rovelle",
  );

  const routes = [
    ["submitShot", "shots/:shotId/generations", RequestMethod.POST],
    ["listShotGenerations", "shots/:shotId/generations", RequestMethod.GET],
    ["getGeneration", "generations/:generationId", RequestMethod.GET],
  ] as const;

  assert.deepEqual(
    Object.getOwnPropertyNames(GenerationController.prototype).filter(
      (name) => name !== "constructor",
    ),
    routes.map(([method]) => method),
  );
  for (const [method, path, requestMethod] of routes) {
    const route = GenerationController.prototype[method];
    assert.equal(Reflect.getMetadata(PATH_METADATA, route), path);
    assert.equal(Reflect.getMetadata(METHOD_METADATA, route), requestMethod);
    assert.equal(
      Reflect.getMetadataKeys(route).some((key) =>
        String(key).toLowerCase().includes("public"),
      ),
      false,
    );
  }
});

test("binds the generation provider token to Vidu Q3 and exports Phase 3B dependencies", () => {
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
  const exports = Reflect.getMetadata(
    MODULE_METADATA.EXPORTS,
    GenerationModule,
  );

  assert.ok(imports);
  assert.ok(controllers.includes(GenerationController));
  assert.ok(providers.includes(GenerationPromptCompiler));
  assert.ok(providers.includes(GenerationPreflightService));
  assert.ok(providers.includes(GenerationRepository));
  assert.ok(providers.includes(RunwareSubmitClient));
  assert.ok(providers.includes(ViduQ3Provider));
  assert.ok(providers.includes(GenerationService));

  const providerBinding = providers.find(
    (provider: unknown) =>
      typeof provider === "object" &&
      provider !== null &&
      "provide" in provider &&
      provider.provide === GENERATION_PROVIDER,
  );
  assert.deepEqual(providerBinding, {
    provide: GENERATION_PROVIDER,
    useExisting: ViduQ3Provider,
  });
  assert.ok(exports.includes(GenerationService));
  assert.ok(exports.includes(GenerationRepository));
});
