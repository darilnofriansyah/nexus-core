export interface CreatorTelegramRequestDto {
  telegramUserId: string;
  chatId: string;
  updateId?: string;
  messageText?: string;
  callbackToken?: string;
}

export interface CreatorTelegramRequest {
  telegramUserId: string;
  chatId: string;
  updateId?: string;
  messageText?: string;
  callbackToken?: string;
}

export type CreatorInlineButton =
  | { text: string; callbackData: string }
  | { text: string; url: string };

export interface CreatorTelegramReply {
  text: string;
  inlineKeyboard?: CreatorInlineButton[][];
  creativeJob?: { id: string; action: "DISPATCH" };
}

export type CreatorStep =
  | "IDLE"
  | "NEW_TITLE"
  | "NEW_DURATION"
  | "NEW_PREMISE"
  | "NEW_LEARNING_GOAL"
  | "NEW_TONE"
  | "NEW_CANON_CODES"
  | "NEW_DRAFT_MODE"
  | "NEW_SHOT_DIRECTIONS"
  | "CREATIVE_REVIEW"
  | "CREATIVE_FEEDBACK"
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
  draftMode?: "CREATIVE" | "MANUAL";
  creativeInputRevision?: number;
  creativeJobId?: string;
}
