import * as assert from "node:assert/strict";
import { test } from "node:test";
import { ServiceUnavailableException } from "@nestjs/common";
import type { CoreApiEnv } from "../../../../config/env";
import {
  RunwareSubmitClient,
  RunwareSubmissionError,
  type RunwareVideoTask,
} from "./runware-submit.client";

const TASK_ID = "123e4567-e89b-42d3-a456-426614174000";
const API_KEY = "runware-test-secret";

type FetchStub = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

function env(overrides: Partial<CoreApiEnv> = {}): CoreApiEnv {
  return {
    nodeEnv: "test",
    port: 3001,
    prismaDatabasePoolMax: 5,
    prismaDatabaseConnectionTimeoutMs: 5000,
    openAiTimeoutMs: 20000,
    r2PresignTtlSeconds: 900,
    runwareApiKey: API_KEY,
    runwareApiBaseUrl: "https://runware.test/v1",
    runwareVideoModel: "bytedance:seedance@2.5",
    runwareSubmitTimeoutMs: 1000,
    rovelleCreativeEnabled: false,
    rovelleCreativeBodyLimitBytes: 512 * 1024,
    ...overrides,
  };
}

function task(): RunwareVideoTask {
  return {
    taskType: "videoInference",
    taskUUID: TASK_ID,
    model: "bytedance:seedance@2.5",
    positivePrompt: "Make Koko walk.",
    width: 480,
    height: 854,
    duration: 8,
    inputs: { referenceImages: ["https://assets.test/reference.png"] },
    settings: { audio: false },
    deliveryMethod: "async",
    numberResults: 1,
    outputType: "URL",
    outputFormat: "MP4",
    includeCost: true,
    uploadEndpoint: "https://assets.test/upload",
  };
}

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function client(fetchImpl: FetchStub, overrides: Partial<CoreApiEnv> = {}) {
  return new RunwareSubmitClient(env(overrides), fetchImpl);
}

test("rejects submission when the Runware API key is missing", async () => {
  const fetchImpl: FetchStub = async () => response({});

  await assert.rejects(
    () => client(fetchImpl, { runwareApiKey: undefined }).submit(task()),
    (error: unknown) => error instanceof ServiceUnavailableException,
  );
});

test("posts exactly one task to the configured URL with bearer authorization", async () => {
  let call: { input: RequestInfo | URL; init?: RequestInit } | undefined;
  const fetchImpl: FetchStub = async (input, init) => {
    call = { input, init };
    return response({ data: [{ taskUUID: TASK_ID }] });
  };

  const result = await client(fetchImpl).submit(task());

  assert.equal(call?.input, "https://runware.test/v1");
  assert.equal(call?.init?.method, "POST");
  assert.deepEqual(call?.init?.headers, {
    authorization: `Bearer ${API_KEY}`,
    "content-type": "application/json",
  });
  assert.deepEqual(JSON.parse(String(call?.init?.body)), [task()]);
  assert.equal(result.providerTaskId, TASK_ID);
});

test("accepts a matching task UUID in a successful response", async () => {
  const fetchImpl: FetchStub = async () =>
    response({ data: [{ taskUUID: TASK_ID }] });

  assert.deepEqual(await client(fetchImpl).submit(task()), {
    providerTaskId: TASK_ID,
  });
});

test("normalizes a matching provider error", async () => {
  const fetchImpl: FetchStub = async () =>
    response({
      errors: [
        {
          taskUUID: TASK_ID,
          code: "RATE_LIMIT_EXCEEDED",
          message: "try again later",
        },
      ],
    });

  await assert.rejects(
    () => client(fetchImpl).submit(task()),
    (error: unknown) => {
      if (!(error instanceof RunwareSubmissionError)) return false;
      assert.equal(error.code, "RATE_LIMIT");
      assert.equal(error.retryable, true);
      assert.equal(error.message, "try again later");
      return true;
    },
  );
});

test("normalizes non-2xx responses", async () => {
  const fetchImpl: FetchStub = async () =>
    response(
      { errors: [{ code: "INVALID_INPUT", message: "invalid task" }] },
      422,
    );

  await assert.rejects(
    () => client(fetchImpl).submit(task()),
    (error: unknown) => {
      if (!(error instanceof RunwareSubmissionError)) return false;
      assert.equal(error.code, "VALIDATION");
      assert.equal(error.retryable, false);
      return true;
    },
  );
});

test("normalizes malformed JSON", async () => {
  const fetchImpl: FetchStub = async () =>
    ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error("bad json");
      },
    }) as unknown as Response;

  await assert.rejects(
    () => client(fetchImpl).submit(task()),
    (error: unknown) => {
      if (!(error instanceof RunwareSubmissionError)) return false;
      assert.equal(error.code, "MALFORMED_RESPONSE");
      return true;
    },
  );
});

test("rejects a successful response without the matching task UUID", async () => {
  const fetchImpl: FetchStub = async () =>
    response({ data: [{ taskUUID: "different-task" }] });

  await assert.rejects(
    () => client(fetchImpl).submit(task()),
    (error: unknown) => {
      if (!(error instanceof RunwareSubmissionError)) return false;
      assert.equal(error.code, "MALFORMED_RESPONSE");
      return true;
    },
  );
});

test("aborts timed out requests and normalizes the timeout", async () => {
  const fetchImpl: FetchStub = async (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      });
    });

  await assert.rejects(
    () => client(fetchImpl, { runwareSubmitTimeoutMs: 1 }).submit(task()),
    (error: unknown) => {
      if (!(error instanceof RunwareSubmissionError)) return false;
      assert.equal(error.code, "TIMEOUT");
      assert.equal(error.retryable, true);
      return true;
    },
  );
});

test("aborts when headers arrive but the response body hangs", async () => {
  const fetchImpl: FetchStub = async (_input, init) =>
    ({
      ok: true,
      status: 200,
      json: () =>
        new Promise<unknown>((_resolve, reject) => {
          const fallback = setTimeout(
            () => reject(new Error("body remained pending")),
            50,
          );
          init?.signal?.addEventListener("abort", () => {
            clearTimeout(fallback);
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          });
        }),
    }) as unknown as Response;

  await assert.rejects(
    () => client(fetchImpl, { runwareSubmitTimeoutMs: 1 }).submit(task()),
    (error: unknown) => {
      if (!(error instanceof RunwareSubmissionError)) return false;
      assert.equal(error.code, "TIMEOUT");
      assert.equal(error.retryable, true);
      return true;
    },
  );
});

test("does not expose API keys or presigned URLs in normalized errors", async () => {
  const fetchImpl: FetchStub = async () =>
    response(
      {
        errors: [
          {
            taskUUID: TASK_ID,
            code: "PROVIDER_FAILURE",
            message: `secret=${API_KEY} upload=https://assets.test/upload?X-Amz-Signature=secret`,
          },
        ],
      },
      500,
    );

  await assert.rejects(
    () => client(fetchImpl).submit(task()),
    (error: unknown) => {
      if (!(error instanceof RunwareSubmissionError)) return false;
      assert.equal(error.message.includes(API_KEY), false);
      assert.equal(error.message.includes("https://"), false);
      return true;
    },
  );
});
