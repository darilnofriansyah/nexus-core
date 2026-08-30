import * as assert from "node:assert/strict";
import { test } from "node:test";
import { hostname } from "node:os";

import { readRenderWorkerConfig } from "./worker-config";

const workerEnvKeys = [
  "RENDER_WORKER_ID",
  "RENDER_WORKER_POLL_MS",
  "RENDER_WORKER_LEASE_SECONDS",
  "RENDER_WORKER_HEARTBEAT_SECONDS",
  "RENDER_WORKER_RECOVERY_SECONDS",
  "RENDER_WORKER_TEMP_DIR",
  "RENDER_FFMPEG_PATH",
  "RENDER_FFPROBE_PATH",
] as const;

function withWorkerEnv(
  overrides: Partial<Record<(typeof workerEnvKeys)[number], string | undefined>>,
  callback: () => void,
): void {
  const previous = Object.fromEntries(
    workerEnvKeys.map((key) => [key, process.env[key]]),
  );
  try {
    for (const key of workerEnvKeys) {
      delete process.env[key];
    }
    for (const [key, value] of Object.entries(overrides)) {
      if (value !== undefined) process.env[key] = value;
    }
    callback();
  } finally {
    for (const key of workerEnvKeys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

test("uses the documented render worker defaults", () => {
  withWorkerEnv({}, () => {
    const config = readRenderWorkerConfig();
    assert.equal(config.pollMs, 2000);
    assert.equal(config.leaseSeconds, 120);
    assert.equal(config.heartbeatSeconds, 30);
    assert.equal(config.recoverySeconds, 30);
    assert.equal(config.tempDir, "/tmp/rovelle-render-worker");
    assert.equal(config.ffmpegPath, "/usr/bin/ffmpeg");
    assert.equal(config.ffprobePath, "/usr/bin/ffprobe");
  });
});

test("falls back to the host name for the worker ID", () => {
  withWorkerEnv({}, () => {
    assert.equal(readRenderWorkerConfig().workerId, hostname());
  });
});

test("rejects invalid worker timing values and oversized IDs", () => {
  for (const [key, value] of [
    ["RENDER_WORKER_POLL_MS", "249"],
    ["RENDER_WORKER_POLL_MS", "60001"],
    ["RENDER_WORKER_LEASE_SECONDS", "59"],
    ["RENDER_WORKER_LEASE_SECONDS", "901"],
    ["RENDER_WORKER_RECOVERY_SECONDS", "9"],
    ["RENDER_WORKER_RECOVERY_SECONDS", "301"],
    ["RENDER_WORKER_HEARTBEAT_SECONDS", "0"],
    ["RENDER_WORKER_HEARTBEAT_SECONDS", "60"],
    ["RENDER_WORKER_ID", "x".repeat(121)],
  ] as const) {
    withWorkerEnv({ [key]: value }, () => {
      assert.throws(() => readRenderWorkerConfig(), /render worker/i);
    });
  }
});

test("rejects blank executable and temporary paths", () => {
  for (const key of [
    "RENDER_WORKER_TEMP_DIR",
    "RENDER_FFMPEG_PATH",
    "RENDER_FFPROBE_PATH",
  ] as const) {
    withWorkerEnv({ [key]: "   " }, () => {
      assert.throws(() => readRenderWorkerConfig(), /render worker/i);
    });
  }
});
