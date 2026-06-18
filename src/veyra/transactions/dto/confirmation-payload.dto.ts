import { NormalizedTransactionType } from './normalize-transaction.dto';

export type TransactionCallbackMode = 'production' | 'experimental';
export type TransactionConfirmationPayloadFormat = 'plain' | 'html';

export interface TransactionConfirmationPayloadRequestDto {
  pendingTransactionId?: string;
  transactionId?: string;
  callbackMode?: TransactionCallbackMode;
  format?: TransactionConfirmationPayloadFormat;
  userId: string;
  transactionType: NormalizedTransactionType;
  amount: number;
  merchant: string;
  merchantNormalized?: string;
  category: string;
  wallet?: string;
  notes?: string | null;
  transactionDate: string;
  source: string;
  confidence?: number;
  warnings?: string[];
}

export interface TelegramInlineKeyboardButtonDto {
  text: string;
  callback_data: string;
}

export interface TelegramReplyMarkupDto {
  inline_keyboard: TelegramInlineKeyboardButtonDto[][];
}

export interface TransactionConfirmationSummaryDto {
  amount: number;
  merchant: string;
  category: string;
  wallet: string;
  notes: string;
}

export interface TransactionConfirmationPayloadResponseDto {
  text: string;
  parseMode: 'HTML' | null;
  replyMarkup: TelegramReplyMarkupDto;
  summary: TransactionConfirmationSummaryDto;
  warnings: string[];
}
