import { TelegramReplyMarkupDto } from "./confirmation-payload.dto";
import { BudgetWatchdogResponseDto } from "../../budgets/dto/overspending-check.dto";

export type TransactionWatchdogNotificationType =
  | "risk_review"
  | "budget_alert"
  | "burn_rate";

export interface TransactionWatchdogNotificationDto {
  type: TransactionWatchdogNotificationType;
  priority: number;
  severity: "warning" | "high";
  message: string;
  review_id?: number;
  reply_markup?: TelegramReplyMarkupDto;
}

export interface TransactionWatchdogResponseDto {
  notifications: TransactionWatchdogNotificationDto[];
  watchdog?: BudgetWatchdogResponseDto;
}
