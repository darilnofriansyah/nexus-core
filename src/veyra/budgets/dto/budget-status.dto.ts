export interface BudgetStatusRequestDto {
  userId?: string;
  telegramUserId?: string;
  pocketId?: string;
  category?: string;
  asOfDate?: string;
}

export interface BudgetStatusCategoryBreakdownDto {
  category: string;
  spent_amount: number;
}

export interface BudgetStatusResponseDto {
  budget_id: string;
  category: string;
  parent_budget_id: string | null;
  budget_amount: number;
  spent_amount: number;
  remaining_amount: number;
  spent_percent: number;
  category_breakdown: BudgetStatusCategoryBreakdownDto[];
  cycle_start: string;
  cycle_end: string;
}

export interface BudgetCycle {
  cycle_start: string;
  cycle_end: string;
}
