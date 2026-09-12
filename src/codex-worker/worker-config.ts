import { isIP } from "node:net";
import { isAbsolute } from "node:path";
import { resolve } from "node:path";

export const CODEX_SDK_VERSION = "0.154.0";
export const CODEX_EXECUTION_TIMEOUT_MS = 480_000;
export const CODEX_WORKER_SPOOL_MAX_BYTES = 64 * 1024 * 1024;
export const CODEX_TRANSPORT_TIMEOUT_MS = 10_000;
export const CODEX_EXECUTOR_PORT = 8081;
// Release gate: Task 8 must replace this only after container/network isolation
// or equivalent supported tool disabling has been independently verified.
export const CODEX_WORKER_ISOLATION_VERIFIED = false;
const DEFAULT_WORK_DIRECTORY = "/tmp/rovelle-codex-worker";
const DEFAULT_SPOOL_DIRECTORY = "/var/lib/codex-worker";
const MIN_TRANSPORT_KEY_LENGTH = 32;

export const CODEX_CHILD_ENVIRONMENT_KEYS = [
  "CODEX_API_KEY",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "ALL_PROXY",
  "PATH",
  "TMPDIR",
  "LANG",
  "NO_COLOR",
] as const;

export interface WorkerConfig {
  model: string;
  sdkVersion: typeof CODEX_SDK_VERSION;
  runtimeVersion: string;
  executionTimeoutMs: typeof CODEX_EXECUTION_TIMEOUT_MS;
  workDirectory: string;
  isolationVerified: boolean;
  childEnvironment: Readonly<Record<string, string>>;
}

export interface WorkerTransportConfig {
  bindAddress: string;
  port: number;
  spoolDirectory: string;
  spoolMaxBytes: number;
  n8nBaseUrl: string;
  executorBaseUrl: string;
  dispatchKey: string;
  callbackKey: string;
}

export interface ExecutionServerConfig {
  bindAddress: string;
  port: number;
  worker: WorkerConfig;
}

function requiredText(
  name: string,
  value: string | undefined,
  maxLength = 128,
): string {
  const normalized = value?.trim();
  if (!normalized || normalized.length > maxLength) {
    throw new Error(`Invalid Codex worker ${name}`);
  }
  return normalized;
}

function privateIpv4(name: string, value: string | undefined): string {
  const address = requiredText(name, value, 15);
  if (isIP(address) !== 4) {
    throw new Error(`Invalid Codex worker ${name}`);
  }
  const [first, second] = address.split(".").map(Number);
  const isPrivate =
    first === 10 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168);
  if (!isPrivate) throw new Error(`Invalid Codex worker ${name}`);
  return address;
}

function port(
  name: string,
  value: string | undefined,
  fallback: number,
): number {
  const raw = value ?? String(fallback);
  if (!/^[1-9][0-9]{0,4}$/.test(raw)) {
    throw new Error(`Invalid Codex worker ${name}`);
  }
  const parsed = Number(raw);
  if (parsed > 65_535) throw new Error(`Invalid Codex worker ${name}`);
  return parsed;
}

function requiredTransportKey(name: string, value: string | undefined): string {
  const normalized = requiredText(name, value, 512);
  if (normalized.length < MIN_TRANSPORT_KEY_LENGTH) {
    throw new Error(`Invalid Codex worker ${name}`);
  }
  return normalized;
}

function baseUrl(
  name: string,
  value: string | undefined,
  protocols: readonly string[],
): string {
  let url: URL;
  try {
    url = new URL(requiredText(name, value, 2048));
  } catch {
    throw new Error(`Invalid Codex worker ${name}`);
  }
  if (
    !protocols.includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error(`Invalid Codex worker ${name}`);
  }
  return url.origin;
}

