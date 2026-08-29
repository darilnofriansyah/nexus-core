import * as assert from "node:assert/strict";
import { test } from "node:test";
import type { PinCanonVersionRequestDto } from "./dto/canon.dto";
import { CanonPinService } from "./canon-pin.service";
import { ShotCanonController } from "./shot-canon.controller";

const request: PinCanonVersionRequestDto = { canonVersionId: "version-1" };
const data = { source: "SHOT", version: { id: "version-1" } };

function createController() {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const service = {
    getEffectiveShotCanon: async (...args: unknown[]) => {
      calls.push({ method: "getEffectiveShotCanon", args });
      return [data];
    },
    pinShot: async (...args: unknown[]) => {
      calls.push({ method: "pinShot", args });
      return data;
    },
    unpinShot: async (...args: unknown[]) => {
      calls.push({ method: "unpinShot", args });
    },
  };

  return {
    calls,
    controller: new ShotCanonController(service as unknown as CanonPinService),
  };
}

test("gets effective shot canon", async () => {
  const { calls, controller } = createController();

  const result = await controller.getCanon("shot-1");

  assert.deepEqual(result, { ok: true, data: [data] });
  assert.deepEqual(calls, [
    { method: "getEffectiveShotCanon", args: ["shot-1"] },
  ]);
});

test("pins a canon version to a shot", async () => {
  const { calls, controller } = createController();

  const result = await controller.pinCanon("shot-1", "entity-1", request);

  assert.deepEqual(result, { ok: true, data });
  assert.deepEqual(calls, [
    { method: "pinShot", args: ["shot-1", "entity-1", request] },
  ]);
});

test("deletes a shot canon pin", async () => {
  const { calls, controller } = createController();

  const result = await controller.unpinCanon("shot-1", "entity-1");

  assert.deepEqual(result, { ok: true, data: { removed: true } });
  assert.deepEqual(calls, [
    { method: "unpinShot", args: ["shot-1", "entity-1"] },
  ]);
});
