import { BadRequestException } from "@nestjs/common";
import type { SubmitFinalRenderReviewRequestDto } from "./dto/final-review.dto";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FINAL_RENDER_REVIEW_DECISIONS = new Set<
  SubmitFinalRenderReviewRequestDto["decision"]
>(["APPROVE", "REJECT", "RERENDER"]);

function requireObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new BadRequestException("request must be an object");
  }

  return value as Record<string, unknown>;
}

function requireRequestId(value: unknown): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value.trim())) {
    throw new BadRequestException("requestId must be a valid UUID");
  }

  return value.trim();
}

function requireDecision(
  value: unknown,
): SubmitFinalRenderReviewRequestDto["decision"] {
  if (
    typeof value !== "string" ||
    !FINAL_RENDER_REVIEW_DECISIONS.has(
      value as SubmitFinalRenderReviewRequestDto["decision"],
    )
  ) {
    throw new BadRequestException(
      "decision must be APPROVE, REJECT, or RERENDER",
    );
  }

  return value as SubmitFinalRenderReviewRequestDto["decision"];
}

function optionalReviewNotes(value: unknown): string | null | undefined {
  if (value === null || value === undefined) return value;
  if (typeof value !== "string") {
    throw new BadRequestException("notes must be a string");
  }

  const normalized = value.trim();
  if (normalized.length > 4000) {
    throw new BadRequestException("notes must be at most 4000 characters");
  }

  return normalized || null;
}

export function normalizeFinalRenderReviewRequest(
  input: unknown,
): SubmitFinalRenderReviewRequestDto {
  const request = requireObject(input);

  return {
    requestId: requireRequestId(request.requestId),
    decision: requireDecision(request.decision),
    notes: optionalReviewNotes(request.notes),
  };
}
