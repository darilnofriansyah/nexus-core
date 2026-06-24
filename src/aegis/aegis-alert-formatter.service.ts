import { Injectable } from "@nestjs/common";
import {
  AegisN8nErrorAlertDto,
  AegisN8nErrorPayloadDto,
  AegisSeverity,
  N8nErrorReferenceDto,
  N8nErrorResponseReferenceDto,
  N8nExecutionReferenceDto,
  N8nWorkflowReferenceDto,
} from "./dto/aegis-error-alert.dto";

const AEGIS_BOT_TOKEN_ENV = "AEGIS_TOKEN";
const TELEGRAM_HTML_PARSE_MODE = "HTML";
const TELEGRAM_SAFE_TEXT_LIMIT = 3900;
const UNKNOWN_VALUE = "Unknown";
const REDACTED_VALUE = "[redacted]";
const SENSITIVE_KEY_PARTS = [
  "api_key",
  "api-key",
  "authorization",
  "token",
  "password",
  "secret",
  "cookie",
];

interface NormalizedIncident {
  severity: AegisSeverity;
  workflowName: string;
  workflowId: string | null;
  executionId: string | null;
  executionUrl: string | null;
  executionMode: string | null;
  triggerNode: string | null;
  failedNode: string | null;
  lastNode: string | null;
  errorMessage: string;
  httpFailure: HttpFailureSummary | null;
  requestSummary: RequestSummary | null;
}

interface HttpFailureSummary {
  status: string | null;
  endpoint: string | null;
  response: string | null;
}

interface RequestSummary {
  telegramUserId?: string;
  userId?: string;
  source?: string;
  text?: string;
  llm?: string;
  missing?: string;
  confidence?: string;
}

type AegisFormatterInput = AegisN8nErrorPayloadDto | AegisN8nErrorPayloadDto[];

type UnknownRecord = Record<string, unknown>;

@Injectable()
export class AegisAlertFormatterService {
  formatN8nErrorAlert(payload: AegisFormatterInput): AegisN8nErrorAlertDto {
    const incident = this.normalizeIncident(payload);
    const text = this.truncateTelegramText(this.renderIncident(incident));

    return {
      chatText: text,
      chat_id: process.env.ADMIN_TELEGRAM_ID ?? "",
      text,
      parse_mode: TELEGRAM_HTML_PARSE_MODE,
      disable_web_page_preview: true,
      bot_token_env: AEGIS_BOT_TOKEN_ENV,
      severity: incident.severity,
      workflowId: incident.workflowId,
      executionId: incident.executionId,
      executionUrl: incident.executionUrl,
    };
  }

  private normalizeIncident(payload: AegisFormatterInput): NormalizedIncident {
    const item = Array.isArray(payload) ? payload[0] : payload;
    const safePayload = this.isRecord(item) ? item : {};
    const typedPayload = safePayload as AegisN8nErrorPayloadDto;
    const execution = this.executionReference(typedPayload.execution);
    const executionError = this.errorReference(execution.error);
    const payloadError = this.errorReference(typedPayload.error);
    const error = this.mergeErrorReferences(payloadError, executionError);
    const errorResponse = error.errorResponse;
    const workflow = this.workflowReference(typedPayload.workflow);
    const executionId =
      this.cleanString(typedPayload.executionId) ??
      execution.id ??
      this.cleanString(errorResponse?.executionId) ??
      null;

    return {
      severity: this.normalizeSeverity(typedPayload.severity),
      workflowName:
        this.cleanString(typedPayload.workflowName) ??
        workflow.name ??
        "Unknown workflow",
      workflowId:
        this.cleanString(typedPayload.workflowId) ?? workflow.id ?? null,
      executionId,
      executionUrl:
        this.cleanString(typedPayload.executionUrl) ?? execution.url ?? null,
      executionMode:
        this.cleanString(typedPayload.executionMode) ?? execution.mode ?? null,
      triggerNode: execution.triggerNode ?? null,
      failedNode:
        this.cleanString(typedPayload.errorNode) ?? error.node ?? null,
      lastNode: execution.lastNodeExecuted ?? null,
      errorMessage:
        this.cleanString(typedPayload.errorMessage) ??
        error.message ??
        "No error message provided",
      httpFailure: this.httpFailureSummary(errorResponse),
      requestSummary: this.requestSummary(errorResponse),
    };
  }

