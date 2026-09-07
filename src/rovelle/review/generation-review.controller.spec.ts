import * as assert from "node:assert/strict";
import { test } from "node:test";
import { BadRequestException, RequestMethod } from "@nestjs/common";
import { METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import type { SubmitHumanReviewRequestDto } from "./dto/review.dto";
import { GenerationReviewController } from "./generation-review.controller";
import { GenerationReviewService } from "./generation-review.service";

const GENERATION_ID = "750e8400-e29b-41d4-a716-446655440000";
const request: SubmitHumanReviewRequestDto = {
  requestId: "950e8400-e29b-41d4-a716-446655440000",
  decision: "REGENERATE",
};

test("posts a generation review through the authenticated controller envelope", async () => {
  const calls: unknown[][] = [];
  const controller = new GenerationReviewController({
    submitHumanReview: async (...args: unknown[]) => {
      calls.push(args);
      return { review: { id: "review-1" } };
    },
  } as unknown as GenerationReviewService);

  assert.deepEqual(await controller.submitHumanReview(GENERATION_ID, request), {
    ok: true,
    data: { review: { id: "review-1" } },
  });
  assert.deepEqual(calls, [[GENERATION_ID, request]]);
  assert.equal(
    Reflect.getMetadata(PATH_METADATA, GenerationReviewController),
    "rovelle",
  );
  assert.equal(
    Reflect.getMetadata(
      PATH_METADATA,
      GenerationReviewController.prototype.submitHumanReview,
    ),
    "generations/:generationId/reviews",
  );
  assert.equal(
    Reflect.getMetadata(
      METHOD_METADATA,
      GenerationReviewController.prototype.submitHumanReview,
    ),
    RequestMethod.POST,
  );
});

test("rejects an invalid generation id before service access", async () => {
  const controller = new GenerationReviewController({
    submitHumanReview: async () => assert.fail("service must not run"),
  } as unknown as GenerationReviewService);

  await assert.rejects(
    () => controller.submitHumanReview("invalid", request),
    (error: unknown) =>
      error instanceof BadRequestException &&
      error.message === "generationId must be a valid UUID",
  );
});
