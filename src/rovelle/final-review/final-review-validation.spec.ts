import * as assert from "node:assert/strict";
import { describe, test } from "node:test";
import { BadRequestException } from "@nestjs/common";
import type { SubmitFinalRenderReviewRequestDto } from "./dto/final-review.dto";
import { normalizeFinalRenderReviewRequest } from "./final-review-validation";

const REQUEST_ID = "550e8400-e29b-41d4-a716-446655440000";

function assertBadRequest(action: () => unknown): void {
  assert.throws(action, BadRequestException);
}

describe("Rovelle final render review input validation", () => {
  test("trims request ID and notes", () => {
    const normalized = normalizeFinalRenderReviewRequest({
      requestId: `  ${REQUEST_ID}  `,
      decision: "RERENDER",
      notes: "  Captions need another pass.  ",
    });

    assert.deepEqual(normalized, {
      requestId: REQUEST_ID,
      decision: "RERENDER",
      notes: "Captions need another pass.",
    } satisfies SubmitFinalRenderReviewRequestDto);
  });

  test("accepts only final-review decisions", () => {
    for (const decision of ["APPROVE", "REJECT", "RERENDER"] as const) {
      assert.equal(
        normalizeFinalRenderReviewRequest({
          requestId: REQUEST_ID,
          decision,
        }).decision,
        decision,
      );
    }

    for (const decision of [
      "",
      "approve",
      "REGENERATE",
      "RECOMMEND_APPROVE",
      1,
      null,
      undefined,
    ]) {
      assertBadRequest(() =>
        normalizeFinalRenderReviewRequest({
          requestId: REQUEST_ID,
          decision,
        }),
      );
    }
  });

  test("requires a UUID request ID", () => {
    for (const requestId of [
      "",
      "not-a-uuid",
      "00000000-0000-0000-0000-000000000000",
      1,
      null,
      undefined,
    ]) {
      assertBadRequest(() =>
        normalizeFinalRenderReviewRequest({
          requestId,
          decision: "APPROVE",
        }),
      );
    }
  });

  test("normalizes optional notes and enforces 4000 characters", () => {
    assert.equal(
      normalizeFinalRenderReviewRequest({
        requestId: REQUEST_ID,
        decision: "REJECT",
        notes: "   ",
      }).notes,
      null,
    );
    assert.equal(
      normalizeFinalRenderReviewRequest({
        requestId: REQUEST_ID,
        decision: "APPROVE",
        notes: "x".repeat(4000),
      }).notes,
      "x".repeat(4000),
    );
    assert.equal(
      normalizeFinalRenderReviewRequest({
        requestId: REQUEST_ID,
        decision: "APPROVE",
      }).notes,
      undefined,
    );
    assert.equal(
      normalizeFinalRenderReviewRequest({
        requestId: REQUEST_ID,
        decision: "APPROVE",
        notes: null,
      }).notes,
      null,
    );
    assertBadRequest(() =>
      normalizeFinalRenderReviewRequest({
        requestId: REQUEST_ID,
        decision: "APPROVE",
        notes: "x".repeat(4001),
      }),
    );
    assertBadRequest(() =>
      normalizeFinalRenderReviewRequest({
        requestId: REQUEST_ID,
        decision: "APPROVE",
        notes: 1,
      }),
    );
  });

  test("rejects malformed request containers", () => {
    for (const input of [null, [], "request", 1, false]) {
      assertBadRequest(() => normalizeFinalRenderReviewRequest(input));
    }
  });
});
