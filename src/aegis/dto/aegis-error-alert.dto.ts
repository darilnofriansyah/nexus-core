export type AegisSeverity = 'INFO' | 'WARNING' | 'ERROR' | 'CRITICAL';

export interface N8nWorkflowReferenceDto {
  id?: string;
  name?: string;
}

export interface N8nExecutionReferenceDto {
  id?: string;
  url?: string;
  mode?: string;
  startedAt?: string;
  stoppedAt?: string;
}

export interface N8nErrorReferenceDto {
  message?: string;
  name?: string;
  description?: string;
  stack?: string;
  node?: string | { name?: string; type?: string };
}

export interface AegisN8nErrorPayloadDto {
  workflow?: string | N8nWorkflowReferenceDto;
  execution?: string | number | N8nExecutionReferenceDto;
  error?: string | N8nErrorReferenceDto;
  workflowName?: string;
  workflowId?: string;
  executionId?: string | number;
  executionUrl?: string;
  errorMessage?: string;
  errorNode?: string;
  severity?: string;
  occurredAt?: string;
  source?: string;
}

export interface AegisN8nErrorAlertDto {
  chatText: string;
  severity: AegisSeverity;
  workflowId: string | null;
  executionId: string | null;
  executionUrl: string | null;
}
