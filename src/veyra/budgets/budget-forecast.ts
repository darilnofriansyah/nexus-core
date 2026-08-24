const DAY_MS = 86_400_000;

export interface BudgetForecastInput {
  spentAmount: number;
  budgetAmount: number;
  cycleStart: string;
  cycleEnd: string;
  asOfDate: string;
}

export interface BudgetForecastResult {
  elapsedDays: number;
  cycleDays: number;
  remainingDays: number;
  projectedSpend: number;
  projectedOverrun: number;
  remainingAmount: number;
  safeDailySpend: number;
}

export function calculateBudgetForecast(
  input: BudgetForecastInput,
): BudgetForecastResult | null {
  if (
    !Number.isSafeInteger(input.spentAmount) ||
    input.spentAmount < 0 ||
    !Number.isSafeInteger(input.budgetAmount) ||
    input.budgetAmount <= 0
  ) {
    return null;
  }

  const start = parseDate(input.cycleStart);
  const end = parseDate(input.cycleEnd);
  const reference = parseDate(input.asOfDate);

  if (!start || !end || !reference || reference < start || reference >= end) {
    return null;
  }

  const cycleDays = daysBetween(start, end);
  if (cycleDays < 1) return null;

  const elapsedDays = daysBetween(start, reference) + 1;
  const remainingDays = Math.max(1, cycleDays - elapsedDays);
  const projectedSpend = Math.round(
    (input.spentAmount / elapsedDays) * cycleDays,
  );
  const remainingAmount = Math.max(
    0,
    input.budgetAmount - input.spentAmount,
  );

  return {
    elapsedDays,
    cycleDays,
    remainingDays,
    projectedSpend,
    projectedOverrun: Math.max(0, projectedSpend - input.budgetAmount),
    remainingAmount,
    safeDailySpend: Math.floor(remainingAmount / remainingDays),
  };
}

function parseDate(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10) === value ? date : null;
}

function daysBetween(start: Date, end: Date): number {
  return Math.round((end.getTime() - start.getTime()) / DAY_MS);
}
