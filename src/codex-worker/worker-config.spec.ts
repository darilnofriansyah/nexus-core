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
  "CODEX_WORKER_BIND_ADDRESS",
  "CODEX_WORKER_PORT",
  "CODEX_WORKER_SPOOL_DIR",
  "CODEX_WORKER_SPOOL_MAX_BYTES",
  "CODEX_N8N_BASE_URL",
  "CODEX_EXECUTOR_BASE_URL",
  "CODEX_WORKER_DISPATCH_KEY",
  "CODEX_WORKER_CALLBACK_KEY",
  "CODEX_EXECUTOR_BIND_ADDRESS",
  "CODEX_EXECUTOR_PORT",
  "CODEX_API_KEY",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "ALL_PROXY",
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

test("keeps transport credentials and spool settings separate from SDK config", () => {
  const workerConfigModule = require("./worker-config") as Record<
    string,
    unknown
  >;
  const readTransportConfig = workerConfigModule.readTransportConfig as
    | ((env?: NodeJS.ProcessEnv) => Record<string, unknown>)
    | undefined;

  assert.equal(typeof readTransportConfig, "function");
  if (!readTransportConfig) return;

  const dispatchKey = "d".repeat(32);
  const callbackKey = "c".repeat(32);
  const config = readTransportConfig({
    CODEX_WORKER_BIND_ADDRESS: "172.30.80.2",
    CODEX_WORKER_PORT: "8080",
    CODEX_WORKER_SPOOL_DIR: "/var/lib/codex-worker",
    CODEX_WORKER_SPOOL_MAX_BYTES: "67108864",
    CODEX_N8N_BASE_URL: "http://n8n:5678",
    CODEX_EXECUTOR_BASE_URL: "http://172.30.80.3:8081",
    CODEX_WORKER_DISPATCH_KEY: dispatchKey,
    CODEX_WORKER_CALLBACK_KEY: callbackKey,
    CODEX_API_KEY: "provider-secret",
    DATABASE_URL: "postgresql://database-secret",
  });

  assert.deepEqual(config, {
    bindAddress: "172.30.80.2",
    port: 8080,
    spoolDirectory: "/var/lib/codex-worker",
    spoolMaxBytes: 67_108_864,
    n8nBaseUrl: "http://n8n:5678",
    executorBaseUrl: "http://172.30.80.3:8081",
    dispatchKey,
    callbackKey,
  });
  assert.equal(JSON.stringify(config).includes("provider-secret"), false);
  assert.equal(JSON.stringify(config).includes("database-secret"), false);
});

test("rejects weak or shared transport keys and non-private listener addresses", () => {
  const workerConfigModule = require("./worker-config") as Record<
    string,
    unknown
  >;
  const readTransportConfig = workerConfigModule.readTransportConfig as
    | ((env?: NodeJS.ProcessEnv) => Record<string, unknown>)
    | undefined;
  assert.equal(typeof readTransportConfig, "function");
  if (!readTransportConfig) return;

  const valid = {
    CODEX_WORKER_BIND_ADDRESS: "172.30.80.2",
    CODEX_WORKER_PORT: "8080",
    CODEX_WORKER_SPOOL_DIR: "/var/lib/codex-worker",
    CODEX_N8N_BASE_URL: "http://n8n:5678",
    CODEX_EXECUTOR_BASE_URL: "http://172.30.80.3:8081",
    CODEX_WORKER_DISPATCH_KEY: "d".repeat(32),
    CODEX_WORKER_CALLBACK_KEY: "c".repeat(32),
  };

  assert.throws(
    () =>
      readTransportConfig({
        ...valid,
        CODEX_WORKER_CALLBACK_KEY: valid.CODEX_WORKER_DISPATCH_KEY,
      }),
    /key/i,
  );
  assert.throws(
    () => readTransportConfig({ ...valid, CODEX_WORKER_DISPATCH_KEY: "weak" }),
    /key/i,
  );
  assert.throws(
    () =>
      readTransportConfig({
        ...valid,
        CODEX_WORKER_BIND_ADDRESS: "0.0.0.0",
      }),
    /address/i,
  );
  assert.throws(
    () =>
      readTransportConfig({
        ...valid,
        CODEX_EXECUTOR_BASE_URL: "http://executor:8081/execute?url=attacker",
      }),
    /url/i,
  );
  assert.throws(
    () =>
      readTransportConfig({
        ...valid,
        CODEX_EXECUTOR_BASE_URL: "http://203.0.113.8:8081",
      }),
    /address/i,
  );
  assert.throws(
    () =>
      readTransportConfig({
        ...valid,
        CODEX_EXECUTOR_BASE_URL: "http://172.31.90.3:8082",
      }),
    /port/i,
  );
});

test("keeps verified provider proxy settings in the SDK child allowlist", () => {
  withWorkerEnv(
    {
      CODEX_CREATIVE_MODEL: "gpt-storyboard-test",
      OPENAI_API_KEY: "provider-secret",
      HTTPS_PROXY: "http://inference-proxy:3128",
      HTTP_PROXY: "http://inference-proxy:3128",
      ALL_PROXY: "http://inference-proxy:3128",
      CODEX_WORKER_CALLBACK_KEY: "transport-secret",
    },
    () => {
      assert.deepEqual(readWorkerConfig().childEnvironment, {
        OPENAI_API_KEY: "provider-secret",
        HTTPS_PROXY: "http://inference-proxy:3128",
        HTTP_PROXY: "http://inference-proxy:3128",
        ALL_PROXY: "http://inference-proxy:3128",
      });
    },
  );
});

test("keeps the private executor endpoint fixed to port 8081", () => {
  const workerConfigModule = require("./worker-config") as Record<
    string,
    unknown
  >;
  const readExecutionServerConfig =
    workerConfigModule.readExecutionServerConfig as
      | ((env?: NodeJS.ProcessEnv) => Record<string, unknown>)
      | undefined;
  assert.equal(typeof readExecutionServerConfig, "function");
  if (!readExecutionServerConfig) return;

  assert.throws(
    () =>
      readExecutionServerConfig({
        CODEX_EXECUTOR_BIND_ADDRESS: "172.31.90.3",
        CODEX_EXECUTOR_PORT: "8082",
        CODEX_CREATIVE_MODEL: "gpt-storyboard-test",
      }),
    /port/i,
  );
});
