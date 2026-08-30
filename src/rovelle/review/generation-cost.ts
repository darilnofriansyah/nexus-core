import { Prisma, RovelleGenerationStatus } from "../../generated/prisma/client";

export interface GenerationCostAttempt {
  status: RovelleGenerationStatus;
  estimatedCostUsd: Prisma.Decimal;
  actualCostUsd: Prisma.Decimal | null;
}

export function actualGenerationSpend(
  attempts: readonly GenerationCostAttempt[],
): Prisma.Decimal {
  return attempts.reduce(
    (total, attempt) =>
      attempt.actualCostUsd === null
        ? total
        : total.plus(attempt.actualCostUsd),
    new Prisma.Decimal("0"),
  );
}

export function committedGenerationSpend(
  attempts: readonly GenerationCostAttempt[],
): Prisma.Decimal {
  return attempts.reduce((total, attempt) => {
    if (attempt.status === RovelleGenerationStatus.SUBMISSION_FAILED) {
      return total;
    }

    return total.plus(attempt.actualCostUsd ?? attempt.estimatedCostUsd);
  }, new Prisma.Decimal("0"));
}

export function remainingGenerationBudget(
  budget: Prisma.Decimal | null,
  committed: Prisma.Decimal,
): Prisma.Decimal | null {
  if (budget === null) return null;

  const remaining = budget.minus(committed);
  return remaining.isNegative() ? new Prisma.Decimal("0") : remaining;
}
