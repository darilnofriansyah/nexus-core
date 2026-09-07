import * as assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from "@nestjs/common";
import { RovelleReviewDecision } from "../../generated/prisma/client";
import type {
  GenerationReviewMutationResult,
  GenerationReviewRepository,
} from "./generation-review.repository";
import { GenerationReviewService } from "./generation-review.service";

const GENERATION_ID = "750e8400-e29b-41d4-a716-446655440000";
const REQUEST_ID = "950e8400-e29b-41d4-a716-446655440000";

class StubRepository {
  result: GenerationReviewMutationResult = { status: "not_found" };
  input: unknown;

  async submitHumanReview(
    input: unknown,
  ): Promise<GenerationReviewMutationResult> {
    this.input = input;
    return this.result;
  }
}

describe("generation review service", () => {
  test("normalizes a decision and returns the audit and state snapshots", async () => {
    const repository = new StubRepository();
    repository.result = {
      status: "reviewed",
      review: {
        id: "review-1",
        clientRequestId: REQUEST_ID,
        generationId: GENERATION_ID,
        reviewerType: "HUMAN",
        decision: RovelleReviewDecision.APPROVE,
        notes: "Approved",
        createdAt: new Date("2026-09-07T00:00:00.000Z"),
      },
      generation: { id: GENERATION_ID, status: "COMPLETED" },
      shot: {
        id: "shot-1",
        status: "APPROVED",
        approvedGenerationId: GENERATION_ID,
      },
      episode: { id: "episode-1", status: "GENERATION_APPROVED" },
    };
    const service = new GenerationReviewService(
      repository as unknown as GenerationReviewRepository,
    );

    const result = await service.submitHumanReview(GENERATION_ID, {
      requestId: ` ${REQUEST_ID} `,
      decision: "APPROVE",
      notes: " Approved ",
    });

    assert.deepEqual(repository.input, {
      clientRequestId: REQUEST_ID,
      generationId: GENERATION_ID,
      decision: RovelleReviewDecision.APPROVE,
      notes: "Approved",
    });
    assert.deepEqual(result, {
      review: {
        id: "review-1",
        requestId: REQUEST_ID,
        generationId: GENERATION_ID,
        reviewerType: "HUMAN",
        decision: "APPROVE",
        notes: "Approved",
        createdAt: "2026-09-07T00:00:00.000Z",
      },
      generation: { id: GENERATION_ID, status: "COMPLETED" },
      shot: {
        id: "shot-1",
        status: "APPROVED",
        approvedGenerationId: GENERATION_ID,
      },
      episode: { id: "episode-1", status: "GENERATION_APPROVED" },
    });
  });

  test("maps repository failures to API errors", async () => {
    const repository = new StubRepository();
    const service = new GenerationReviewService(
      repository as unknown as GenerationReviewRepository,
    );
    const request = { requestId: REQUEST_ID, decision: "REJECT" as const };
    const expectations: Array<
      [GenerationReviewMutationResult, new (...args: never[]) => Error]
    > = [
      [{ status: "not_found" }, NotFoundException],
      [{ status: "request_conflict" }, ConflictException],
      [{ status: "generation_not_reviewable" }, BadRequestException],
      [{ status: "output_not_available" }, BadRequestException],
      [{ status: "invalid_shot_state" }, BadRequestException],
    ];

    for (const [result, ErrorType] of expectations) {
      repository.result = result;
      await assert.rejects(
        () => service.submitHumanReview(GENERATION_ID, request),
        (error: unknown) => error instanceof ErrorType,
      );
    }
  });
});
