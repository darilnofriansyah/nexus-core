import * as assert from "node:assert/strict";
import { test } from "node:test";
import type { CreateAssetReservationRequestDto } from "./dto/asset.dto";
import { AssetController } from "./asset.controller";
import { AssetService } from "./asset.service";

const reservationRequest: CreateAssetReservationRequestDto = {
  assetType: "SOURCE",
  mediaType: "text/plain",
  originalFilename: "source.txt",
  episodeId: "episode-1",
};

const data = { id: "asset-1", status: "AVAILABLE" };

function createController() {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const service = {
    reserve: async (...args: unknown[]) => {
      calls.push({ method: "reserve", args });
      return data;
    },
    getAsset: async (...args: unknown[]) => {
      calls.push({ method: "getAsset", args });
      return data;
    },
    createUploadUrl: async (...args: unknown[]) => {
      calls.push({ method: "createUploadUrl", args });
      return data;
    },
    confirmUpload: async (...args: unknown[]) => {
      calls.push({ method: "confirmUpload", args });
      return data;
    },
    createReadUrl: async (...args: unknown[]) => {
      calls.push({ method: "createReadUrl", args });
      return data;
    },
  };

  return {
    calls,
    controller: new AssetController(service as unknown as AssetService),
  };
}

const routeCases = [
  {
    name: "reserves an asset",
    method: "reserve",
    args: [reservationRequest],
    call: (controller: AssetController) =>
      controller.reserve(reservationRequest),
  },
  {
    name: "gets an asset",
    method: "getAsset",
    args: ["asset-1"],
    call: (controller: AssetController) => controller.getAsset("asset-1"),
  },
  {
    name: "creates an upload URL",
    method: "createUploadUrl",
    args: ["asset-1"],
    call: (controller: AssetController) =>
      controller.createUploadUrl("asset-1"),
  },
  {
    name: "confirms an upload",
    method: "confirmUpload",
    args: ["asset-1"],
    call: (controller: AssetController) =>
      controller.confirmUpload("asset-1"),
  },
  {
    name: "creates a read URL",
    method: "createReadUrl",
    args: ["asset-1"],
    call: (controller: AssetController) =>
      controller.createReadUrl("asset-1"),
  },
] as const;

for (const routeCase of routeCases) {
  test(routeCase.name, async () => {
    const { calls, controller } = createController();

    const result = await routeCase.call(controller);

    assert.deepEqual(result, { ok: true, data });
    assert.deepEqual(calls, [
      { method: routeCase.method, args: routeCase.args },
    ]);
  });
}
