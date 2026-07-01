export type ConversationStateName =
  | 'idle'
  | 'record_transaction_state'
  | 'budget_conversation_state'
  | 'select_transaction'
  | 'confirm_action';

export type ConversationStateInput =
  | ConversationStateName
  | '/record'
  | '/budget';

export interface ConversationStateResponseDto {
  userId: string;
  stateName: ConversationStateName;
  stateData: unknown;
  expiresAt: string | null;
  updatedAt: string | null;
}

export interface UpsertConversationStateRequestDto {
  userId: string | number;
  stateName: ConversationStateInput;
  stateData?: unknown;
  expiresAt?: string | null;
}

export interface ResetConversationStateRequestDto {
  userId: string | number;
}
