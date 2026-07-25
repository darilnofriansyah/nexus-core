export type AegisSeverity = "INFO" | "WARNING" | "ERROR" | "CRITICAL";

export interface N8nWorkflowReferenceDto {
  id?: string;
  name?: string;
}

export interface N8nExecutionReferenceDto {
  id?: string;
  url?: string;
  mode?: string;
  lastNodeExecuted?: string;
  executionContext?: {
    triggerNode?: {
      name?: string;
    };
  };
  retryOf?: string | number;
  startedAt?: string;
  stoppedAt?: string;
  error?: N8nErrorReferenceDto;
}

export interface N8nErrorReferenceDto {
  message?: string;
  name?: string;
  description?: string;
  stack?: string;
  node?: string | { name?: string; type?: string };
  errorResponse?: N8nErrorResponseReferenceDto;
}

export interface N8nErrorResponseReferenceDto {
  httpCode?: string | number;
  messages?: string | string[];
  executionId?: string | number;
  context?: {
    request?: {
      method?: string;
      uri?: string;
      body?: unknown;
    };
  };
}

export interface AegisN8nErrorPayloadDto {
  workflow?: string | N8nWorkflowReferenceDto;
  execution?: string | number | N8nExecutionReferenceDto;
  error?: string | N8nErrorReferenceDto;
  workflowName?: string;
  workflowId?: string;
  executionId?: string | number;
  executionUrl?: string;
  executionMode?: string;
  errorMessage?: string;
  errorNode?: string;
  severity?: string;
  occurredAt?: string;
  source?: string;
}

export type AegisRetryMode = "retryable" | "retry_anyway" | "not_retryable";

export interface AegisRetryMetadataDto {
  eligible: boolean;
  mode: AegisRetryMode;
  reason: string;
  workflowId: string | null;
  executionId: string | null;
}

export interface AegisTelegramReplyMarkupDto {
  inline_keyboard: Array<
    Array<{
      text: string;
      callback_data: string;
    }>
  >;
}

export interface AegisN8nErrorAlertDto {
  chatText: string;
  chat_id: string;
  text: string;
  parse_mode: "HTML";
  disable_web_page_preview: true;
  bot_token_env: "AEGIS_TOKEN";
  reply_markup?: AegisTelegramReplyMarkupDto;
  retry: AegisRetryMetadataDto;
  severity: AegisSeverity;
  workflowId: string | null;
  executionId: string | null;
  executionUrl: string | null;
}

export interface AegisRetryCallbackRequestDto {
  callbackData?: string;
  data?: string;
  chatId?: string | number;
  messageId?: string | number;
  callback_query?: {
    data?: string;
    message?: {
      chat?: {
        id?: string | number;
      };
      message_id?: string | number;
    };
  };
}

export interface AegisRetryCallbackResponseDto {
  status: "ready" | "invalid" | "unauthorized";
  action: "retry_execution" | "none";
  workflowId: string | null;
  executionId: string | null;
  telegram: {
    editMessageText: {
      chat_id: string | null;
      message_id: string | null;
      text: string;
      parse_mode: "HTML";
      reply_markup: null;
    };
  };
}
