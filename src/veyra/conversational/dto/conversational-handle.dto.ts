export type ConversationalIntent =
  | 'spending_summary'
  | 'category_spending'
  | 'merchant_spending'
  | 'top_merchants'
  | 'top_categories'
  | 'largest_transactions'
  | 'recent_transactions'
  | 'transaction_count'
  | 'spending_by_day'
  | 'daily_average_spending'
  | 'spending_trend'
  | 'cashflow_summary'
  | 'burn_rate_forecast'
  | 'subscription_summary'
  | 'subscription_detail'
  | 'spending_comparison'
  | 'merchant_comparison'
  | 'category_comparison'
  | 'weekday_analysis'
  | 'most_frequent_merchant'
  | 'unknown';

export type ConversationalPeriodLabel =
  | 'today'
  | 'yesterday'
  | 'this_week'
  | 'last_week'
  | 'this_month'
  | 'last_month'
  | 'current_cycle'
  | 'previous_cycle';

export type ConversationalStatus =
  | 'ok'
  | 'empty_result'
  | 'missing_field'
  | 'invalid_intent'
  | 'unsupported_intent'
  | 'user_not_found'
  | 'needs_insight'
  | 'error';

export interface ConversationalLlmResultDto {
  intent?: ConversationalIntent | string | null;
  period?: ConversationalPeriodLabel | string | null;
  comparisonPeriod?: ConversationalPeriodLabel | string | null;
  merchant?: string | null;
  category?: string | null;
  limit?: number | string | null;
  target?: unknown;
  needs_insight?: boolean | null;
  confidence?: number | null;
}

export interface ConversationalHandleRequestDto {
  telegramUserId?: string | number | null;
  userId?: string | number | null;
  text?: string | null;
  timezone?: string | null;
  statePayload?: Record<string, unknown> | null;
  llmResult?: ConversationalLlmResultDto | null;
}

export interface ConversationalTelegramMessageDto {
  text: string;
  parse_mode: 'HTML';
  disable_web_page_preview: true;
  reply_markup: null;
}

export interface ConversationalPeriodDto {
  label: ConversationalPeriodLabel;
  start: string;
  end: string;
}

export interface ConversationalInsightPayloadDto {
  intent: string;
  user_text: string;
  period: ConversationalPeriodDto;
  comparison_period: ConversationalPeriodDto | null;
  facts: Record<string, unknown>;
  rules: string[];
}

export interface ConversationalHandleResponseDto {
  ok: boolean;
  status: ConversationalStatus;
  intent: string;
  message: ConversationalTelegramMessageDto;
  data: Record<string, unknown>;
  insight_payload: ConversationalInsightPayloadDto | null;
}
