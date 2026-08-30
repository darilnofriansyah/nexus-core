import * as assert from "node:assert/strict";
import { test } from "node:test";
import {
  METHOD_METADATA,
  PATH_METADATA,
} from "@nestjs/common/constants";
import { RequestMethod } from "@nestjs/common";
import { RenderController } from "./render.controller";
import { RenderService } from "./render.service";

const episodeId = "episode-1";
const renderId = "render-1";
const createRequest = { requestId: "request-1", audioAssetId: "audio-1" };
const retryRequest = { requestId: "retry-1" };
const data = { id: renderId };

function createController() {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const service = {
    createRender: async (...args: unknown[]) => {
      calls.push({ method: "createRender", args });
      return data;
    },
    listEpisodeRenders: async (...args: unknown[]) => {
      calls.push({ method: "listEpisodeRenders", args });
      return [data];
    },
    getRender: async (...args: unknown[]) => {
      calls.push({ method: "getRender", args });
      return data;
    },
    retryRender: async (...args: unknown[]) => {
      calls.push({ method: "retryRender", args });
      return data;
    },
  };

  return {
    calls,
    controller: new RenderController(service as unknown as RenderService),
  };
}

test("creates a render and wraps the service result", async () => {
  const { calls, controller } = createController();

  const result = await controller.createRender(episodeId, createRequest);

  assert.deepEqual(result, { ok: true, data });
  assert.deepEqual(calls, [{ method: "createRender", args: [episodeId, createRequest] }]);
});

test("lists episode renders and wraps the service result", async () => {
  const { calls, controller } = createController();

  const result = await controller.listEpisodeRenders(episodeId);

  assert.deepEqual(result, { ok: true, data: [data] });
  assert.deepEqual(calls, [{ method: "listEpisodeRenders", args: [episodeId] }]);
});

test("gets a render and wraps the service result", async () => {
  const { calls, controller } = createController();

  const result = await controller.getRender(renderId);

  assert.deepEqual(result, { ok: true, data });
  assert.deepEqual(calls, [{ method: "getRender", args: [renderId] }]);
});

test("retries a render and wraps the service result", async () => {
  const { calls, controller } = createController();

  const result = await controller.retryRender(renderId, retryRequest);

  assert.deepEqual(result, { ok: true, data });
  assert.deepEqual(calls, [{ method: "retryRender", args: [renderId, retryRequest] }]);
});

test("exposes only the four authenticated render routes", () => {
  assert.equal(Reflect.getMetadata(PATH_METADATA, RenderController), "rovelle");

  const routes = [
    ["createRender", "episodes/:episodeId/renders", RequestMethod.POST],
    ["listEpisodeRenders", "episodes/:episodeId/renders", RequestMethod.GET],
    ["getRender", "renders/:renderId", RequestMethod.GET],
    ["retryRender", "renders/:renderId/retry", RequestMethod.POST],
  ] as const;

  assert.deepEqual(
    Object.getOwnPropertyNames(RenderController.prototype).filter(
      (name) => name !== "constructor",
    ),
    routes.map(([method]) => method),
  );
  for (const [method, path, requestMethod] of routes) {
    const route = RenderController.prototype[method];
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
