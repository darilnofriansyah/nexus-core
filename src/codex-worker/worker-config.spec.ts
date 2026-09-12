import * as assert from "node:assert/strict";
import { test } from "node:test";

import {
  CODEX_EXECUTION_TIMEOUT_MS,
  CODEX_SDK_VERSION,
  readWorkerConfig,
} from "./worker-config";

const WORKER_ENV_KEYS = [
  "CODEX_CREATIVE_MODEL",
  "CODEX_CREATIVE_WORK_DIR",
  "CODEX_CREATIVE_TIMEOUT_MS",
  "CODEX_API_KEY",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "PATH",
  "HOME",
  "TMPDIR",
  "LANG",
  "NO_COLOR",
  "N8N_API_KEY",
  "CORE_API_KEY",
  "DATABASE_URL",
  "CODEX_HOME",
] as const;

function withWorkerEnv(
  overrides: Partial<
    Record<(typeof WORKER_ENV_KEYS)[number], string | undefined>
  >,
  callback: () => void,
): void {
  const previous = Object.fromEntries(
    WORKER_ENV_KEYS.map((key) => [key, process.env[key]]),
  );

  try {
    for (const key of WORKER_ENV_KEYS) delete process.env[key];
    for (const [key, value] of Object.entries(overrides)) {
      if (value !== undefined) process.env[key] = value;
    }
    callback();
  } finally {
    for (const key of WORKER_ENV_KEYS) {
      const value = previous[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("requires the configured model and returns the pinned runtime contract", () => {
  withWorkerEnv(
    {
      CODEX_CREATIVE_MODEL: "gpt-storyboard-test",
      CODEX_API_KEY: "provider-secret",
      N8N_API_KEY: "transport-secret",
      DATABASE_URL: "postgresql://should-not-leak",
    },
    () => {
      const config = readWorkerConfig();

      assert.equal(config.model, "gpt-storyboard-test");
      assert.equal(config.sdkVersion, CODEX_SDK_VERSION);
      assert.equal(config.sdkVersion, "0.154.0");
      assert.equal(config.runtimeVersion, process.version);
      assert.equal(config.executionTimeoutMs, CODEX_EXECUTION_TIMEOUT_MS);
      assert.equal(config.executionTimeoutMs, 480_000);
      assert.equal(config.isolationVerified, false);
      assert.equal(config.workDirectory, "/tmp/rovelle-codex-worker");
      assert.equal(config.childEnvironment.CODEX_API_KEY, "provider-secret");
      assert.equal(config.childEnvironment.N8N_API_KEY, undefined);
      assert.equal(config.childEnvironment.DATABASE_URL, undefined);
      assert.equal(config.childEnvironment.CODEX_HOME, undefined);
    },
  );
});

test("passes only explicitly allowed child environment keys", () => {
  withWorkerEnv(
    {
      CODEX_CREATIVE_MODEL: "gpt-storyboard-test",
      OPENAI_API_KEY: "provider-secret",
      OPENAI_BASE_URL: "https://provider.example.test",
      PATH: "/usr/bin",
      HOME: "/worker-home",
      TMPDIR: "/worker-tmp",
      LANG: "C.UTF-8",
      NO_COLOR: "1",
      N8N_API_KEY: "transport-secret",
      CORE_API_KEY: "core-secret",
    },
    () => {
      const config = readWorkerConfig();

      assert.deepEqual(config.childEnvironment, {
        OPENAI_API_KEY: "provider-secret",
        OPENAI_BASE_URL: "https://provider.example.test",
        PATH: "/usr/bin",
        TMPDIR: "/worker-tmp",
        LANG: "C.UTF-8",
        NO_COLOR: "1",
      });
    },
  );
});

test("rejects a missing or blank model and invalid work directory", () => {
  withWorkerEnv({}, () => {
    assert.throws(() => readWorkerConfig(), /creative model/i);
  });

  withWorkerEnv({ CODEX_CREATIVE_MODEL: "   " }, () => {
    assert.throws(() => readWorkerConfig(), /creative model/i);
  });

  withWorkerEnv(
    {
      CODEX_CREATIVE_MODEL: "gpt-storyboard-test",
      CODEX_CREATIVE_WORK_DIR: "relative/path",
    },
    () => {
      assert.throws(() => readWorkerConfig(), /work directory/i);
    },
  );
});

test("does not allow the fixed execution timeout to be overridden", () => {
  withWorkerEnv(
    {
      CODEX_CREATIVE_MODEL: "gpt-storyboard-test",
      CODEX_CREATIVE_TIMEOUT_MS: "1",
    },
    () => {
      assert.equal(readWorkerConfig().executionTimeoutMs, 480_000);
    },
  );
});
