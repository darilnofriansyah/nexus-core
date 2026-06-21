export type VeyraMessageRoute =
  | 'callback'
  | 'slash_command'
  | 'budget'
  | 'record'
  | 'transaction_edit'
  | 'conversational'
  | 'fallback';

export type VeyraMessageRouteReason =
  | 'callback_query'
  | 'slash_command'
  | 'active_budget_state'
  | 'active_record_state'
  | 'active_transaction_edit_state'
  | 'no_active_state'
  | 'unknown_active_state'
  | 'user_not_resolved';

export interface RouteVeyraMessageRequestDto {
  telegramUserId?: string | number | null;
  userId?: string | number | null;
  text?: string | null;
  messageType?: string | null;
  callbackQuery?: unknown;
}

export interface VeyraMessageRouteStateDto {
  name: string;
  data: unknown;
}

export interface RouteVeyraMessageResponseDto {
  route: VeyraMessageRoute;
  reason: VeyraMessageRouteReason;
  userId: number | null;
  telegramUserId: string | null;
  text: string | null;
  messageType: string | null;
  command: string | null;
  state: VeyraMessageRouteStateDto | null;
}
