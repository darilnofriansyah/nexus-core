export interface BudgetStatusRequestDto {
  userId?: string;
  telegramUserId?: string;
  category: string;
  asOfDate?: string;
}

export interface BudgetStatusResponseDto {
  budget_id: string;
  category: string;
  parent_budget_id: string | null;
  budget_amount: number;
  spent_amount: number;
  remaining_amount: number;
  spent_percent: number;
  cycle_start: string;
  cycle_end: string;
}

export interface BudgetCycle {
  cycle_start: string;
  cycle_end: string;
}
