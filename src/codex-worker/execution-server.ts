import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

import {
  hashCreativeValue,
  normalizeCreativeCompletion,
  normalizeCreativeInput,
} from "../rovelle/creative/creative-validation";
import type {
  CreativeExecutionOutcome,
  CreativeExecutionRequest,
  CreativeInput,
} from "../rovelle/creative/dto/creative.dto";

const BODY_LIMIT_BYTES = 600 * 1024;
const VALIDATION_TOKEN = "A".repeat(43);
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type StoryboardExecutor = (
  request: CreativeExecutionRequest,
  signal: AbortSignal,
) => Promise<CreativeExecutionOutcome>;

export interface ExecutionServer extends Server {
  shutdown(): Promise<void>;
}

class BodyTooLargeError extends Error {}
class InvalidRequestError extends Error {}
class ConflictRequestError extends Error {}

export function createExecutionServer(
  execute: StoryboardExecutor,
): ExecutionServer {
  const startedIds = new Set<string>();
  const active = new Set<AbortController>();
  const server = createServer((request, response) => {
    void handleRequest(request, response, execute, startedIds, active).catch(
      () => {
        sendJson(response, 500, { error: "execution_unavailable" });
      },
    );
  }) as ExecutionServer;

  server.shutdown = async () => {
    for (const controller of active) controller.abort();
    if (!server.listening) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  };
  return server;
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  execute: StoryboardExecutor,
  startedIds: Set<string>,
  active: Set<AbortController>,
): Promise<void> {
  if (request.method !== "POST" || request.url !== "/execute") {
    sendJson(response, 404, { error: "not_found" });
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readBody(request, BODY_LIMIT_BYTES));
  } catch (error) {
    sendJson(response, error instanceof BodyTooLargeError ? 413 : 400, {
      error:
        error instanceof BodyTooLargeError
          ? "payload_too_large"
          : "invalid_json",
    });
    return;
  }

  let executionRequest: CreativeExecutionRequest;
  try {
    executionRequest = normalizeRequest(parsed);
  } catch (error) {
    sendJson(response, error instanceof ConflictRequestError ? 409 : 400, {
      error:
        error instanceof ConflictRequestError
          ? "request_conflict"
          : "invalid_request",
    });
    return;
  }

  if (startedIds.has(executionRequest.jobId)) {
    sendJson(response, 409, { error: "execution_already_started" });
    return;
  }
  startedIds.add(executionRequest.jobId);

  const controller = new AbortController();
  active.add(controller);
  response.on("close", () => {
    if (!response.writableEnded) controller.abort();
  });

  try {
    const outcome = normalizeOutcome(
      await execute(executionRequest, controller.signal),
      executionRequest.input,
    );
    if (!controller.signal.aborted) sendJson(response, 200, outcome);
  } catch (error) {
    if (!controller.signal.aborted && !isAbortError(error)) {
      sendJson(response, 500, { error: "execution_outcome_unknown" });
    }
  } finally {
    active.delete(controller);
  }
}

function normalizeRequest(value: unknown): CreativeExecutionRequest {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["jobId", "task", "input", "inputHash"])
  ) {
    throw new InvalidRequestError();
  }
  if (typeof value.jobId !== "string" || !UUID_PATTERN.test(value.jobId)) {
    throw new InvalidRequestError();
  }
  if (value.task !== "STORYBOARD") throw new ConflictRequestError();
  if (
    typeof value.inputHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.inputHash)
  ) {
    throw new InvalidRequestError();
  }

  let input: CreativeInput;
  try {
    input = normalizeCreativeInput(value.input);
  } catch {
    throw new InvalidRequestError();
  }
  if (hashCreativeValue(input) !== value.inputHash) {
    throw new ConflictRequestError();
  }

  return {
    jobId: value.jobId.toLowerCase(),
    task: "STORYBOARD",
    input,
    inputHash: value.inputHash,
  };
}

function normalizeOutcome(
  value: unknown,
  input: CreativeInput,
): CreativeExecutionOutcome {
  if (!isRecord(value)) throw new InvalidRequestError();
  const keys =
    value.status === "COMPLETED"
      ? ["status", "result", "metadata"]
      : ["status", "errorCode", "metadata"];
  if (!hasExactKeys(value, keys)) throw new InvalidRequestError();

  const completion = normalizeCreativeCompletion(
    {
      ...value,
      attemptToken: VALIDATION_TOKEN,
      inputHash: hashCreativeValue(input),
    },
    input,
  );
  return completion.status === "COMPLETED"
    ? {
        status: completion.status,
        result: completion.result,
        metadata: completion.metadata,
      }
    : {
        status: completion.status,
        errorCode: completion.errorCode,
        metadata: completion.metadata,
      };
}

function readBody(request: IncomingMessage, limit: number): Promise<string> {
  const contentLength = request.headers["content-length"];
  if (typeof contentLength === "string" && Number(contentLength) > limit) {
    request.resume();
    return Promise.reject(new BodyTooLargeError());
  }

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    request.on("data", (chunk: Buffer | string) => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > limit) {
        settled = true;
        request.resume();
        reject(new BodyTooLargeError());
        return;
      }
      chunks.push(buffer);
    });
    request.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    request.on("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

function sendJson(
  response: ServerResponse,
  statusCode: number,
  payload: Record<string, unknown>,
): void {
  if (response.headersSent || response.destroyed) return;
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return (
    Object.keys(value).length === keys.length &&
    Object.keys(value).every((key) => keys.includes(key))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
