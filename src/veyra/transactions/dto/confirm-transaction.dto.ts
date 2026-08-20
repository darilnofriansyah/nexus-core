import { BudgetWatchdogResponseDto } from "../../budgets/dto/overspending-check.dto";
import { TransactionWatchdogNotificationDto } from "./transaction-watchdog.dto";

export type ConfirmTransactionStatus =
  | "confirmed"
  | "rejected"
  | "not_found"
  | "already_confirmed"
  | "already_rejected";

export interface ConfirmTransactionRequestDto {
  transactionId: string;
  userId: string;
}

export interface ConfirmTransactionSummaryDto {
  amount: number;
  merchant: string;
  category: string | null;
  pocketId: string | null;
  pocketName: string | null;
}

export interface ConfirmTransactionEditMessageDto {
  text: string;
  parseMode: "HTML" | null;
}

export interface ConfirmTransactionResponseDto {
  status: ConfirmTransactionStatus;
  transactionId: string;
  userId: string;
  summary: ConfirmTransactionSummaryDto | null;
  editMessage: ConfirmTransactionEditMessageDto | null;
  notifications?: TransactionWatchdogNotificationDto[];
  watchdog?: BudgetWatchdogResponseDto;
}
