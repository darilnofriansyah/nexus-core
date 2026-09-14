import * as assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  creativeInput,
  creativeResult,
} from "../rovelle/creative/creative.fixture";
import { hashCreativeValue } from "../rovelle/creative/creative-validation";
import type {
  CreativeClaim,
  CreativeCompletion,
  CreativeExecutionOutcome,
} from "../rovelle/creative/dto/creative.dto";

interface SpoolRecord {
  state: string;
  claim?: Extract<CreativeClaim, { claimed: true }>;
  completionEnvelope?: {
    jobId: string;
    completion: CreativeCompletion;
  };
  deliveryAttempts: number;
}

interface CompletionStoreApi {
  initialize(): Promise<void>;
  createAccepted(jobId: string, now?: Date): Promise<boolean>;
  markClaiming(jobId: string, now?: Date): Promise<void>;
  markStarted(
    jobId: string,
    claim: Extract<CreativeClaim, { claimed: true }>,
    now?: Date,
  ): Promise<void>;
  markCompleted(
    jobId: string,
    completion: CreativeCompletion,
    now?: Date,
  ): Promise<void>;
  markAcknowledged(jobId: string, now?: Date): Promise<void>;
  get(jobId: string): Promise<SpoolRecord | null>;
  list(): Promise<SpoolRecord[]>;
  cleanupAcknowledged(now?: Date): Promise<number>;
}

interface ProcessorConfig {
  n8nBaseUrl: string;
  executorBaseUrl: string;
  callbackKey: string;
  requestTimeoutMs?: number;
  executionTimeoutMs?: number;
}

interface JobProcessorApi {
  enqueue(jobId: string): Promise<boolean>;
  processJob(jobId: string): Promise<void>;
  start(): Promise<void>;
  shutdown(): Promise<void>;
}

const { CompletionStore } = require("./completion-store") as {
  CompletionStore: new (
    directory: string,
    maxBytes?: number,
  ) => CompletionStoreApi;
};
const { createJobProcessor } = require("./job-processor") as {
  createJobProcessor: (options: {
    config: ProcessorConfig;
    store: CompletionStoreApi;
    fetchImpl?: typeof fetch;
    sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
    now?: () => Date;
    onError?: (event: string) => void;
  }) => JobProcessorApi;
};

const JOB_ID = "22222222-2222-4222-8222-222222222222";
const JOB_ID_2 = "33333333-3333-4333-8333-333333333333";
const JOB_ID_3 = "44444444-4444-4444-8444-444444444444";
const NOW = new Date("2026-09-12T00:00:00.000Z");
const CALLBACK_KEY = "callback-secret-for-tests-32-bytes";
const CLAIM_FOR = (
  jobId: string,
): Extract<CreativeClaim, { claimed: true }> => ({
  claimed: true,
  jobId,
  task: "STORYBOARD",
  attemptToken: "A".repeat(43),
  inputHash: hashCreativeValue(creativeInput),
  leaseExpiresAt: "2026-09-12T00:10:00.000Z",
  input: creativeInput,
});
const OUTCOME: CreativeExecutionOutcome = {
  status: "COMPLETED",
  result: creativeResult,
  metadata: {
    instructionVersion: "storyboard-v1",
    sdkVersion: "0.154.0",
    model: "gpt-storyboard-test",
    threadId: "thread-1",
    usage: { inputTokens: 11, cachedInputTokens: 2, outputTokens: 13 },
  },
};

async function withDirectory<T>(
  callback: (directory: string) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "codex-processor-test-"));
  try {
    return await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function readRequest(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function listen(server: Server): Promise<string> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Test server has no TCP address");
  }
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
  server.close();
  await once(server, "close");
}

function config(n8nBaseUrl: string, executorBaseUrl: string): ProcessorConfig {
  return {
    n8nBaseUrl,
    executorBaseUrl,
    callbackKey: CALLBACK_KEY,
    requestTimeoutMs: 1000,
    executionTimeoutMs: 1000,
  };
}

