export interface CreatorTelegramRequestDto {
  telegramUserId: string;
  chatId: string;
  messageText?: string;
  callbackToken?: string;
}

export interface CreatorTelegramRequest {
  telegramUserId: string;
  chatId: string;
  messageText?: string;
  callbackToken?: string;
}

export type CreatorInlineButton =
  | { text: string; callbackData: string }
  | { text: string; url: string };

export interface CreatorTelegramReply {
  text: string;
  inlineKeyboard?: CreatorInlineButton[][];
}

export type CreatorStep =
  | "IDLE"
  | "NEW_TITLE"
  | "NEW_DURATION"
  | "NEW_PREMISE"
  | "NEW_LEARNING_GOAL"
  | "NEW_TONE"
  | "NEW_CANON_CODES"
  | "NEW_SHOT_DIRECTIONS"
  | "CANON_SETUP"
  | "DRAFT_READY";

export interface CreatorDraftData {
  title?: string;
  duration?: string;
  premise?: string;
  learningGoal?: string;
  tone?: string;
  canonCodes?: string[];
  shotDirections?: string[];
}
