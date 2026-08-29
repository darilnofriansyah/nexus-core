import * as assert from "node:assert/strict";
import { test } from "node:test";
import { RovelleEpisodeStatus } from "../../generated/prisma/client";
import { canEditCanonPins } from "./canon-pin-policy";

test("allows canon pin edits before generation begins", () => {
  const editable = [
    RovelleEpisodeStatus.DRAFT,
    RovelleEpisodeStatus.BRIEF_APPROVED,
    RovelleEpisodeStatus.PREPRODUCTION,
    RovelleEpisodeStatus.READY_TO_GENERATE,
  ];

  for (const status of editable) {
    assert.equal(canEditCanonPins(status), true);
  }
});

test("rejects canon pin edits once an episode has started generating or ended", () => {
  const locked = [
    RovelleEpisodeStatus.GENERATING,
    RovelleEpisodeStatus.REVIEW_REQUIRED,
    RovelleEpisodeStatus.GENERATION_APPROVED,
    RovelleEpisodeStatus.RENDERING,
    RovelleEpisodeStatus.FINAL_REVIEW,
    RovelleEpisodeStatus.PUBLISH_READY,
    RovelleEpisodeStatus.PUBLISHING,
    RovelleEpisodeStatus.PUBLISHED,
    RovelleEpisodeStatus.PAUSED,
    RovelleEpisodeStatus.CANCELLED,
    RovelleEpisodeStatus.FAILED,
  ];

  for (const status of locked) {
    assert.equal(canEditCanonPins(status), false);
  }
});
