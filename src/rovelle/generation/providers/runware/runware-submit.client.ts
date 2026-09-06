import {
  Injectable,
  Optional,
  ServiceUnavailableException,
} from "@nestjs/common";
import { readEnv, type CoreApiEnv } from "../../../../config/env";

export type RunwareErrorCode =
  | "AUTH"
  | "QUOTA"
  | "RATE_LIMIT"
  | "VALIDATION"
  | "TIMEOUT"
  | "PROVIDER"
  | "NETWORK"
  | "MALFORMED_RESPONSE"
  | "UNKNOWN";

export class RunwareSubmissionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "RunwareSubmissionError";
  }
}

export interface RunwareVideoTask {
  taskType: "videoInference";
  taskUUID: string;
  model: string;
  positivePrompt: string;
  width: number;
  height: number;
  duration: number;
  inputs: { referenceImages: string[] };
  settings?: { audio: false };
  deliveryMethod: "async";
  numberResults: 1;
  outputType: "URL";
  outputFormat: "MP4";
  includeCost: true;
  ttl: 60;
  uploadEndpoint: string;
}

type RunwareClientEnv = Pick<
  CoreApiEnv,
  "runwareApiKey" | "runwareApiBaseUrl" | "runwareSubmitTimeoutMs"
>;

type FetchImplementation = typeof fetch;

@Injectable()
export class RunwareSubmitClient {
  private readonly env: RunwareClientEnv;
  private readonly fetchImpl: FetchImplementation;

  constructor(fetchImpl?: FetchImplementation);
  constructor(env?: RunwareClientEnv, fetchImpl?: FetchImplementation);
  constructor(
    @Optional()
    envOrFetch: RunwareClientEnv | FetchImplementation = readEnv(),
    @Optional()
    maybeFetch?: FetchImplementation,
  ) {
    if (typeof envOrFetch === "function") {
      this.env = readEnv();
      this.fetchImpl = envOrFetch;
      return;
    }
    this.env = envOrFetch;
    this.fetchImpl = maybeFetch ?? globalThis.fetch;
  }

  async submit(task: RunwareVideoTask): Promise<{ providerTaskId: string }> {
    const apiKey = this.env.runwareApiKey?.trim();
    if (!apiKey) {
      throw new ServiceUnavailableException(
        "Runware API key is not configured",
      );
    }

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.env.runwareSubmitTimeoutMs,
    );

    try {
      let response: Response;
      try {
        response = await this.fetchImpl(this.env.runwareApiBaseUrl, {
          method: "POST",
          headers: {
            authorization: `Bearer ${apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify([task]),
          signal: controller.signal,
        });
      } catch (error) {
        if (isAbortError(error, controller)) {
          throw new RunwareSubmissionError(
            "TIMEOUT",
            "Runware submission timed out",
            true,
          );
        }
        throw new RunwareSubmissionError(
          "NETWORK",
          "Runware submission failed due to a network error",
          true,
        );
      }

      let body: unknown;
      try {
        body = await response.json();
      } catch (error) {
        if (isAbortError(error, controller)) {
          throw new RunwareSubmissionError(
            "TIMEOUT",
            "Runware submission timed out",
            true,
          );
        }
        if (!response.ok) {
          throw new RunwareSubmissionError(
            codeForStatus(response.status),
            `Runware provider returned HTTP ${response.status}`,
            retryableForStatus(response.status),
          );
        }
        throw new RunwareSubmissionError(
          "MALFORMED_RESPONSE",
          "Runware provider returned malformed JSON",
          false,
        );
      }

      if (!response.ok) {
        throw this.providerError(body, response.status, apiKey);
      }

      const matchingError = findMatchingError(body, task.taskUUID);
      if (matchingError) {
        throw this.providerError(matchingError, undefined, apiKey);
      }

      const providerTaskId = findMatchingTaskId(body, task.taskUUID);
      if (!providerTaskId) {
        throw new RunwareSubmissionError(
          "MALFORMED_RESPONSE",
          "Runware response did not contain the submitted task UUID",
          false,
        );
      }

      return { providerTaskId };
    } finally {
      clearTimeout(timeout);
    }
  }

  private providerError(
    body: unknown,
    status: number | undefined,
    apiKey: string,
  ): RunwareSubmissionError {
    const error =
      isRecord(body) && ("code" in body || "message" in body)
        ? body
        : firstError(body);
    const providerCode = readString(error?.code);
    const code = providerCode
      ? codeForProvider(providerCode, status)
      : status === undefined
        ? "PROVIDER"
        : codeForStatus(status);
    const message = sanitizeMessage(
      readString(error?.message) ??
        (status === undefined
          ? "Runware provider rejected the submission"
          : `Runware provider returned HTTP ${status}`),
      apiKey,
    );
    return new RunwareSubmissionError(code, message, retryableForCode(code));
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function firstError(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value) || !Array.isArray(value.errors)) return undefined;
  const error = value.errors.find(isRecord);
  return error;
}

function findMatchingError(
  value: unknown,
  taskUUID: string,
): Record<string, unknown> | undefined {
  if (!isRecord(value) || !Array.isArray(value.errors)) return undefined;
  return value.errors.find(
    (error): error is Record<string, unknown> =>
      isRecord(error) && error.taskUUID === taskUUID,
  );
}

function findMatchingTaskId(
  value: unknown,
  taskUUID: string,
): string | undefined {
  if (!isRecord(value) || !Array.isArray(value.data)) return undefined;
  const match = value.data.find(
    (item): item is Record<string, unknown> =>
      isRecord(item) && item.taskUUID === taskUUID,
  );
  return match ? readString(match.taskUUID) : undefined;
}

function isAbortError(error: unknown, controller: AbortController): boolean {
  return (
    controller.signal.aborted ||
    (isRecord(error) && error.name === "AbortError")
  );
}

function codeForStatus(status: number): RunwareErrorCode {
  if (status === 401 || status === 403) return "AUTH";
  if (status === 402) return "QUOTA";
  if (status === 408) return "TIMEOUT";
  if (status === 422 || status === 400) return "VALIDATION";
  if (status === 429) return "RATE_LIMIT";
  if (status >= 500) return "PROVIDER";
  return "UNKNOWN";
}

function codeForProvider(code: string, status?: number): RunwareErrorCode {
  const normalized = code.toUpperCase();
  if (normalized.includes("AUTH") || normalized.includes("UNAUTHORIZED")) {
    return "AUTH";
  }
  if (normalized.includes("QUOTA") || normalized.includes("CREDIT")) {
    return "QUOTA";
  }
  if (normalized.includes("RATE") || normalized.includes("THROTTL")) {
    return "RATE_LIMIT";
  }
  if (normalized.includes("VALID") || normalized.includes("INPUT")) {
    return "VALIDATION";
  }
  if (normalized.includes("TIMEOUT")) return "TIMEOUT";
  if (normalized.includes("NETWORK")) return "NETWORK";
  if (status !== undefined) return codeForStatus(status);
  return "PROVIDER";
}

function retryableForStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function retryableForCode(code: string): boolean {
  return (
    code === "RATE_LIMIT" ||
    code === "TIMEOUT" ||
    code === "NETWORK" ||
    code === "PROVIDER"
  );
}

function sanitizeMessage(message: string, apiKey: string): string {
  return message
    .split(apiKey)
    .join("[redacted]")
    .replace(/https?:\/\/[^\s]+/gi, "[redacted-url]");
}