  private renderIncident(incident: NormalizedIncident): string {
    const lines = [
      "🚨 <b>Aegis Incident</b>",
      "",
      `<b>Workflow:</b> ${this.escapeHtml(incident.workflowName)}`,
      `<b>Execution:</b> ${this.executionLine(incident)}`,
      `<b>Mode:</b> ${this.escapeHtml(incident.executionMode ?? UNKNOWN_VALUE)}`,
      `<b>Trigger:</b> ${this.escapeHtml(incident.triggerNode ?? UNKNOWN_VALUE)}`,
      "",
      `<b>Failed Node:</b> ${this.escapeHtml(incident.failedNode ?? UNKNOWN_VALUE)}`,
      `<b>Last Node:</b> ${this.escapeHtml(incident.lastNode ?? UNKNOWN_VALUE)}`,
      `<b>Error:</b> ${this.escapeHtml(incident.errorMessage)}`,
    ];

    if (incident.httpFailure) {
      lines.push(
        "",
        "<b>HTTP FAILURE</b>",
        `<b>Status:</b> ${this.escapeHtml(incident.httpFailure.status ?? UNKNOWN_VALUE)}`,
        `<b>Endpoint:</b> ${this.escapeHtml(incident.httpFailure.endpoint ?? UNKNOWN_VALUE)}`,
        `<b>Response:</b> ${this.escapeHtml(incident.httpFailure.response ?? UNKNOWN_VALUE)}`,
      );
    }

    if (incident.requestSummary) {
      lines.push("", "<b>Request Summary</b>");
      this.pushOptionalLine(
        lines,
        "User",
        this.requestUserLine(incident.requestSummary),
      );
      this.pushOptionalLine(lines, "Source", incident.requestSummary.source);
      this.pushOptionalLine(lines, "Text", incident.requestSummary.text);
      this.pushOptionalLine(lines, "LLM", incident.requestSummary.llm);
      this.pushOptionalLine(lines, "Missing", incident.requestSummary.missing);
      this.pushOptionalLine(
        lines,
        "Confidence",
        incident.requestSummary.confidence,
      );
    }

    return lines.join("\n");
  }

  private executionLine(incident: NormalizedIncident): string {
    const executionText = this.escapeHtml(
      incident.executionId ?? UNKNOWN_VALUE,
    );

    if (!incident.executionUrl || !incident.executionId) {
      return executionText;
    }

    return `<a href="${this.escapeHtml(incident.executionUrl)}">${executionText}</a>`;
  }

  private pushOptionalLine(
    lines: string[],
    label: string,
    value: string | undefined,
  ): void {
    if (!value) {
      return;
    }

    lines.push(`<b>${label}:</b> ${this.escapeHtml(value)}`);
  }

  private requestUserLine(summary: RequestSummary): string | undefined {
    if (!summary.telegramUserId && !summary.userId) {
      return undefined;
    }

    return `${summary.telegramUserId ?? UNKNOWN_VALUE} / ${
      summary.userId ?? UNKNOWN_VALUE
    }`;
  }

  private normalizeSeverity(severity?: string): AegisSeverity {
    const normalized = severity?.trim().toUpperCase();

    if (
      normalized === "INFO" ||
      normalized === "WARNING" ||
      normalized === "ERROR" ||
      normalized === "CRITICAL"
    ) {
      return normalized;
    }

    return "ERROR";
  }

  private workflowReference(
    workflow: AegisN8nErrorPayloadDto["workflow"],
  ): N8nWorkflowReferenceDto {
    if (typeof workflow === "string") {
      return { name: this.cleanString(workflow) };
    }

    if (!workflow) {
      return {};
    }

    return {
      id: this.cleanString(workflow.id),
      name: this.cleanString(workflow.name),
    };
  }

