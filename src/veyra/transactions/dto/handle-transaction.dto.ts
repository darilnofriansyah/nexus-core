import {
  NormalizedTransactionType,
  NormalizeTransactionResponseDto,
} from './normalize-transaction.dto';
import { TelegramReplyMarkupDto } from './confirmation-payload.dto';

export type TransactionSource = 'telegram' | 'email' | 'manual' | 'import';
export type TransactionStatus = 'pending' | 'confirmed' | 'rejected';

export interface ManualTransactionLlmResultDto {
  transaction_type?: string;
  amount?: number | string;
  merchant?: string;
  category?: string | null;
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
  status: TransactionStatus | 'cancelled' | 'unsupported_source';
  transactionId: string | null;
  message: string;
  confirmationPayload?: TransactionHandleConfirmationPayloadDto;
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
  merchant: string;
  merchantNormalized: string;
  category: string;
  transactionDate: string;
  source: string;
  notes: string | null;
  status: TransactionStatus;
  confidence: number;
}
