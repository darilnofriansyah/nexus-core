import { Injectable } from "@nestjs/common";
import {
  AegisN8nErrorAlertDto,
  AegisN8nErrorPayloadDto,
  AegisSeverity,
  N8nErrorReferenceDto,
  N8nExecutionReferenceDto,
  N8nWorkflowReferenceDto,
} from "./dto/aegis-error-alert.dto";

const AEGIS_BOT_TOKEN_ENV = "AEGIS_TOKEN";
const AEGIS_SERVICE_NAME = "Veyra";
const TELEGRAM_HTML_PARSE_MODE = "HTML";
const TELEGRAM_SAFE_TEXT_LIMIT = 3900;
const UNKNOWN_VALUE = "Unknown";

@Injectable()
export class AegisAlertFormatterService {
  formatN8nErrorAlert(payload: AegisN8nErrorPayloadDto): AegisN8nErrorAlertDto {
    const severity = this.normalizeSeverity(payload.severity);
    const workflow = this.workflowReference(payload.workflow);
    const execution = this.executionReference(payload.execution);
    const error = this.errorReference(payload.error);

    const workflowName =
      this.cleanString(payload.workflowName) ??
      workflow.name ??
      "Unknown workflow";
    const workflowId = this.cleanString(payload.workflowId) ?? workflow.id;
    const executionId =
      this.cleanString(payload.executionId) ?? execution.id ?? null;
    const executionUrl =
      this.cleanString(payload.executionUrl) ?? execution.url ?? null;
    const executionMode =
      this.cleanString(payload.executionMode) ?? execution.mode ?? null;
    const errorMessage =
      this.cleanString(payload.errorMessage) ??
      error.message ??
      "No error message provided";
    const errorNode = this.cleanString(payload.errorNode) ?? error.node;

    const lines = [
      "<b>AEGIS INCIDENT</b>",
      "------------------------------",
      `<b>Severity:</b> ${this.escapeHtml(severity)}`,
      `<b>Service:</b> ${this.escapeHtml(AEGIS_SERVICE_NAME)}`,
      `<b>Workflow:</b> ${this.escapeHtml(workflowName)}`,
      `<b>Node:</b> ${this.escapeHtml(errorNode ?? UNKNOWN_VALUE)}`,
      `<b>Execution:</b> ${this.escapeHtml(executionId ?? UNKNOWN_VALUE)}`,
      `<b>Mode:</b> ${this.escapeHtml(executionMode ?? UNKNOWN_VALUE)}`,
      "------------------------------",
      `<b>Error:</b> ${this.escapeHtml(errorMessage)}`,
      executionUrl
        ? `<b>Execution URL:</b> ${this.escapeHtml(executionUrl)}`
        : null,
    ].filter((line): line is string => line !== null);

    const text = this.truncateTelegramText(lines.join("\n"));

    return {
      chatText: text,
      chat_id: process.env.ADMIN_TELEGRAM_ID ?? "",
      text,
      parse_mode: TELEGRAM_HTML_PARSE_MODE,
      disable_web_page_preview: true,
      bot_token_env: AEGIS_BOT_TOKEN_ENV,
      severity,
      workflowId: workflowId ?? null,
      executionId,
      executionUrl,
    };
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
  ): N8nExecutionReferenceDto {
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
      retryOf: this.cleanString(execution.retryOf),
      startedAt: this.cleanString(execution.startedAt),
      stoppedAt: this.cleanString(execution.stoppedAt),
    };
  }

  private errorReference(error: AegisN8nErrorPayloadDto["error"]): {
    message?: string;
    node?: string;
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

  private cleanString(value: unknown): string | undefined {
    if (value === null || value === undefined) {
      return undefined;
    }

    const stringValue = String(value).trim();
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
