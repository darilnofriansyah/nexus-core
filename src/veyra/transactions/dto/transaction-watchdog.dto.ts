import { TelegramReplyMarkupDto } from "./confirmation-payload.dto";
import {
  BudgetWatchdogResponseDto,
  OverspendingAlertRecordDto,
  OverspendingAlertType,
} from "../../budgets/dto/overspending-check.dto";

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
  alertType?: OverspendingAlertType;
  budgetId?: string;
  alertRecord?: OverspendingAlertRecordDto;
}

export interface TransactionWatchdogResponseDto {
  notifications: TransactionWatchdogNotificationDto[];
  watchdog?: BudgetWatchdogResponseDto;
}
