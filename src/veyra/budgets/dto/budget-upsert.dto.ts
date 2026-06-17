export type BudgetPeriodType = 'monthly';

export type BudgetUpsertAction = 'created' | 'updated';

export interface BudgetUpsertRequestDto {
  userId: string;
  category: string;
  amount: number;
  parentCategory?: string;
  periodType?: BudgetPeriodType;
}

export interface BudgetUpsertResponseDto {
  budget_id: string;
  user_id: string;
  category: string;
  amount: number;
  parent_budget_id: string | null;
  parent_category: string | null;
  period_type: BudgetPeriodType;
  action: BudgetUpsertAction;
}
