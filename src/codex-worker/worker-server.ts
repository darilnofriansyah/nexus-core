import { timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

import { validateJobId } from "./completion-store";

const MAX_DISPATCH_BODY_BYTES = 1024;

export interface WorkerServerConfig {
  bindAddress: string;
  port: number;
  dispatchKey: string;
}

export interface JobAccepter {
  enqueue(jobId: string): Promise<boolean>;
}

class BodyTooLargeError extends Error {}

export function createWorkerServer(
  config: WorkerServerConfig,
  processor: JobAccepter,
): Server {
  return createServer((request, response) => {
    void handleRequest(request, response, config, processor).catch(() => {
      sendJson(response, 503, { error: "worker_unavailable" });
    });
  });
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  config: WorkerServerConfig,
  processor: JobAccepter,
): Promise<void> {
  if (request.method !== "POST" || request.url !== "/jobs") {
    sendJson(response, 404, { error: "not_found" });
    return;
  }
  if (!hasDispatchKey(request, config.dispatchKey)) {
    sendJson(response, 401, { error: "unauthorized" });
    return;
  }

  let body: unknown;
  try {
    body = JSON.parse(await readBody(request, MAX_DISPATCH_BODY_BYTES));
  } catch (error) {
    sendJson(response, error instanceof BodyTooLargeError ? 413 : 400, {
      error:
        error instanceof BodyTooLargeError
          ? "payload_too_large"
          : "invalid_json",
    });
    return;
  }

  if (
    !isRecord(body) ||
    Object.keys(body).length !== 1 ||
    typeof body.jobId !== "string"
  ) {
    sendJson(response, 400, { error: "invalid_job_request" });
    return;
  }

  let jobId: string;
  try {
    jobId = validateJobId(body.jobId);
  } catch {
    sendJson(response, 400, { error: "invalid_job_id" });
    return;
  }

  if (!(await processor.enqueue(jobId))) {
    sendJson(response, 503, { error: "worker_capacity_unavailable" });
    return;
  }
  sendJson(response, 202, { accepted: true });
}

function hasDispatchKey(
  request: IncomingMessage,
  expectedKey: string,
): boolean {
  const supplied = request.headers["x-codex-dispatch-key"];
  if (typeof supplied !== "string") return false;
  const actual = Buffer.from(supplied, "utf8");
  const expected = Buffer.from(expectedKey, "utf8");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