  private executionReference(
    execution: AegisN8nErrorPayloadDto["execution"],
  ): N8nExecutionReferenceDto & {
    triggerNode?: string;
  } {
    if (typeof execution === "string" || typeof execution === "number") {
      return { id: this.cleanString(execution) };
    }

    if (!execution) {
      return {};
    }

    return {
      id: this.cleanString(execution.id),
      url: this.cleanString(execution.url),
      mode: this.cleanString(execution.mode),
      lastNodeExecuted: this.cleanString(execution.lastNodeExecuted),
      triggerNode: this.cleanString(
        execution.executionContext?.triggerNode?.name,
      ),
      retryOf: this.cleanString(execution.retryOf),
      startedAt: this.cleanString(execution.startedAt),
      stoppedAt: this.cleanString(execution.stoppedAt),
      error: execution.error,
    };
  }

  private errorReference(error: AegisN8nErrorPayloadDto["error"]): {
    message?: string;
    node?: string;
    errorResponse?: N8nErrorResponseReferenceDto;
  } {
    if (typeof error === "string") {
      return { message: this.cleanString(error) };
    }

    if (!error) {
      return {};
    }

    return {
      message:
        this.cleanString(error.message) ??
        this.cleanString(error.description) ??
        this.cleanString(error.name),
      node: this.errorNodeName(error),
      errorResponse: error.errorResponse,
    };
  }

  private mergeErrorReferences(
    payloadError: ReturnType<AegisAlertFormatterService["errorReference"]>,
    executionError: ReturnType<AegisAlertFormatterService["errorReference"]>,
  ): ReturnType<AegisAlertFormatterService["errorReference"]> {
    return {
      message: payloadError.message ?? executionError.message,
      node: payloadError.node ?? executionError.node,
      errorResponse: payloadError.errorResponse ?? executionError.errorResponse,
    };
  }

  private errorNodeName(error: N8nErrorReferenceDto): string | undefined {
    if (typeof error.node === "string") {
      return this.cleanString(error.node);
    }

    return (
      this.cleanString(error.node?.name) ?? this.cleanString(error.node?.type)
    );
  }

  private httpFailureSummary(
    errorResponse: N8nErrorResponseReferenceDto | undefined,
  ): HttpFailureSummary | null {
    if (!errorResponse) {
      return null;
    }

    const status = this.cleanString(errorResponse.httpCode);
    const request = errorResponse.context?.request;
    const endpoint = this.endpointSummary(request?.method, request?.uri);
    const response = this.errorResponseMessage(errorResponse.messages);

    if (!status && !endpoint && !response) {
      return null;
    }

    return {
      status: status ?? null,
      endpoint,
      response,
    };
  }

  private endpointSummary(
    method: string | undefined,
    uri: string | undefined,
  ): string | null {
    const cleanUri = this.cleanString(uri);
    const cleanMethod = this.cleanString(method)?.toUpperCase();

    if (!cleanUri && !cleanMethod) {
      return null;
    }

    const path = cleanUri ? this.uriPath(cleanUri) : null;
    return [cleanMethod, path].filter(Boolean).join(" ");
  }

  private uriPath(uri: string): string {
    try {
      return new URL(uri).pathname;
    } catch {
      return uri;
    }
  }

  private errorResponseMessage(
    messages: string | string[] | undefined,
  ): string | null {
    const message = Array.isArray(messages) ? messages.join(" | ") : messages;
    const cleanMessage = this.cleanString(message);

    if (!cleanMessage) {
      return null;
    }

    const embeddedJson = this.parseEmbeddedJson(cleanMessage);

    if (embeddedJson) {
      return this.summarizeEmbeddedJson(embeddedJson);
    }

    return cleanMessage;
  }

  private parseEmbeddedJson(message: string): UnknownRecord | null {
    const firstBrace = message.indexOf("{");
    const lastBrace = message.lastIndexOf("}");

    if (firstBrace < 0 || lastBrace <= firstBrace) {
      return null;
    }

    const candidate = message.slice(firstBrace, lastBrace + 1);
    const attempts = [candidate, candidate.replaceAll('\\"', '"')];

    for (const attempt of attempts) {
      const parsed = this.parseJsonObject(attempt);

      if (parsed) {
        return parsed;
      }
    }

    return null;
  }