function claimEnvelope(jobId: string): string {
  return JSON.stringify({ ok: true, data: CLAIM_FOR(jobId) });
}

function coreAck(): string {
  return JSON.stringify({
    ok: true,
    data: { chatId: "chat-1", reply: { text: "saved" } },
  });
}

test("quarantines callback redirects without following or retrying them", async () => {
  await withDirectory(async (directory) => {
    const store = new CompletionStore(directory);
    let redirectedCalls = 0;
    const redirectServer = createServer((_request, response) => {
      redirectedCalls += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(coreAck());
    });
    const redirectUrl = await listen(redirectServer);

    let resultCalls = 0;
    const n8nServer = createServer(async (request, response) => {
      const body = await readRequest(request);
      if (request.url === "/webhook/rovelle-codex-claim") {
        const parsed = JSON.parse(body) as { jobId: string };
        response.writeHead(200, { "content-type": "application/json" });
        response.end(claimEnvelope(parsed.jobId));
        return;
      }
      if (request.url === "/webhook/rovelle-codex-result") {
        resultCalls += 1;
        response.writeHead(302, { location: `${redirectUrl}/untrusted` });
        response.end();
        return;
      }
      response.writeHead(404);
      response.end();
    });
    const executorServer = createServer(async (request, response) => {
      await readRequest(request);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(OUTCOME));
    });
    const [n8nUrl, executorUrl] = await Promise.all([
      listen(n8nServer),
      listen(executorServer),
    ]);
    const waits: number[] = [];
    let processor: JobProcessorApi;
    processor = createJobProcessor({
      config: config(n8nUrl, executorUrl),
      store,
      now: () => NOW,
      sleep: async (milliseconds) => {
        waits.push(milliseconds);
        await processor.shutdown();
      },
    });

    try {
      await processor.processJob(JOB_ID);
      assert.equal((await store.get(JOB_ID))?.state, "quarantined");
      assert.equal(resultCalls, 1);
      assert.equal(redirectedCalls, 0);
      assert.deepEqual(waits, []);
    } finally {
      await processor.shutdown();
      await Promise.all([
        close(n8nServer),
        close(executorServer),
        close(redirectServer),
      ]);
    }
  });
});

