import * as assert from "node:assert/strict";
import { test } from "node:test";
import { BadRequestException } from "@nestjs/common";
import type { CreateAssetReservationRequestDto } from "./dto/asset.dto";
import { AssetController } from "./asset.controller";
import { AssetService } from "./asset.service";

const reservationRequest: CreateAssetReservationRequestDto = {
  assetType: "SOURCE",
  mediaType: "text/plain",
  originalFilename: "source.txt",
  episodeId: "123e4567-e89b-42d3-a456-426614174000",
};

const assetId = "550e8400-e29b-41d4-a716-446655440000";

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
    args: [assetId],
    call: (controller: AssetController) => controller.getAsset(assetId),
  },
  {
    name: "creates an upload URL",
    method: "createUploadUrl",
    args: [assetId],
    call: (controller: AssetController) =>
      controller.createUploadUrl(assetId),
  },
  {
    name: "confirms an upload",
    method: "confirmUpload",
    args: [assetId],
    call: (controller: AssetController) =>
      controller.confirmUpload(assetId),
  },
  {
    name: "creates a read URL",
    method: "createReadUrl",
    args: [assetId],
    call: (controller: AssetController) =>
      controller.createReadUrl(assetId),
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

test("rejects malformed asset IDs before calling the service", async () => {
  const routes = [
    (controller: AssetController) => controller.getAsset("not-a-uuid"),
    (controller: AssetController) => controller.createUploadUrl("not-a-uuid"),
    (controller: AssetController) => controller.confirmUpload("not-a-uuid"),
    (controller: AssetController) => controller.createReadUrl("not-a-uuid"),
  ];

  for (const route of routes) {
    const { calls, controller } = createController();
    await assert.rejects(() => route(controller), BadRequestException);
    assert.deepEqual(calls, []);
  }
});
