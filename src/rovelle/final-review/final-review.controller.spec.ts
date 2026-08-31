import * as assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  BadRequestException,
  RequestMethod,
} from "@nestjs/common";
import {
  METHOD_METADATA,
  MODULE_METADATA,
  PATH_METADATA,
} from "@nestjs/common/constants";
import { AssetsModule } from "../assets/assets.module";
import { RenderModule } from "../render/render.module";
import { FinalReviewController } from "./final-review.controller";
import { FinalReviewModule } from "./final-review.module";
import type { SubmitFinalRenderReviewRequestDto } from "./dto/final-review.dto";
import { FinalReviewQueueService } from "./final-review-queue.service";
import { FinalReviewRepository } from "./final-review.repository";
import { FinalReviewService } from "./final-review.service";

const episodeId = "550e8400-e29b-41d4-a716-446655440000";
const renderId = "650e8400-e29b-41d4-a716-446655440000";
const requestId = "750e8400-e29b-41d4-a716-446655440000";
const reviewRequest: SubmitFinalRenderReviewRequestDto = {
  requestId,
  decision: "APPROVE",
  notes: "Looks good.",
};
const reviewData = { id: "review-1" };
const queueData = [{ episode: { id: episodeId } }];
const masterData = { episode: { id: episodeId }, render: { id: renderId } };

function createController() {
  const calls: Array<{ service: string; args: unknown[] }> = [];
  const finalReviewService = {
    submitHumanReview: async (...args: unknown[]) => {
      calls.push({ service: "submitHumanReview", args });
      return reviewData;
    },
    listRenderReviews: async (...args: unknown[]) => {
      calls.push({ service: "listRenderReviews", args });
      return [reviewData];
    },
  };
  const queueService = {
    listQueue: async (...args: unknown[]) => {
      calls.push({ service: "listQueue", args });
      return queueData;
    },
    getApprovedFinalMaster: async (...args: unknown[]) => {
      calls.push({ service: "getApprovedFinalMaster", args });
      return masterData;
    },
  };

  return {
    calls,
    controller: new FinalReviewController(
      finalReviewService as unknown as FinalReviewService,
      queueService as unknown as FinalReviewQueueService,
    ),
  };
}

test("submits a human review and wraps the service result", async () => {
  const { calls, controller } = createController();

  const result = await controller.submitHumanReview(renderId, reviewRequest);

  assert.deepEqual(result, { ok: true, data: reviewData });
  assert.deepEqual(calls, [
    { service: "submitHumanReview", args: [renderId, reviewRequest] },
  ]);
});

test("rejects an invalid render UUID before submit service access", async () => {
  const { calls, controller } = createController();

  await assert.rejects(
    () => controller.submitHumanReview("not-a-uuid", reviewRequest),
    (error: unknown) =>
      error instanceof BadRequestException &&
      error.message === "renderId must be a valid UUID",
  );

  assert.deepEqual(calls, []);
});

test("lists render review history and wraps the service result", async () => {
  const { calls, controller } = createController();

  const result = await controller.listRenderReviews(renderId);

  assert.deepEqual(result, { ok: true, data: [reviewData] });
  assert.deepEqual(calls, [
    { service: "listRenderReviews", args: [renderId] },
  ]);
});

test("rejects an invalid render UUID before list service access", async () => {
  const { calls, controller } = createController();

  await assert.rejects(
    () => controller.listRenderReviews("not-a-uuid"),
    (error: unknown) =>
      error instanceof BadRequestException &&
      error.message === "renderId must be a valid UUID",
  );

  assert.deepEqual(calls, []);
});

test("lists the final-review queue with an optional episode filter", async () => {
  const { calls, controller } = createController();

  const unfiltered = await controller.listQueue();
  const filtered = await controller.listQueue(episodeId);

  assert.deepEqual(unfiltered, { ok: true, data: queueData });
  assert.deepEqual(filtered, { ok: true, data: queueData });
  assert.deepEqual(calls, [
    { service: "listQueue", args: [undefined] },
    { service: "listQueue", args: [episodeId] },
  ]);
});

test("rejects an invalid queue episode UUID before service access", async () => {
  const { calls, controller } = createController();

  await assert.rejects(
    () => controller.listQueue("not-a-uuid"),
    (error: unknown) =>
      error instanceof BadRequestException &&
      error.message === "episodeId must be a valid UUID",
  );

  assert.deepEqual(calls, []);
});

test("gets the approved final master and wraps the service result", async () => {
  const { calls, controller } = createController();

  const result = await controller.getApprovedFinalMaster(episodeId);

  assert.deepEqual(result, { ok: true, data: masterData });
  assert.deepEqual(calls, [
    { service: "getApprovedFinalMaster", args: [episodeId] },
  ]);
});

test("rejects an invalid final-master episode UUID before service access", async () => {
  const { calls, controller } = createController();

  await assert.rejects(
    () => controller.getApprovedFinalMaster("not-a-uuid"),
    (error: unknown) =>
      error instanceof BadRequestException &&
      error.message === "episodeId must be a valid UUID",
  );

  assert.deepEqual(calls, []);
});

test("exposes only authenticated final-review routes", () => {
  assert.equal(Reflect.getMetadata(PATH_METADATA, FinalReviewController), "rovelle");

  const routes = [
    ["submitHumanReview", "renders/:renderId/final-reviews", RequestMethod.POST],
    ["listRenderReviews", "renders/:renderId/final-reviews", RequestMethod.GET],
    ["listQueue", "final-reviews/queue", RequestMethod.GET],
    ["getApprovedFinalMaster", "episodes/:episodeId/final-master", RequestMethod.GET],
  ] as const;

  assert.deepEqual(
    Object.getOwnPropertyNames(FinalReviewController.prototype).filter(
      (name) => name !== "constructor",
    ),
    routes.map(([method]) => method),
  );
  for (const [method, path, requestMethod] of routes) {
    const route = FinalReviewController.prototype[method];
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

describe("FinalReviewModule", () => {
  test("wires final-review services with assets and render dependencies", () => {
    const imports = Reflect.getMetadata(MODULE_METADATA.IMPORTS, FinalReviewModule);
    const controllers = Reflect.getMetadata(
      MODULE_METADATA.CONTROLLERS,
      FinalReviewModule,
    );
    const providers = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, FinalReviewModule);
    const exports = Reflect.getMetadata(MODULE_METADATA.EXPORTS, FinalReviewModule);

    assert.ok(imports.includes(AssetsModule));
    assert.ok(imports.includes(RenderModule));
    assert.deepEqual(controllers, [FinalReviewController]);
    assert.ok(providers.includes(FinalReviewRepository));
    assert.ok(providers.includes(FinalReviewService));
    assert.ok(providers.includes(FinalReviewQueueService));
    assert.ok(exports.includes(FinalReviewRepository));
    assert.ok(exports.includes(FinalReviewService));
    assert.ok(exports.includes(FinalReviewQueueService));
    assert.equal(
      imports.some((module: unknown) =>
        String(module).includes("RenderWorker"),
      ),
      false,
    );
  });
});
