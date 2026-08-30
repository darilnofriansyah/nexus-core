import * as assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Prisma, RovelleGenerationStatus } from "../../generated/prisma/client";
import type { GenerationCostAttempt } from "./generation-cost";
import {
  actualGenerationSpend,
  committedGenerationSpend,
  remainingGenerationBudget,
} from "./generation-cost";

function cost(value: string): Prisma.Decimal {
  return new Prisma.Decimal(value);
}

function attempt(
  status: RovelleGenerationStatus,
  estimatedCostUsd: string,
  actualCostUsd: string | null,
): GenerationCostAttempt {
  return {
    status,
    estimatedCostUsd: cost(estimatedCostUsd),
    actualCostUsd: actualCostUsd === null ? null : cost(actualCostUsd),
  };
}

describe("Rovelle generation cost accounting", () => {
  test("sums all non-null actual costs, including charged failures", () => {
    const attempts = [
      attempt(
        RovelleGenerationStatus.SUBMISSION_FAILED,
        "4.000000",
        "1.500000",
      ),
      attempt(RovelleGenerationStatus.COMPLETED, "0.575000", "0.125000"),
      attempt(RovelleGenerationStatus.FAILED, "0.800000", "0.250000"),
      attempt(RovelleGenerationStatus.CREATED, "0.460000", null),
    ];

    assert.equal(actualGenerationSpend(attempts).toFixed(6), "1.875000");
  });

  test("commits actual cost when present and estimate otherwise, except submission failures", () => {
    const attempts = [
      attempt(
        RovelleGenerationStatus.SUBMISSION_FAILED,
        "4.000000",
        "1.500000",
      ),
      attempt(RovelleGenerationStatus.COMPLETED, "0.575000", "0.125000"),
      attempt(RovelleGenerationStatus.FAILED, "0.800000", "0.250000"),
      attempt(RovelleGenerationStatus.CREATED, "0.460000", null),
      attempt(RovelleGenerationStatus.PROCESSING, "0.125000", null),
    ];

    assert.equal(committedGenerationSpend(attempts).toFixed(6), "0.960000");
  });

  test("returns null without a budget and clamps configured budget below zero", () => {
    const committed = cost("2.500001");

    assert.equal(remainingGenerationBudget(null, committed), null);
    assert.equal(
      remainingGenerationBudget(cost("10.000000"), committed)?.toFixed(6),
      "7.499999",
    );
    assert.equal(
      remainingGenerationBudget(cost("2.500000"), committed)?.toFixed(6),
      "0.000000",
    );
  });
});
