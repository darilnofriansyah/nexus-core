import {
  ConfirmTransactionEditMessageDto,
  ConfirmTransactionSummaryDto,
} from './confirm-transaction.dto';
import {
  TelegramReplyMarkupDto,
  TransactionCallbackMode,
  TransactionConfirmationPayloadResponseDto,
} from './confirmation-payload.dto';

export type TransactionCategoryOptionStatus =
  | 'ok'
  | 'not_found'
  | 'already_resolved';

export type TransactionSetCategoryStatus =
  | 'updated'
  | 'not_found'
  | 'already_resolved'
  | 'unauthorized_budget';

export interface TransactionCategoryOptionsRequestDto {
  pendingTransactionId?: string;
  transactionId?: string;
  callbackMode?: TransactionCallbackMode;
  userId: string;
}

export interface TransactionCategoryOptionsResponseDto {
  status: TransactionCategoryOptionStatus;
  pendingTransactionId: string;
  text: string | null;
  replyMarkup: TelegramReplyMarkupDto | null;
}

export interface TransactionSetCategoryRequestDto {
  pendingTransactionId?: string;
  transactionId?: string;
  budgetId?: string;
  userId: string;
  category?: string;
}

export interface TransactionSetCategoryResponseDto {
  status: TransactionSetCategoryStatus;
  pendingTransactionId: string | null;
  transactionId: string | null;
  confirmationPayload: TransactionConfirmationPayloadResponseDto | null;
  summary: ConfirmTransactionSummaryDto | null;
  editMessage: ConfirmTransactionEditMessageDto | null;
}
