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

export interface AegisN8nErrorAlertDto {
  chatText: string;
  chat_id: string;
  text: string;
  parse_mode: "HTML";
  disable_web_page_preview: true;
  bot_token_env: "AEGIS_TOKEN";
  severity: AegisSeverity;
  workflowId: string | null;
  executionId: string | null;
  executionUrl: string | null;
}
