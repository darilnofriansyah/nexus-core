import { BadRequestException } from "@nestjs/common";
import type { RunwareWebhookEvent } from "./runware-webhook.dto";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseRunwareWebhook(
  input: unknown,
): RunwareWebhookEvent {
  const { item, source } = unwrapSingleItem(input);
  if (item.taskType !== "videoInference") {
    throw new BadRequestException("taskType must be videoInference");
  }

  const taskId = requireTaskId(item.taskUUID);
  const progress = normalizeProgress(item.progress);
  const costUsd = normalizeCost(item.cost);
  const providerOutputId = normalizeOutputId(item.videoUUID);
  const status = item.status;
  const isFailure =
    status === "error" ||
    (status === undefined &&
      (hasOwn(item, "code") || hasOwn(item, "message")));

  if ((source === "errors" && !isFailure) || (source === "data" && isFailure)) {
    throw new BadRequestException("webhook result does not match its container");
  }

  if (status === "processing") {
    return { kind: "processing", taskId, progress };
  }

  if (status === "success") {
    return {
      kind: "success",
      taskId,
      providerOutputId,
      costUsd,
    };
  }

  if (status === "error") {
    return failureEvent(item, taskId, costUsd);
  }

  if (status !== undefined) {
    throw new BadRequestException("status is unsupported");
  }

  if (providerOutputId !== null) {
    return {
      kind: "success",
      taskId,
      providerOutputId,
      costUsd,
    };
  }

  if (hasOwn(item, "code") || hasOwn(item, "message")) {
    return failureEvent(item, taskId, costUsd);
  }

  throw new BadRequestException("status is required");
}

function unwrapSingleItem(input: unknown): {
  item: Record<string, unknown>;
  source: "direct" | "data" | "errors";
} {
  if (!isRecord(input)) {
    throw new BadRequestException("webhook payload must be an object");
  }

  const hasData = hasOwn(input, "data");
  const hasErrors = hasOwn(input, "errors");
  if (!hasData && !hasErrors) return { item: input, source: "direct" };

  if (hasData === hasErrors) {
    throw new BadRequestException("webhook payload must contain one result");
  }

  const items = input[hasData ? "data" : "errors"];
  if (!Array.isArray(items) || items.length !== 1 || !isRecord(items[0])) {
    throw new BadRequestException("webhook payload must contain one result");
  }

  return { item: items[0], source: hasData ? "data" : "errors" };
}

function failureEvent(
  item: Record<string, unknown>,
  taskId: string,
  costUsd: string | null,
): RunwareWebhookEvent {
  const code = requireNonEmptyString(item.code, "error code");
  const message = requireNonEmptyString(item.message, "error message");

  return { kind: "failure", taskId, code, message, costUsd };
}

function requireTaskId(value: unknown): string {
  if (typeof value !== "string") {
    throw new BadRequestException("taskUUID must be a valid UUID");
  }

  const taskId = value.trim();
  if (!UUID_PATTERN.test(taskId)) {
    throw new BadRequestException("taskUUID must be a valid UUID");
  }

  return taskId;
}

function normalizeOutputId(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new BadRequestException("videoUUID must be a non-empty string");
  }

  const outputId = value.trim();
  if (outputId.startsWith("//") || outputId.startsWith("\\\\")) {
    throw new BadRequestException("videoUUID must be an opaque identity");
  }

  try {
    new URL(outputId);
  } catch {
    return outputId;
  }

  throw new BadRequestException("videoUUID must be an opaque identity");
}

function normalizeProgress(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 100
  ) {
    throw new BadRequestException("progress must be between 0 and 100");
  }

  return value;
}

function normalizeCost(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new BadRequestException("cost must be a finite nonnegative number");
  }

  return String(value);
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new BadRequestException(`${field} is required`);
  }

  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}
