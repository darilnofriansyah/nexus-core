import { setTimeout as sleepTimer } from "node:timers/promises";

import {
  hashCreativeValue,
  normalizeCreativeCompletion,
  normalizeCreativeInput,
} from "../rovelle/creative/creative-validation";
import type {
  CreativeClaim,
  CreativeCompletion,
  CreativeExecutionOutcome,
  CreativeExecutionRequest,
  CreativeInput,
} from "../rovelle/creative/dto/creative.dto";
import {
  CompletionStore,
  type SpoolRecord,
  validateJobId,
} from "./completion-store";
import {
  CODEX_EXECUTION_TIMEOUT_MS,
  CODEX_TRANSPORT_TIMEOUT_MS,
} from "./worker-config";

const DELIVERY_BACKOFF_MS = [1000, 5000, 30_000, 60_000] as const;
const MAX_ACTIVE_JOBS = 2;
const RESPONSE_LIMIT_BYTES = 600 * 1024;
const CLAIM_PATH = "/webhook/rovelle-codex-claim";
const RESULT_PATH = "/webhook/rovelle-codex-result";
const EXECUTION_PATH = "/execute";

type ClaimResult =
  | { claimed: false }
  | { claimed: true; claim: Extract<CreativeClaim, { claimed: true }> };

export interface JobProcessorConfig {
  n8nBaseUrl: string;
  executorBaseUrl: string;
  callbackKey: string;
  requestTimeoutMs?: number;
  executionTimeoutMs?: number;
}

export interface JobProcessorOptions {
  config: JobProcessorConfig;
  store: CompletionStore;
  fetchImpl?: typeof fetch;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  now?: () => Date;
  onError?: (event: string) => void;
}

export interface JobProcessor {
  enqueue(jobId: string): Promise<boolean>;
  processJob(jobId: string): Promise<void>;
  start(): Promise<void>;
  shutdown(): Promise<void>;
}