  private parseJsonObject(value: string): UnknownRecord | null {
    try {
      const parsed: unknown = JSON.parse(value);
      return this.isRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  private summarizeEmbeddedJson(value: UnknownRecord): string {
    const parts = [
      this.safeField(value, "message"),
      this.safeField(value, "error"),
      this.safeField(value, "statusCode", "statusCode"),
    ].filter((part): part is string => Boolean(part));

    return parts.length > 0
      ? parts.join(" | ")
      : JSON.stringify(this.redact(value));
  }

  private requestSummary(
    errorResponse: N8nErrorResponseReferenceDto | undefined,
  ): RequestSummary | null {
    const body = errorResponse?.context?.request?.body;

    if (!this.isRecord(body)) {
      return null;
    }

    const llmResult = this.recordField(body, "llmResult");
    const summary: RequestSummary = {
      telegramUserId: this.safeField(body, "telegramUserId"),
      userId: this.safeField(body, "userId"),
      source: this.safeField(body, "source"),
      text: this.safeField(body, "text"),
      llm: llmResult ? this.llmSummary(llmResult) : undefined,
      missing: llmResult ? this.missingFieldsSummary(llmResult) : undefined,
      confidence: llmResult
        ? this.safeField(llmResult, "confidence")
        : undefined,
    };

    return Object.values(summary).some(Boolean) ? summary : null;
  }

  private llmSummary(llmResult: UnknownRecord): string | undefined {
    const fields = [
      "intent",
      "transaction_type",
      "amount",
      "merchant",
      "category",
    ]
      .map((key) => this.safeField(llmResult, key))
      .filter((field): field is string => Boolean(field));

    return fields.length > 0 ? fields.join(", ") : undefined;
  }

  private missingFieldsSummary(llmResult: UnknownRecord): string | undefined {
    const missingFields = llmResult.missing_fields;

    if (Array.isArray(missingFields)) {
      return missingFields
        .map((field) => this.cleanString(field))
        .filter((field): field is string => Boolean(field))
        .join(", ");
    }

    return this.safeField(llmResult, "missing_fields");
  }

  private safeField(
    record: UnknownRecord,
    key: string,
    label?: string,
  ): string | undefined {
    if (this.isSensitiveKey(key)) {
      return label ? `${label}=${REDACTED_VALUE}` : REDACTED_VALUE;
    }

    const value = record[key];

    if (value === null || value === undefined) {
      return undefined;
    }

    const cleanValue = this.cleanString(this.redact(value));

    if (!cleanValue) {
      return undefined;
    }

    return label ? `${label}=${cleanValue}` : cleanValue;
  }

  private recordField(
    record: UnknownRecord,
    key: string,
  ): UnknownRecord | null {
    const value = record[key];
    return this.isRecord(value) ? value : null;
  }

  private redact(value: unknown): unknown {
    if (Array.isArray(value)) {
      return value.map((item) => this.redact(item));
    }

    if (!this.isRecord(value)) {
      return value;
    }

    return Object.fromEntries(
      Object.entries(value).map(([key, entryValue]) => [
        key,
        this.isSensitiveKey(key) ? REDACTED_VALUE : this.redact(entryValue),
      ]),
    );
  }

  private isSensitiveKey(key: string): boolean {
    const normalized = key.toLowerCase();
    return SENSITIVE_KEY_PARTS.some((sensitivePart) =>
      normalized.includes(sensitivePart),
    );
  }

  private isRecord(value: unknown): value is UnknownRecord {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  private cleanString(value: unknown): string | undefined {
    if (value === null || value === undefined) {
      return undefined;
    }

    const stringValue =
      typeof value === "string" ? value.trim() : String(value).trim();
    return stringValue.length > 0 ? stringValue : undefined;
  }

  private escapeHtml(value: string): string {
    return value
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  private truncateTelegramText(text: string): string {
    if (text.length <= TELEGRAM_SAFE_TEXT_LIMIT) {
      return text;
    }

    return text.slice(0, TELEGRAM_SAFE_TEXT_LIMIT - 3).trimEnd() + "...";
  }
}
