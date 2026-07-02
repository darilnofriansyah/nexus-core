export type TransactionCallbackHandleStatus = 'ok' | 'error';

export type TransactionCallbackHandleAction =
  | 'save_transaction'
  | 'cancel_transaction'
  | 'change_categories'
  | 'catid'
  | 'veyra_tx_manage'
  | 'invalid_callback'
  | 'unknown_callback';

export interface TransactionCallbackHandleRequestDto {
  telegramUserId: string;
  userId: number;
  callbackData: string;
  chatId?: string | number;
  messageId?: number;
}

export interface TransactionCallbackQueryDto {
  data?: unknown;
  from?: {
    id?: unknown;
  };
  message?: {
    chat?: {
      id?: unknown;
    };
    message_id?: unknown;
  };
}

export interface TransactionCallbackDispatchRequestDto {
  telegramUserId?: unknown;
  userId?: unknown;
  user_id?: unknown;
  callbackData?: unknown;
  data?: unknown;
  text?: unknown;
  chatId?: unknown;
  messageId?: unknown;
  callback_query?: TransactionCallbackQueryDto;
  callbackQuery?: TransactionCallbackQueryDto;
}

export interface TransactionCallbackTelegramPayloadDto {
  method: 'editMessageText';
  chat_id?: string | number;
  message_id?: number;
  text: string;
  parse_mode: 'HTML';
  reply_markup: object | null;
  disable_web_page_preview?: boolean;
}

export interface TransactionCallbackHandleResponseDto {
  status: TransactionCallbackHandleStatus;
  action: TransactionCallbackHandleAction;
  transactionId?: number;
  telegram: TransactionCallbackTelegramPayloadDto;
}
