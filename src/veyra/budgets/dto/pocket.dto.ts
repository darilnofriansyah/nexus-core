export interface PocketDto {
  id: string;
  name: string;
  amount: number | null;
  isDefault: boolean;
}

export interface PocketListRequestDto {
  userId: string | number;
}

export interface PocketRenameRequestDto {
  userId: string | number;
  pocketId: string;
  name: string;
}

export interface PocketDefaultRequestDto {
  userId: string | number;
  pocketId: string;
}

export type ExpenseAssignment =
  | {
      status: 'resolved';
      category: string;
      needsCategoryReview: boolean;
      pocketId: string;
      pocketName: string;
    }
  | {
      status: 'awaiting_pocket';
      category: string;
      needsCategoryReview: boolean;
      pockets: PocketDto[];
    };

export interface ResolveExpenseAssignmentRequest {
  userId: string | number;
  pocketId?: string | null;
  category?: string | null;
}
