import * as assert from "node:assert/strict";
import { describe, test } from "node:test";
import { BadRequestException } from "@nestjs/common";
import { RovelleEpisodeStatus } from "../../generated/prisma/client";
import type { GenerationStageCounts } from "./generation-stage-state";
import { deriveGenerationStageStatus } from "./generation-stage-state";

function assertBadRequest(action: () => unknown): void {
  assert.throws(action, BadRequestException);
}

describe("Rovelle generation stage derivation", () => {
  test("returns GENERATING while any shot remains pending", () => {
    assert.equal(
      deriveGenerationStageStatus({
        totalShots: 3,
        pendingShots: 1,
        approvedShots: 2,
      }),
      RovelleEpisodeStatus.GENERATING,
    );
  });

  test("returns GENERATION_APPROVED only when every shot is approved", () => {
    assert.equal(
      deriveGenerationStageStatus({
        totalShots: 2,
        pendingShots: 0,
        approvedShots: 2,
      }),
      RovelleEpisodeStatus.GENERATION_APPROVED,
    );
  });

  test("returns REVIEW_REQUIRED when shots are present but not all approved", () => {
    for (const counts of [
      { totalShots: 0, pendingShots: 0, approvedShots: 0 },
      { totalShots: 2, pendingShots: 0, approvedShots: 1 },
      { totalShots: 2, pendingShots: 0, approvedShots: 0 },
    ] satisfies GenerationStageCounts[]) {
      assert.equal(
        deriveGenerationStageStatus(counts),
        RovelleEpisodeStatus.REVIEW_REQUIRED,
      );
    }
  });

  test("rejects negative, non-integer, and contradictory counts", () => {
    for (const counts of [
      { totalShots: -1, pendingShots: 0, approvedShots: 0 },
      { totalShots: 1, pendingShots: -1, approvedShots: 0 },
      { totalShots: 1, pendingShots: 0, approvedShots: -1 },
      { totalShots: 1.5, pendingShots: 0, approvedShots: 0 },
      { totalShots: 1, pendingShots: 0, approvedShots: 2 },
      { totalShots: 1, pendingShots: 2, approvedShots: 0 },
      { totalShots: Infinity, pendingShots: 0, approvedShots: 0 },
      { totalShots: NaN, pendingShots: 0, approvedShots: 0 },
    ]) {
      assertBadRequest(() => deriveGenerationStageStatus(counts));
    }
  });
});