export function createJobProcessor(options: JobProcessorOptions): JobProcessor {
  const fetcher = options.fetchImpl ?? fetch;
  const clock = options.now ?? (() => new Date());
  const wait = options.sleep ?? sleep;
  const onError = options.onError ?? (() => undefined);
  const requestTimeoutMs =
    options.config.requestTimeoutMs ?? CODEX_TRANSPORT_TIMEOUT_MS;
  const executionTimeoutMs =
    options.config.executionTimeoutMs ?? CODEX_EXECUTION_TIMEOUT_MS;
  const stopped = new AbortController();
  const activeIds = new Set<string>();
  const queue: string[] = [];
  const queuedIds = new Set<string>();
  const deliveringIds = new Set<string>();
  const backgroundTasks = new Set<Promise<void>>();
  let initialized = false;
  let stopping = false;
  let pump: Promise<void> | undefined;
  let enqueueTail: Promise<void> = Promise.resolve();

  async function start(): Promise<void> {
    if (initialized) return;
    await options.store.initialize();
    await options.store.cleanupAcknowledged(clock());
    const records = await options.store.list();
    initialized = true;

    for (const record of records) {
      if (record.state === "accepted") {
        activeIds.add(record.jobId);
        queueJob(record.jobId);
      } else if (record.state === "claiming" || record.state === "started") {
        activeIds.add(record.jobId);
      } else if (record.state === "completed") {
        launchDelivery(record.jobId);
      }
    }
    runQueue();
  }

  async function enqueue(jobId: string): Promise<boolean> {
    const id = validateJobId(jobId);
    await start();
    if (stopping) return false;

    return withEnqueueLock(async () => {
      try {
        await options.store.cleanupAcknowledged(clock());
      } catch {
        onError("spool_cleanup_failed");
        return false;
      }
      const existing = await options.store.get(id);
      if (existing) return true;
      if (activeIds.size >= MAX_ACTIVE_JOBS) return false;

      try {
        const created = await options.store.createAccepted(id, clock());
        if (!created) return true;
      } catch {
        onError("spool_unavailable");
        return false;
      }

      activeIds.add(id);
      queueJob(id);
      runQueue();
      return true;
    });
  }

  async function processJob(jobId: string): Promise<void> {
    const id = validateJobId(jobId);
    await options.store.initialize();
    let record = await options.store.get(id);
    if (!record) {
      try {
        await options.store.createAccepted(id, clock());
      } catch {
        onError("spool_unavailable");
        return;
      }
      record = await options.store.get(id);
    }
    if (!record) return;
    if (record.state === "completed") {
      await deliverUntilFinal(id);
      return;
    }
    if (record.state !== "accepted" || stopping) return;

    try {
      await options.store.markClaiming(id, clock());
    } catch {
      onError("claim_marker_failed");
      return;
    }

    let claimResult: ClaimResult;
    try {
      claimResult = await claimJob(id);
    } catch {
      onError("claim_request_failed");
      return;
    }
    if (!claimResult.claimed) {
      await options.store.markNotClaimed(id, clock()).catch(() => {
        onError("claim_marker_failed");
      });
      return;
    }
    const claim = claimResult.claim;

    try {
      await options.store.markStarted(id, claim, clock());
    } catch {
      onError("claim_persistence_failed");
      return;
    }

    const executionRequest: CreativeExecutionRequest = {
      jobId: id,
      task: "STORYBOARD",
      input: claim.input,
      inputHash: claim.inputHash,
    };
    let outcome: CreativeExecutionOutcome;
    try {
      outcome = await executeOnce(executionRequest);
    } catch {
      onError("execution_outcome_unknown");
      return;
    }

    let completion: CreativeCompletion;
    try {
      completion = normalizeCreativeCompletion(
        {
          ...outcome,
          attemptToken: claim.attemptToken,
          inputHash: claim.inputHash,
        },
        claim.input,
      );
    } catch {
      onError("execution_output_invalid");
      return;
    }
    try {
      await options.store.markCompleted(id, completion, clock());
    } catch {
      onError("completion_persistence_failed");
      return;
    }
    await deliverUntilFinal(id);
  }

  async function claimJob(jobId: string): Promise<ClaimResult> {
    const response = await fetcher(
      new URL(CLAIM_PATH, options.config.n8nBaseUrl),
      {
        method: "POST",
        redirect: "error",
        headers: {
          "content-type": "application/json",
          "x-codex-callback-key": options.config.callbackKey,
        },
        body: JSON.stringify({ jobId }),
        signal: AbortSignal.any([
          stopped.signal,
          AbortSignal.timeout(requestTimeoutMs),
        ]),
      },
    );
    if (response.status !== 200) {
      throw new Error("Core claim response is unavailable");
    }
    const envelope = await responseJson(response, RESPONSE_LIMIT_BYTES);
    if (
      !isRecord(envelope) ||
      envelope.ok !== true ||
      !isRecord(envelope.data)
    ) {
      throw new Error("Core claim response is invalid");
    }
    if (
      envelope.data.claimed === false &&
      hasExactKeys(envelope.data, ["claimed"])
    ) {
      return { claimed: false };
    }
    return { claimed: true, claim: normalizeClaim(jobId, envelope.data) };
  }

  async function executeOnce(
    request: CreativeExecutionRequest,
  ): Promise<CreativeExecutionOutcome> {
    const response = await fetcher(
      new URL(EXECUTION_PATH, options.config.executorBaseUrl),
      {
        method: "POST",
        redirect: "error",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
        signal: AbortSignal.any([
          stopped.signal,
          AbortSignal.timeout(executionTimeoutMs + 10_000),
        ]),
      },
    );
    if (response.status !== 200) {
      throw new Error("Codex executor response is unavailable");
    }
    return normalizeOutcome(
      await responseJson(response, RESPONSE_LIMIT_BYTES),
      request.input,
    );
  }

  async function deliverUntilFinal(jobId: string): Promise<void> {
    const id = validateJobId(jobId);
    while (!stopping && !stopped.signal.aborted) {
      const record = await options.store.get(id);
      if (record?.state !== "completed" || !record.completionEnvelope) return;

      const delay = nextDeliveryDelay(record, clock());
      if (delay > 0) await wait(delay, stopped.signal);
      if (stopping || stopped.signal.aborted) return;

      let attempted: SpoolRecord;
      try {
        attempted = await options.store.markDeliveryAttempt(id, clock());
      } catch {
        onError("delivery_marker_failed");
        return;
      }

      let response: Response;
      try {
        response = await fetcher(
          new URL(RESULT_PATH, options.config.n8nBaseUrl),
          {
            method: "POST",
            redirect: "manual",
            headers: {
              "content-type": "application/json",
              "x-codex-callback-key": options.config.callbackKey,
            },
            body: JSON.stringify(attempted.completionEnvelope),
            signal: AbortSignal.any([
              stopped.signal,
              AbortSignal.timeout(requestTimeoutMs),
            ]),
          },
        );
      } catch {
        if (stopped.signal.aborted) return;
        onError("result_delivery_network_error");
        await wait(backoffAfter(attempted.deliveryAttempts), stopped.signal);
        continue;
      }

      if (response.status >= 500) {
        await response.body?.cancel().catch(() => undefined);
        onError("result_delivery_server_error");
        await wait(backoffAfter(attempted.deliveryAttempts), stopped.signal);
        continue;
      }
      if (response.status >= 400) {
        await response.body?.cancel().catch(() => undefined);
        await options.store
          .quarantine(id, response.status, clock())
          .catch(() => onError("completion_quarantine_failed"));
        return;
      }

      if (response.status === 200) {
        let acknowledged = false;
        try {
          const acknowledgement = await responseJson(
            response,
            RESPONSE_LIMIT_BYTES,
          );
          acknowledged = isCoreAcknowledgement(acknowledgement);
        } catch {
          // The receiver may have committed before producing a malformed ack.
        }
        if (acknowledged) {
          await options.store.markAcknowledged(id, clock());
          return;
        }
        onError("result_delivery_ack_invalid");
        await wait(backoffAfter(attempted.deliveryAttempts), stopped.signal);
        continue;
      }
      await options.store.quarantine(id, response.status, clock()).catch(() => {
        onError("completion_quarantine_failed");
      });
      return;
    }
  }

  function launchDelivery(jobId: string): void {
    const id = validateJobId(jobId);
    if (deliveringIds.has(id)) return;
    deliveringIds.add(id);
    const task = deliverUntilFinal(id)
      .catch(() => onError("result_delivery_failed"))
      .finally(() => deliveringIds.delete(id));
    backgroundTasks.add(task);
    void task.finally(() => backgroundTasks.delete(task));
  }

  function queueJob(jobId: string): void {
    if (queuedIds.has(jobId)) return;
    queuedIds.add(jobId);
    queue.push(jobId);
  }

  function runQueue(): void {
    if (pump || stopping) return;
    pump = (async () => {
      while (queue.length > 0 && !stopping) {
        const jobId = queue.shift();
        if (!jobId) continue;
        queuedIds.delete(jobId);
        try {
          await processJob(jobId);
        } catch {
          onError("job_processing_failed");
        }
        const record = await options.store.get(jobId).catch(() => null);
        if (
          !record ||
          !["accepted", "claiming", "started"].includes(record.state)
        ) {
          activeIds.delete(jobId);
        }
      }
    })().finally(() => {
      pump = undefined;
      if (queue.length > 0 && !stopping) runQueue();
    });
  }

  async function withEnqueueLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = enqueueTail;
    let release!: () => void;
    enqueueTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async function shutdown(): Promise<void> {
    if (stopping) return;
    stopping = true;
    stopped.abort();
    const pending = [...backgroundTasks, ...(pump ? [pump] : [])];
    await Promise.allSettled(pending);
  }

  return { enqueue, processJob, start, shutdown };
}

