export interface VeyraCallbackQueryDto {
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

export interface VeyraCallbackRequestDto {
  telegramUserId?: unknown;
  userId?: unknown;
  user_id?: unknown;
  callbackData?: unknown;
  data?: unknown;
  text?: unknown;
  chatId?: unknown;
  messageId?: unknown;
  callback_query?: VeyraCallbackQueryDto;
  callbackQuery?: VeyraCallbackQueryDto;
}
