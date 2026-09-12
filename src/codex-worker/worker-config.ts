import { isAbsolute } from "node:path";

export const CODEX_SDK_VERSION = "0.154.0";
export const CODEX_EXECUTION_TIMEOUT_MS = 480_000;
// Release gate: Task 8 must replace this only after container/network isolation
// or equivalent supported tool disabling has been independently verified.
export const CODEX_WORKER_ISOLATION_VERIFIED = false;
const DEFAULT_WORK_DIRECTORY = "/tmp/rovelle-codex-worker";

export const CODEX_CHILD_ENVIRONMENT_KEYS = [
  "CODEX_API_KEY",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
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