function normalizeClaim(
  jobId: string,
  value: Record<string, unknown>,
): Extract<CreativeClaim, { claimed: true }> {
  if (
    !hasExactKeys(value, [
      "claimed",
      "jobId",
      "task",
      "attemptToken",
      "inputHash",
      "leaseExpiresAt",
      "input",
    ]) ||
    value.claimed !== true ||
    typeof value.jobId !== "string" ||
    value.jobId.toLowerCase() !== jobId ||
    value.task !== "STORYBOARD" ||
    typeof value.attemptToken !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(value.attemptToken) ||
    typeof value.inputHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.inputHash) ||
    typeof value.leaseExpiresAt !== "string" ||
    !Number.isFinite(Date.parse(value.leaseExpiresAt))
  ) {
    throw new Error("Invalid Core claim response");
  }
  const input = normalizeCreativeInput(value.input);
  if (hashCreativeValue(input) !== value.inputHash) {
    throw new Error("Core claim input hash does not match");
  }
  return {
    claimed: true,
    jobId,
    task: "STORYBOARD",
    attemptToken: value.attemptToken,
    inputHash: value.inputHash,
    leaseExpiresAt: new Date(value.leaseExpiresAt).toISOString(),
    input,
  };
}

function normalizeOutcome(
  value: unknown,
  input: CreativeInput,
): CreativeExecutionOutcome {
  if (!isRecord(value)) throw new Error("Executor outcome is invalid");
  const keys =
    value.status === "COMPLETED"
      ? ["status", "result", "metadata"]
      : ["status", "errorCode", "metadata"];
  if (!hasExactKeys(value, keys))
    throw new Error("Executor outcome is invalid");
  const normalized = normalizeCreativeCompletion(
    {
      ...value,
      attemptToken: "A".repeat(43),
      inputHash: hashCreativeValue(input),
    },
    input,
  );
  return normalized.status === "COMPLETED"
    ? {
        status: normalized.status,
        result: normalized.result,
        metadata: normalized.metadata,
      }
    : {
        status: normalized.status,
        errorCode: normalized.errorCode,
        metadata: normalized.metadata,
      };
}

