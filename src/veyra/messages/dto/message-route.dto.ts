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

export type MasterIntent =
  | 'spending_summary'
  | 'category_spending'
  | 'merchant_spending'
  | 'top_merchants'
  | 'top_categories'
  | 'spending_comparison'
  | 'merchant_comparison'
  | 'category_comparison'
  | 'largest_transactions'
  | 'recent_transactions'
  | 'subscription_summary'
  | 'subscription_detail'
  | 'spending_trend'
  | 'daily_average_spending'
  | 'burn_rate_forecast'
  | 'most_frequent_merchant'
  | 'transaction_count'
  | 'spending_by_day'
  | 'weekday_analysis'
  | 'cashflow_summary'
  | 'budget_status'
  | 'edit_transaction'
  | 'delete_transaction'
  | 'select_transaction'
  | 'confirm_action'
  | 'cancel_action'
  | 'unknown';

export interface MasterIntentResultDto {
  intent: MasterIntent;
  period: string | null;
  merchant: string | null;
  category: string | null;
  limit: number | null;
  target: {
    id: string | number | null;
    merchant: string | null;
    category: string | null;
    amount: number | null;
    period: string | null;
  };
  changes: {
    amount: number | null;
    merchant: string | null;
    merchant_normalized: string | null;
    category: string | null;
    transaction_date: string | null;
    transaction_type: string | null;
    notes: string | null;
  };
  selection: number | null;
  confidence: number;
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
  masterIntent?: MasterIntentResultDto;
}