function executorBaseUrl(value: string | undefined): string {
  const origin = baseUrl("executor base URL", value, ["http:"]);
  const url = new URL(origin);
  privateIpv4("executor address", url.hostname);
  if (url.port !== String(CODEX_EXECUTOR_PORT)) {
    throw new Error("Invalid Codex worker executor port");
  }
  return origin;
}

function spoolDirectory(value: string | undefined): string {
  const directory = requiredText(
    "spool directory",
    value ?? DEFAULT_SPOOL_DIRECTORY,
    4096,
  );
  const normalized = resolve(directory);
  if (
    !isAbsolute(directory) ||
    normalized !== directory ||
    normalized === "/"
  ) {
    throw new Error("Invalid Codex worker spool directory");
  }
  return normalized;
}

function spoolMaxBytes(value: string | undefined): number {
  if (value === undefined) return CODEX_WORKER_SPOOL_MAX_BYTES;
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new Error("Invalid Codex worker spool capacity");
  }
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < 1024 * 1024 ||
    parsed > 1024 ** 3
  ) {
    throw new Error("Invalid Codex worker spool capacity");
  }
  return parsed;
}

export function readWorkerConfig(
  env: NodeJS.ProcessEnv = process.env,
): WorkerConfig {
  const model = requiredText("creative model", env.CODEX_CREATIVE_MODEL);
  const workDirectory = requiredText(
    "work directory",
    env.CODEX_CREATIVE_WORK_DIR ?? DEFAULT_WORK_DIRECTORY,
    4096,
  );
  if (!isAbsolute(workDirectory)) {
    throw new Error("Invalid Codex worker work directory");
  }

  const childEnvironment: Record<string, string> = {};
  for (const key of CODEX_CHILD_ENVIRONMENT_KEYS) {
    const value = env[key]?.trim();
    if (value) childEnvironment[key] = value;
  }

  return {
    model,
    sdkVersion: CODEX_SDK_VERSION,
    runtimeVersion: process.version,
    executionTimeoutMs: CODEX_EXECUTION_TIMEOUT_MS,
    workDirectory,
    isolationVerified: CODEX_WORKER_ISOLATION_VERIFIED,
    childEnvironment,
  };
}

export function readTransportConfig(
  env: NodeJS.ProcessEnv = process.env,
): WorkerTransportConfig {
  const dispatchKey = requiredTransportKey(
    "dispatch key",
    env.CODEX_WORKER_DISPATCH_KEY,
  );
  const callbackKey = requiredTransportKey(
    "callback key",
    env.CODEX_WORKER_CALLBACK_KEY,
  );
  if (dispatchKey === callbackKey) {
    throw new Error("Codex worker dispatch and callback keys must differ");
  }

  return {
    bindAddress: privateIpv4("bind address", env.CODEX_WORKER_BIND_ADDRESS),
    port: port("port", env.CODEX_WORKER_PORT, 8080),
    spoolDirectory: spoolDirectory(env.CODEX_WORKER_SPOOL_DIR),
    spoolMaxBytes: spoolMaxBytes(env.CODEX_WORKER_SPOOL_MAX_BYTES),
    n8nBaseUrl: baseUrl("n8n base URL", env.CODEX_N8N_BASE_URL, [
      "http:",
      "https:",
    ]),
    executorBaseUrl: executorBaseUrl(env.CODEX_EXECUTOR_BASE_URL),
    dispatchKey,
    callbackKey,
  };
}

export function readExecutionServerConfig(
  env: NodeJS.ProcessEnv = process.env,
): ExecutionServerConfig {
  const executorPort = port(
    "executor port",
    env.CODEX_EXECUTOR_PORT,
    CODEX_EXECUTOR_PORT,
  );
  if (executorPort !== CODEX_EXECUTOR_PORT) {
    throw new Error("Codex executor must listen on port 8081");
  }
  return {
    bindAddress: privateIpv4(
      "executor bind address",
      env.CODEX_EXECUTOR_BIND_ADDRESS,
    ),
    port: executorPort,
    worker: readWorkerConfig(env),
  };
}
