export type ConfirmTransactionStatus =
  | 'confirmed'
  | 'rejected'
  | 'not_found'
  | 'already_confirmed'
  | 'already_rejected';

export interface ConfirmTransactionRequestDto {
  transactionId: string;
  userId: string;
}

export interface ConfirmTransactionSummaryDto {
  amount: number;
  merchant: string;
  category: string | null;
}

export interface ConfirmTransactionEditMessageDto {
  text: string;
  parseMode: null;
}

export interface ConfirmTransactionResponseDto {
  status: ConfirmTransactionStatus;
  transactionId: string;
  userId: string;
  summary: ConfirmTransactionSummaryDto | null;
  editMessage: ConfirmTransactionEditMessageDto | null;
}
