export interface BudgetCategoriesRequestDto {
  userId: string | number;
}

export interface BudgetCategoryDto {
  id: string | number;
  category: string;
  parent_category: string | null;
}

export interface BudgetCategoriesResponseDto {
  status: 'ok';
  categories: BudgetCategoryDto[];
}
