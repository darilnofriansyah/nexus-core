import * as assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo, Server } from "node:net";
import { test } from "node:test";

interface WorkerServerConfig {
  bindAddress: string;
  port: number;
  dispatchKey: string;
}

interface JobAccepter {
  enqueue(jobId: string): Promise<boolean>;
}

const { createWorkerServer } = require("./worker-server") as {
  createWorkerServer: (
    config: WorkerServerConfig,
    processor: JobAccepter,
  ) => Server;
};

const JOB_ID = "22222222-2222-4222-8222-222222222222";
const DISPATCH_KEY = "dispatch-secret-for-tests-32-bytes";

async function withWorkerServer<T>(
  processor: JobAccepter,
  callback: (url: string) => Promise<T>,
): Promise<T> {
  const server = createWorkerServer(
    { bindAddress: "127.0.0.1", port: 0, dispatchKey: DISPATCH_KEY },
    processor,
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  try {
    return await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    server.close();
    await once(server, "close");
  }
}

function dispatch(url: string, key: string | undefined, body: string) {
  return fetch(`${url}/jobs`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(key ? { "x-codex-dispatch-key": key } : {}),
    },
    body,
  });
}

test("authenticates before parsing the private dispatch body", async () => {
  let enqueueCalls = 0;
  await withWorkerServer(
    { enqueue: async () => (enqueueCalls++, true) },
    async (url) => {
      const response = await dispatch(url, undefined, "{");
      assert.equal(response.status, 401);
      assert.equal(enqueueCalls, 0);
    },
  );
});

test("accepts only a bounded UUID job payload and reports capacity", async () => {
  const enqueued: string[] = [];
  let available = true;
  await withWorkerServer(
    {
      enqueue: async (jobId) => {
        enqueued.push(jobId);
        return available;
      },
    },
    async (url) => {
      const valid = await dispatch(
        url,
        DISPATCH_KEY,
        JSON.stringify({ jobId: JOB_ID }),
      );
      assert.equal(valid.status, 202);
      assert.deepEqual(await valid.json(), { accepted: true });

      const invalid = await dispatch(
        url,
        DISPATCH_KEY,
        JSON.stringify({ jobId: "../../etc/passwd" }),
      );
      assert.equal(invalid.status, 400);

      const extra = await dispatch(
        url,
        DISPATCH_KEY,
        JSON.stringify({ jobId: JOB_ID, callbackUrl: "http://attacker" }),
      );
      assert.equal(extra.status, 400);

      const oversized = await dispatch(url, DISPATCH_KEY, "x".repeat(1025));
      assert.equal(oversized.status, 413);

      available = false;
      const full = await dispatch(
        url,
        DISPATCH_KEY,
        JSON.stringify({ jobId: "33333333-3333-4333-8333-333333333333" }),
      );
      assert.equal(full.status, 503);
      assert.deepEqual(enqueued, [
        JOB_ID,
        "33333333-3333-4333-8333-333333333333",
      ]);
    },
  );
});

test("returns 404 for non-dispatch routes", async () => {
  await withWorkerServer({ enqueue: async () => true }, async (url) => {
    const response = await fetch(`${url}/jobs/${JOB_ID}`, {
      method: "POST",
    });
    assert.equal(response.status, 404);
  });
});
