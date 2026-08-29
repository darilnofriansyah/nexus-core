export interface UpdateGenerationBudgetRequestDto {
  budgetUsd: string | null;
}

export interface GenerationBudgetDto {
  episodeId: string;
  currency: "USD";
  budgetUsd: string | null;
  actualSpentUsd: string;
  committedUsd: string;
  remainingUsd: string | null;
  hardLimitEnabled: boolean;
}
