export interface BudgetStatusRequestDto {
  userId?: string;
  telegramUserId?: string;
  category: string;
  asOfDate?: string;
}

export interface BudgetStatusChildBreakdownDto {
  budget_id: string;
  category: string;
  budget_amount: number;
  spent_amount: number;
  remaining_amount: number;
  spent_percent: number;
}

export interface BudgetStatusResponseDto {
  budget_id: string;
  category: string;
  parent_budget_id: string | null;
  budget_amount: number;
  spent_amount: number;
  remaining_amount: number;
  spent_percent: number;
  child_breakdown: BudgetStatusChildBreakdownDto[];
  cycle_start: string;
  cycle_end: string;
}

export interface BudgetCycle {
  cycle_start: string;
  cycle_end: string;
}
