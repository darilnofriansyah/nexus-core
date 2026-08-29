import * as assert from "node:assert/strict";
import { test } from "node:test";
import type { PinCanonVersionRequestDto } from "./dto/canon.dto";
import { CanonPinService } from "./canon-pin.service";
import { EpisodeCanonController } from "./episode-canon.controller";

const request: PinCanonVersionRequestDto = { canonVersionId: "version-1" };
const data = { source: "EPISODE", version: { id: "version-1" } };

function createController() {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const service = {
    listEpisodePins: async (...args: unknown[]) => {
      calls.push({ method: "listEpisodePins", args });
      return [data];
    },
    pinEpisode: async (...args: unknown[]) => {
      calls.push({ method: "pinEpisode", args });
      return data;
    },
    unpinEpisode: async (...args: unknown[]) => {
      calls.push({ method: "unpinEpisode", args });
    },
  };

  return {
    calls,
    controller: new EpisodeCanonController(
      service as unknown as CanonPinService,
    ),
  };
}

test("gets episode canon pins", async () => {
  const { calls, controller } = createController();

  const result = await controller.getCanon("episode-1");

  assert.deepEqual(result, { ok: true, data: [data] });
  assert.deepEqual(calls, [
    { method: "listEpisodePins", args: ["episode-1"] },
  ]);
});

test("pins a canon version to an episode", async () => {
  const { calls, controller } = createController();

  const result = await controller.pinCanon("episode-1", "entity-1", request);

  assert.deepEqual(result, { ok: true, data });
  assert.deepEqual(calls, [
    { method: "pinEpisode", args: ["episode-1", "entity-1", request] },
  ]);
});

test("deletes an episode canon pin", async () => {
  const { calls, controller } = createController();

  const result = await controller.unpinCanon("episode-1", "entity-1");

  assert.deepEqual(result, { ok: true, data: { removed: true } });
  assert.deepEqual(calls, [
    { method: "unpinEpisode", args: ["episode-1", "entity-1"] },
  ]);
});
