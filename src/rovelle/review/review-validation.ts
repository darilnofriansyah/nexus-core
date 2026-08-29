import { BadRequestException } from "@nestjs/common";
import { Prisma } from "../../generated/prisma/client";
import type { UpdateGenerationBudgetRequestDto } from "./dto/generation-budget.dto";
import type { SubmitHumanReviewRequestDto } from "./dto/review.dto";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HUMAN_REVIEW_DECISIONS = new Set<SubmitHumanReviewRequestDto["decision"]>(
  ["APPROVE", "REJECT", "REGENERATE"],
);
const BUDGET_USD_PATTERN = /^(?:0|[1-9][0-9]{0,5})(?:\.[0-9]{1,6})?$/;
const MAX_GENERATION_BUDGET_USD = new Prisma.Decimal("999999.999999");

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
): SubmitHumanReviewRequestDto["decision"] {
  if (
    typeof value !== "string" ||
    !HUMAN_REVIEW_DECISIONS.has(
      value as SubmitHumanReviewRequestDto["decision"],
    )
  ) {
    throw new BadRequestException(
      "decision must be APPROVE, REJECT, or REGENERATE",
    );
  }

  return value as SubmitHumanReviewRequestDto["decision"];
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

export function normalizeSubmitHumanReviewRequest(
  input: unknown,
): SubmitHumanReviewRequestDto {
  const request = requireObject(input);

  return {
    requestId: requireRequestId(request.requestId),
    decision: requireDecision(request.decision),
    notes: optionalReviewNotes(request.notes),
  };
}

export function parseGenerationBudgetUsd(
  value: unknown,
): Prisma.Decimal | null {
  if (value === null) return null;
  if (typeof value !== "string" || !BUDGET_USD_PATTERN.test(value)) {
    throw new BadRequestException(
      "budgetUsd must be a non-negative decimal string with at most 6 decimal places",
    );
  }

  const budget = new Prisma.Decimal(value);
  if (budget.gt(MAX_GENERATION_BUDGET_USD)) {
    throw new BadRequestException("budgetUsd must be at most 999999.999999");
  }

  return budget;
}

export function normalizeUpdateGenerationBudgetRequest(
  input: unknown,
): UpdateGenerationBudgetRequestDto {
  const request = requireObject(input);
  const budgetUsd = request.budgetUsd;

  if (budgetUsd === null) return { budgetUsd: null };
  if (typeof budgetUsd !== "string") {
    throw new BadRequestException(
      "budgetUsd must be a non-negative decimal string with at most 6 decimal places",
    );
  }

  parseGenerationBudgetUsd(budgetUsd);

  return { budgetUsd };
}
