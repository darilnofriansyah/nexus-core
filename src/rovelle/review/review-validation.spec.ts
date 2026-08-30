import * as assert from "node:assert/strict";
import { describe, test } from "node:test";
import { BadRequestException } from "@nestjs/common";
import type { SubmitHumanReviewRequestDto } from "./dto/review.dto";
import { Prisma } from "../../generated/prisma/client";
import type { UpdateGenerationBudgetRequestDto } from "./dto/generation-budget.dto";
import { normalizeSubmitHumanReviewRequest } from "./review-validation";
import {
  normalizeUpdateGenerationBudgetRequest,
  parseGenerationBudgetUsd,
} from "./review-validation";

const REQUEST_ID = "550e8400-e29b-41d4-a716-446655440000";

function assertBadRequest(action: () => unknown): void {
  assert.throws(action, BadRequestException);
}

describe("Rovelle human review input validation", () => {
  test("trims a valid request ID and review notes", () => {
    const normalized = normalizeSubmitHumanReviewRequest({
      requestId: `  ${REQUEST_ID}  `,
      decision: "APPROVE",
      notes: "  Looks consistent.  ",
    });

    assert.deepEqual(normalized, {
      requestId: REQUEST_ID,
      decision: "APPROVE",
      notes: "Looks consistent.",
    } satisfies SubmitHumanReviewRequestDto);
  });

  test("requires a valid request ID and an allowed human decision", () => {
    for (const requestId of [
      "",
      "not-a-uuid",
      "00000000-0000-0000-0000-000000000000",
      1,
      null,
      undefined,
    ]) {
      assertBadRequest(() =>
        normalizeSubmitHumanReviewRequest({
          requestId,
          decision: "APPROVE",
        }),
      );
    }

    for (const decision of [
      "",
      "approve",
      "UNKNOWN",
      "RECOMMEND_APPROVE",
      "RECOMMEND_REJECT",
      1,
      null,
      undefined,
    ]) {
      assertBadRequest(() =>
        normalizeSubmitHumanReviewRequest({
          requestId: REQUEST_ID,
          decision,
        }),
      );
    }
  });

  test("turns empty notes into null and enforces the 4000-character limit", () => {
    assert.equal(
      normalizeSubmitHumanReviewRequest({
        requestId: REQUEST_ID,
        decision: "REJECT",
        notes: "   ",
      }).notes,
      null,
    );
    assert.equal(
      normalizeSubmitHumanReviewRequest({
        requestId: REQUEST_ID,
        decision: "REGENERATE",
        notes: "x".repeat(4000),
      }).notes,
      "x".repeat(4000),
    );
    assertBadRequest(() =>
      normalizeSubmitHumanReviewRequest({
        requestId: REQUEST_ID,
        decision: "APPROVE",
        notes: "x".repeat(4001),
      }),
    );
    assertBadRequest(() =>
      normalizeSubmitHumanReviewRequest({
        requestId: REQUEST_ID,
        decision: "APPROVE",
        notes: 1,
      }),
    );
    assert.equal(
      normalizeSubmitHumanReviewRequest({
        requestId: REQUEST_ID,
        decision: "APPROVE",
        notes: null,
      }).notes,
      null,
    );
  });

  test("rejects malformed request containers", () => {
    for (const input of [null, [], "request", 1, false]) {
      assertBadRequest(() => normalizeSubmitHumanReviewRequest(input));
    }
  });
});

describe("Rovelle generation budget input validation", () => {
  test("accepts exact decimal strings and keeps the request string-shaped", () => {
    for (const budgetUsd of ["0", "0.000001", "10", "10.25", "999999.999999"]) {
      const normalized = normalizeUpdateGenerationBudgetRequest({ budgetUsd });

      assert.deepEqual(normalized, {
        budgetUsd,
      } satisfies UpdateGenerationBudgetRequestDto);
      assert.ok(
        parseGenerationBudgetUsd(normalized.budgetUsd) instanceof
          Prisma.Decimal,
      );
    }
    assert.deepEqual(
      normalizeUpdateGenerationBudgetRequest({ budgetUsd: null }),
      { budgetUsd: null },
    );
    assert.equal(parseGenerationBudgetUsd(null), null);
  });

  test("rejects non-string, non-canonical, and out-of-range budget values", () => {
    for (const budgetUsd of [
      10,
      -1,
      "-0.000001",
      "1e3",
      "1E3",
      "1,000",
      "0.0000001",
      "999999.9999990",
      "1000000",
      " ",
      "",
      "NaN",
      "Infinity",
      "+10",
      "01",
      "10.",
      ".25",
      undefined,
    ]) {
      assertBadRequest(() =>
        normalizeUpdateGenerationBudgetRequest({ budgetUsd }),
      );
      assertBadRequest(() => parseGenerationBudgetUsd(budgetUsd));
    }
  });

  test("requires a budget field and a plain request object", () => {
    assertBadRequest(() => normalizeUpdateGenerationBudgetRequest({}));
    for (const input of [null, [], "request", 1, false]) {
      assertBadRequest(() => normalizeUpdateGenerationBudgetRequest(input));
    }
  });

  test("preserves six-place precision through Prisma Decimal", () => {
    const normalized = parseGenerationBudgetUsd("999999.999999");

    assert.equal(normalized?.toFixed(6), "999999.999999");
    assert.equal(parseGenerationBudgetUsd("10.25")?.toFixed(6), "10.250000");
  });
});
