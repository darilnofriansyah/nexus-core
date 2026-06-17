export interface VeyraTelegramMessageDto {
  chatId?: string;
  telegramUserId?: string;
  messageText: string;
  messageId?: string;
  receivedAt?: string;
  source?: string;
}

