import {
  NormalizedTransactionType,
  NormalizeTransactionResponseDto,
} from "./normalize-transaction.dto";
import { TelegramReplyMarkupDto } from "./confirmation-payload.dto";
import { BudgetWatchdogResponseDto } from "../../budgets/dto/overspending-check.dto";
import { TransactionWatchdogNotificationDto } from "./transaction-watchdog.dto";

export type TransactionSource = "telegram" | "email" | "manual" | "import";
export type TransactionStatus = "pending" | "confirmed" | "rejected";
export type TransactionHandleStateName =
  | "idle"
  | "record_transaction_state"
  | "veyra_regret_note";

export interface ManualTransactionLlmResultDto {
  intent?: "record_transaction" | "reset" | "unknown";
  transaction_type?: string;
  amount?: number | string;
  merchant?: string;
  category?: string | null;
  wallet?: string | null;
  confidence?: number;
  transaction_date?: string | null;
  notes?: string | null;
  missing_fields?: string[];
}

export interface TransactionHandleRequestDto {
  telegramUserId?: string;
  userId: string | number;
  source: TransactionSource | string;
  text?: string;
  llmResult?: ManualTransactionLlmResultDto;
}

export interface TransactionHandleConfirmationPayloadDto {
  text: string;
  reply_markup: TelegramReplyMarkupDto;
}

export interface TransactionHandleResponseDto {
  status:
    | TransactionStatus
    | "awaiting_missing_field"
    | "regret_note_added"
    | "cancelled"
    | "unsupported_source";
  transactionId: string | null;
  message: string;
  baseMessage?: string;
  confirmationPayload?: TransactionHandleConfirmationPayloadDto;
  notifications?: TransactionWatchdogNotificationDto[];
  watchdog?: BudgetWatchdogResponseDto;
  state?: {
    nextState: TransactionHandleStateName;
    payload: ManualTransactionLlmResultDto | Record<string, never>;
  };
}

export interface SaveTransactionInputDto {
  normalized: NormalizeTransactionResponseDto;
  status: TransactionStatus;
  confidence: number;
  rawPayload: unknown;
}

export interface SavedTransactionDto {
  id: string;
  userId: string;
  transactionType: NormalizedTransactionType;
  amount: number;
  merchant: string | null;
  merchantNormalized: string | null;
  category: string | null;
  transactionDate: string;
  source: string;
  notes: string | null;
  status: TransactionStatus;
  confidence: number;
}