test("restarts delivery with the same saved envelope after Core commits but its ack is lost", async () => {
  await withDirectory(async (directory) => {
    const store = new CompletionStore(directory);
    const resultBodies: Array<{
      jobId: string;
      completion: CreativeCompletion;
    }> = [];
    const executorBodies: unknown[] = [];
    const executorHeaders: Array<
      Record<string, string | string[] | undefined>
    > = [];
    let executorCalls = 0;
    let resolveFirstResult!: () => void;
    let resolveSecondAck!: () => void;
    let restarted: JobProcessorApi | undefined;
    const firstResult = new Promise<void>((resolve) => {
      resolveFirstResult = resolve;
    });
    const secondAck = new Promise<void>((resolve) => {
      resolveSecondAck = resolve;
    });

    const n8nServer = createServer(async (request, response) => {
      const body = await readRequest(request);
      if (request.url === "/webhook/rovelle-codex-claim") {
        assert.equal(request.method, "POST");
        assert.equal(request.headers["x-codex-callback-key"], CALLBACK_KEY);
        const parsed = JSON.parse(body) as { jobId: string };
        response.writeHead(200, { "content-type": "application/json" });
        response.end(claimEnvelope(parsed.jobId));
        return;
      }
      if (request.url === "/webhook/rovelle-codex-result") {
        const envelope = JSON.parse(body) as (typeof resultBodies)[number];
        resultBodies.push(envelope);
        if (resultBodies.length === 1) {
          resolveFirstResult();
          response.destroy();
          return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(coreAck());
        resolveSecondAck();
        return;
      }
      response.writeHead(404);
      response.end();
    });

    const executorServer = createServer(async (request, response) => {
      executorCalls += 1;
      executorBodies.push(JSON.parse(await readRequest(request)) as unknown);
      executorHeaders.push(request.headers);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(OUTCOME));
    });

    const [n8nUrl, executorUrl] = await Promise.all([
      listen(n8nServer),
      listen(executorServer),
    ]);
    const attempts: number[] = [];
    let firstProcessor: JobProcessorApi;
    firstProcessor = createJobProcessor({
      config: config(n8nUrl, executorUrl),
      store,
      now: () => NOW,
      sleep: async (milliseconds) => {
        attempts.push(milliseconds);
        await firstProcessor.shutdown();
      },
    });

    try {
      await firstProcessor.processJob(JOB_ID);
      await firstResult;
      const stored = await store.get(JOB_ID);
      assert.equal(stored?.state, "completed");
      assert.deepEqual(attempts, [1000]);
      assert.equal(executorCalls, 1);
      assert.equal(resultBodies.length, 1);
      assert.deepEqual(Object.keys(resultBodies[0]).sort(), [
        "completion",
        "jobId",
      ]);
      assert.equal(resultBodies[0].jobId, JOB_ID);
      assert.equal(resultBodies[0].completion.attemptToken, "A".repeat(43));
      assert.equal(
        JSON.stringify(resultBodies[0]).includes(CALLBACK_KEY),
        false,
      );

      const executionRequest = executorBodies[0] as Record<string, unknown>;
      assert.deepEqual(Object.keys(executionRequest), [
        "jobId",
        "task",
        "input",
        "inputHash",
      ]);
      assert.equal(
        JSON.stringify(executionRequest).includes("attemptToken"),
        false,
      );
      assert.equal(executorHeaders[0]["x-codex-callback-key"], undefined);

      restarted = createJobProcessor({
        config: config(n8nUrl, executorUrl),
        store,
        now: () => NOW,
        sleep: async (milliseconds) => {
          attempts.push(milliseconds);
        },
      });
      await restarted.start();
      await Promise.race([
        secondAck,
        new Promise<never>((_resolve, reject) => {
          const timeout = setTimeout(
            () => reject(new Error("completion was not redelivered")),
            2000,
          );
          timeout.unref();
        }),
      ]);
      for (let i = 0; i < 100; i += 1) {
        if ((await store.get(JOB_ID))?.state === "acknowledged") break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }

      assert.equal(executorCalls, 1);
      assert.equal(resultBodies.length, 2);
      assert.deepEqual(resultBodies[1], resultBodies[0]);
      assert.equal(
        resultBodies[1].completion.attemptToken,
        resultBodies[0].completion.attemptToken,
      );
      assert.equal((await store.get(JOB_ID))?.state, "acknowledged");
    } finally {
      await firstProcessor.shutdown();
      await restarted?.shutdown();
      await Promise.all([close(n8nServer), close(executorServer)]);
    }
  });
});

test("retries malformed and invalid 200 acknowledgements without re-executing", async () => {
  await withDirectory(async (directory) => {
    const store = new CompletionStore(directory);
    const resultBodies: Array<{
      jobId: string;
      completion: CreativeCompletion;
    }> = [];
    let executorCalls = 0;
    let currentTime = NOW.getTime();
    const n8nServer = createServer(async (request, response) => {
      const body = await readRequest(request);
      if (request.url === "/webhook/rovelle-codex-claim") {
        const parsed = JSON.parse(body) as { jobId: string };
        response.writeHead(200, { "content-type": "application/json" });
        response.end(claimEnvelope(parsed.jobId));
        return;
      }
      if (request.url === "/webhook/rovelle-codex-result") {
        resultBodies.push(JSON.parse(body) as (typeof resultBodies)[number]);
        response.writeHead(200, { "content-type": "application/json" });
        if (resultBodies.length === 1) {
          response.end("{malformed");
        } else if (resultBodies.length === 2) {
          response.end(
            JSON.stringify({
              ok: true,
              data: { chatId: "chat-1", reply: {} },
            }),
          );
        } else {
          response.end(coreAck());
        }
        return;
      }
      response.writeHead(404);
      response.end();
    });
    const executorServer = createServer(async (request, response) => {
      executorCalls += 1;
      await readRequest(request);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(OUTCOME));
    });
    const [n8nUrl, executorUrl] = await Promise.all([
      listen(n8nServer),
      listen(executorServer),
    ]);
    const waits: number[] = [];
    const processor = createJobProcessor({
      config: config(n8nUrl, executorUrl),
      store,
      now: () => new Date(currentTime),
      sleep: async (milliseconds) => {
        waits.push(milliseconds);
        currentTime += milliseconds;
      },
    });

    try {
      await processor.processJob(JOB_ID);

      assert.deepEqual(waits, [1000, 5000]);
      assert.equal(resultBodies.length, 3);
      assert.deepEqual(resultBodies[1], resultBodies[0]);
      assert.deepEqual(resultBodies[2], resultBodies[0]);
      assert.equal(executorCalls, 1);
      assert.equal((await store.get(JOB_ID))?.state, "acknowledged");
    } finally {
      await processor.shutdown();
      await Promise.all([close(n8nServer), close(executorServer)]);
    }
  });
});