function isCoreAcknowledgement(value: unknown): boolean {
  if (!isRecord(value) || value.ok !== true || !isRecord(value.data)) {
    return false;
  }
  return (
    typeof value.data.chatId === "string" &&
    isRecord(value.data.reply) &&
    typeof value.data.reply.text === "string"
  );
}

async function responseJson(
  response: Response,
  limit: number,
): Promise<unknown> {
  const contentLength = response.headers.get("content-length");
  if (contentLength && Number(contentLength) > limit) {
    await response.body?.cancel();
    throw new Error("Worker response is too large");
  }
  if (!response.body) throw new Error("Worker response is empty");

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    bytes += part.value.byteLength;
    if (bytes > limit) {
      await reader.cancel();
      throw new Error("Worker response is too large");
    }
    chunks.push(part.value);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function nextDeliveryDelay(record: SpoolRecord, now: Date): number {
  if (record.deliveryAttempts < 1 || !record.lastDeliveryAttemptAt) return 0;
  const dueAt =
    Date.parse(record.lastDeliveryAttemptAt) +
    backoffAfter(record.deliveryAttempts);
  return Math.max(0, dueAt - now.getTime());
}

function backoffAfter(attempt: number): number {
  return DELIVERY_BACKOFF_MS[
    Math.min(attempt - 1, DELIVERY_BACKOFF_MS.length - 1)
  ];
}

async function sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  try {
    await sleepTimer(milliseconds, undefined, { signal });
  } catch (error) {
    if (!(error instanceof Error) || error.name !== "AbortError") throw error;
  }
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value);
  return (
    actual.length === keys.length && actual.every((key) => keys.includes(key))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
