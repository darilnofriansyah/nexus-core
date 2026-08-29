import * as assert from "node:assert/strict";
import { test } from "node:test";
import type {
  AttachCanonAssetRequestDto,
  CreateCanonEntityRequestDto,
  CreateCanonVersionRequestDto,
  UpdateCanonVersionRequestDto,
} from "./dto/canon.dto";
import { CanonController } from "./canon.controller";
import { CanonService } from "./canon.service";

const entityRequest: CreateCanonEntityRequestDto = {
  code: "HERO",
  displayName: "Hero",
  entityType: "CHARACTER",
};
const versionRequest: CreateCanonVersionRequestDto = {
  definition: { color: "blue" },
};
const updateRequest: UpdateCanonVersionRequestDto = {
  definition: { color: "red" },
};
const assetRequest: AttachCanonAssetRequestDto = {
  assetId: "asset-1",
  role: "PRIMARY",
};

function createController() {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const data = { id: "canon-1" };
  const service = {
    createEntity: async (...args: unknown[]) => {
      calls.push({ method: "createEntity", args });
      return data;
    },
    listEntities: async (...args: unknown[]) => {
      calls.push({ method: "listEntities", args });
      return [data];
    },
    getEntity: async (...args: unknown[]) => {
      calls.push({ method: "getEntity", args });
      return data;
    },
    createVersion: async (...args: unknown[]) => {
      calls.push({ method: "createVersion", args });
      return data;
    },
    getVersion: async (...args: unknown[]) => {
      calls.push({ method: "getVersion", args });
      return data;
    },
    updateVersion: async (...args: unknown[]) => {
      calls.push({ method: "updateVersion", args });
      return data;
    },
    attachAsset: async (...args: unknown[]) => {
      calls.push({ method: "attachAsset", args });
      return data;
    },
    detachAsset: async (...args: unknown[]) => {
      calls.push({ method: "detachAsset", args });
      return data;
    },
    lockVersion: async (...args: unknown[]) => {
      calls.push({ method: "lockVersion", args });
      return data;
    },
  };

  return {
    calls,
    data,
    controller: new CanonController(service as unknown as CanonService),
  };
}

const routeCases = [
  {
    name: "creates a canon entity",
    method: "createEntity",
    args: [entityRequest],
    call: (controller: CanonController) => controller.createEntity(entityRequest),
  },
  {
    name: "lists canon entities",
    method: "listEntities",
    args: [],
    call: (controller: CanonController) => controller.listEntities(),
  },
  {
    name: "gets a canon entity",
    method: "getEntity",
    args: ["entity-1"],
    call: (controller: CanonController) => controller.getEntity("entity-1"),
  },
  {
    name: "creates a canon version",
    method: "createVersion",
    args: ["entity-1", versionRequest],
    call: (controller: CanonController) =>
      controller.createVersion("entity-1", versionRequest),
  },
  {
    name: "gets a canon version",
    method: "getVersion",
    args: ["version-1"],
    call: (controller: CanonController) => controller.getVersion("version-1"),
  },
  {
    name: "updates a canon version",
    method: "updateVersion",
    args: ["version-1", updateRequest],
    call: (controller: CanonController) =>
      controller.updateVersion("version-1", updateRequest),
  },
  {
    name: "attaches an asset",
    method: "attachAsset",
    args: ["version-1", assetRequest],
    call: (controller: CanonController) =>
      controller.attachAsset("version-1", assetRequest),
  },
  {
    name: "locks a canon version",
    method: "lockVersion",
    args: ["version-1"],
    call: (controller: CanonController) => controller.lockVersion("version-1"),
  },
] as const;

for (const routeCase of routeCases) {
  test(routeCase.name, async () => {
    const { calls, data, controller } = createController();

    const result = await routeCase.call(controller);

    assert.deepEqual(result, {
      ok: true,
      data: routeCase.method === "listEntities" ? [data] : data,
    });
    assert.deepEqual(calls, [{ method: routeCase.method, args: routeCase.args }]);
  });
}

test("deletes a canon asset and returns a removal envelope", async () => {
  const { calls, controller } = createController();

  const result = await controller.detachAsset("version-1", "asset-1");

  assert.deepEqual(result, { ok: true, data: { removed: true } });
  assert.deepEqual(calls, [
    { method: "detachAsset", args: ["version-1", "asset-1"] },
  ]);
});