test("cleans expired acknowledged spool entries during new admissions", async () => {
  await withDirectory(async (directory) => {
    const seedStore = new CompletionStore(directory);
    await seedStore.initialize();
    await seedStore.createAccepted(JOB_ID, NOW);
    await seedStore.markClaiming(JOB_ID, NOW);
    await seedStore.markStarted(JOB_ID, CLAIM_FOR(JOB_ID), NOW);
    await seedStore.markCompleted(
      JOB_ID,
      {
        ...OUTCOME,
        attemptToken: CLAIM_FOR(JOB_ID).attemptToken,
        inputHash: CLAIM_FOR(JOB_ID).inputHash,
      },
      NOW,
    );
    await seedStore.markAcknowledged(JOB_ID, NOW);
    const acknowledgedBytes = (await stat(join(directory, `${JOB_ID}.json`)))
      .size;
    const admissionTime = new Date(NOW.getTime() + 24 * 60 * 60 * 1000 + 1);
    const acceptedBytes = Buffer.byteLength(
      JSON.stringify({
        version: 1,
        jobId: JOB_ID_2,
        state: "accepted",
        createdAt: admissionTime.toISOString(),
        updatedAt: admissionTime.toISOString(),
        deliveryAttempts: 0,
        lastDeliveryAttemptAt: null,
        acknowledgedAt: null,
        quarantinedStatus: null,
      }),
    );
    const store = new CompletionStore(
      directory,
      acknowledgedBytes + acceptedBytes - 1,
    );
    let currentTime = new Date(NOW.getTime() + 23 * 60 * 60 * 1000);
    const processor = createJobProcessor({
      config: config("http://n8n.test", "http://executor.test"),
      store,
      fetchImpl: async () =>
        new Response(JSON.stringify({ ok: true, data: { claimed: false } }), {
          status: 200,
        }),
      now: () => currentTime,
    });

    try {
      await processor.start();
      assert.equal((await store.get(JOB_ID))?.state, "acknowledged");

      currentTime = admissionTime;
      assert.equal(await processor.enqueue(JOB_ID_2), true);
      assert.equal(await store.get(JOB_ID), null);
    } finally {
      await processor.shutdown();
    }
  });
});

