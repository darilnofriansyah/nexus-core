import * as assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import {
  creativeInput,
  creativeResult,
} from "../rovelle/creative/creative.fixture";
import { hashCreativeValue } from "../rovelle/creative/creative-validation";
import type {
  CreativeExecutionOutcome,
  CreativeExecutionRequest,
} from "../rovelle/creative/dto/creative.dto";

interface ExecutionServer {
  listen(port: number, host: string): void;
  close(): void;
  address(): AddressInfo | string | null;
  shutdown(): Promise<void>;
}

type Execute = (
  request: CreativeExecutionRequest,
  signal: AbortSignal,
) => Promise<CreativeExecutionOutcome>;

const { createExecutionServer } = require("./execution-server") as {
  createExecutionServer: (execute: Execute) => ExecutionServer;
};

const JOB_ID = "22222222-2222-4222-8222-222222222222";
const REQUEST: CreativeExecutionRequest = {
  jobId: JOB_ID,
  task: "STORYBOARD",
  input: creativeInput,
  inputHash: hashCreativeValue(creativeInput),
};
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

async function withExecutionServer<T>(
  execute: Execute,
  callback: (url: string, server: ExecutionServer) => Promise<T>,
): Promise<T> {
  const server = createExecutionServer(execute);
  server.listen(0, "127.0.0.1");
  await once(server as never, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Execution server has no TCP address");
  }
  try {
    return await callback(`http://127.0.0.1:${address.port}`, server);
  } finally {
    await server.shutdown();
  }
}

function executeRequest(url: string, body: unknown): Promise<Response> {
  return fetch(`${url}/execute`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("validates the immutable request and rejects replayed execution IDs", async () => {
  let calls = 0;
  await withExecutionServer(
    async (request) => {
      calls += 1;
      assert.deepEqual(request, REQUEST);
      return OUTCOME;
    },
    async (url) => {
      const first = await executeRequest(url, REQUEST);
      assert.equal(first.status, 200);
      assert.deepEqual(await first.json(), OUTCOME);

      const replay = await executeRequest(url, REQUEST);
      assert.equal(replay.status, 409);
      assert.equal(calls, 1);
    },
  );
});

test("rejects unknown tasks and hash mismatches before invoking the SDK", async () => {
  let calls = 0;
  await withExecutionServer(
    async () => {
      calls += 1;
      return OUTCOME;
    },
    async (url) => {
      const unknownTask = await executeRequest(url, {
        ...REQUEST,
        task: "IMAGE",
      });
      assert.equal(unknownTask.status, 409);

      const mismatchedHash = await executeRequest(url, {
        ...REQUEST,
        inputHash: "0".repeat(64),
      });
      assert.equal(mismatchedHash.status, 409);

      const malformedInput = await executeRequest(url, {
        ...REQUEST,
        input: [],
      });
      assert.equal(malformedInput.status, 400);
      assert.equal(calls, 0);
    },
  );
});

test("exposes only the private execute route", async () => {
  await withExecutionServer(
    async () => OUTCOME,
    async (url) => {
      assert.equal(
        (await fetch(`${url}/claim`, { method: "POST" })).status,
        404,
      );
      assert.equal(
        (await fetch(`${url}/result`, { method: "POST" })).status,
        404,
      );
    },
  );
});

test("shutdown aborts an in-flight executor request", async () => {
  let observedSignal: AbortSignal | undefined;
  await withExecutionServer(
    (_request, signal) => {
      observedSignal = signal;
      return new Promise((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        );
      });
    },
    async (url, server) => {
      const request = executeRequest(url, REQUEST).catch(() => undefined);
      for (let i = 0; i < 100 && !observedSignal; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      assert.ok(observedSignal);
      await server.shutdown();
      await request;
      assert.equal(observedSignal.aborted, true);
    },
  );
});