test("does not repeat claim or execution after the executor response is lost", async () => {
  await withDirectory(async (directory) => {
    const store = new CompletionStore(directory);
    let claimCalls = 0;
    let executeCalls = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith("/webhook/rovelle-codex-claim")) {
        claimCalls += 1;
        const parsed = JSON.parse(String(init?.body)) as { jobId: string };
        return new Response(claimEnvelope(parsed.jobId), { status: 200 });
      }
      if (url.endsWith("/execute")) {
        executeCalls += 1;
        throw new TypeError("simulated connection loss");
      }
      throw new Error("unexpected URL");
    };
    const processor = createJobProcessor({
      config: config("http://n8n.test", "http://executor.test"),
      store,
      fetchImpl,
      now: () => NOW,
    });

    await processor.processJob(JOB_ID);
    assert.equal((await store.get(JOB_ID))?.state, "started");
    assert.equal(claimCalls, 1);
    assert.equal(executeCalls, 1);

    const restarted = createJobProcessor({
      config: config("http://n8n.test", "http://executor.test"),
      store,
      fetchImpl,
      now: () => NOW,
    });
    await restarted.start();
    assert.equal(await restarted.enqueue(JOB_ID), true);
    assert.equal(claimCalls, 1);
    assert.equal(executeCalls, 1);
    await processor.shutdown();
    await restarted.shutdown();
  });
});

test("does not resume SDK work when completion persistence fails after execution", async () => {
  await withDirectory(async (directory) => {
    const store = new CompletionStore(directory);
    await store.initialize();
    const failingStore = new Proxy(store, {
      get(target, property) {
        if (property === "markCompleted") {
          return async () => {
            throw new Error("simulated spool failure");
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as CompletionStoreApi;
    let executeCalls = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith("/webhook/rovelle-codex-claim")) {
        const parsed = JSON.parse(String(init?.body)) as { jobId: string };
        return new Response(claimEnvelope(parsed.jobId), { status: 200 });
      }
      if (url.endsWith("/execute")) {
        executeCalls += 1;
        return new Response(JSON.stringify(OUTCOME), { status: 200 });
      }
      throw new Error("unexpected URL");
    };
    const processor = createJobProcessor({
      config: config("http://n8n.test", "http://executor.test"),
      store: failingStore,
      fetchImpl,
      now: () => NOW,
    });

    await processor.processJob(JOB_ID);
    assert.equal((await store.get(JOB_ID))?.state, "started");
    assert.equal(executeCalls, 1);

    const restarted = createJobProcessor({
      config: config("http://n8n.test", "http://executor.test"),
      store,
      fetchImpl,
      now: () => NOW,
    });
    await restarted.start();
    assert.equal(executeCalls, 1);
    assert.equal((await store.get(JOB_ID))?.state, "started");
    await processor.shutdown();
    await restarted.shutdown();
  });
});

test("limits accepted work to one running job and one pending job", async () => {
  await withDirectory(async (directory) => {
    const store = new CompletionStore(directory);
    let releaseFirstClaim!: () => void;
    let resolveFirstClaim!: () => void;
    let resolveSecondClaim!: () => void;
    const firstClaimGate = new Promise<void>((resolve) => {
      releaseFirstClaim = resolve;
    });
    const firstClaimStarted = new Promise<void>((resolve) => {
      resolveFirstClaim = resolve;
    });
    const secondClaimStarted = new Promise<void>((resolve) => {
      resolveSecondClaim = resolve;
    });
    let claimCalls = 0;
    const fetchImpl: typeof fetch = async (input) => {
      if (!String(input).endsWith("/webhook/rovelle-codex-claim")) {
        throw new Error("unexpected URL");
      }
      claimCalls += 1;
      if (claimCalls === 1) {
        resolveFirstClaim();
        await firstClaimGate;
      } else if (claimCalls === 2) {
        resolveSecondClaim();
      }
      return new Response(
        JSON.stringify({ ok: true, data: { claimed: false } }),
        {
          status: 200,
        },
      );
    };
    const processor = createJobProcessor({
      config: config("http://n8n.test", "http://executor.test"),
      store,
      fetchImpl,
      now: () => NOW,
    });

    assert.equal(await processor.enqueue(JOB_ID), true);
    await firstClaimStarted;
    assert.equal(await processor.enqueue(JOB_ID), true);
    assert.equal(await processor.enqueue(JOB_ID_2), true);
    assert.equal(await processor.enqueue(JOB_ID_3), false);
    releaseFirstClaim();
    await secondClaimStarted;
    await processor.shutdown();
    assert.equal(claimCalls, 2);
  });
});
