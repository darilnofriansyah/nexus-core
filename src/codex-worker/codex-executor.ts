import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

import type {
  ThreadOptions as SdkThreadOptions,
  TurnOptions as SdkTurnOptions,
} from "@openai/codex-sdk";
import type {
  CreativeExecutionOutcome,
  CreativeExecutionRequest,
  CreativeInput,
} from "../rovelle/creative/dto/creative.dto";
import {
  hashCreativeValue,
  normalizeCreativeInput,
  normalizeCreativeResult,
} from "../rovelle/creative/creative-validation";
import { creativeOutputSchema } from "../rovelle/creative/dto/creative.dto";
import {
  buildStoryboardPrompt,
  STORYBOARD_INSTRUCTION_VERSION,
} from "./creative-role";
import {
  CODEX_CHILD_ENVIRONMENT_KEYS,
  type WorkerConfig,
} from "./worker-config";

export type { WorkerConfig } from "./worker-config";

interface CodexUsage {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
}

interface CodexTurn {
  finalResponse: string;
  usage: CodexUsage | null;
}

export type CodexThreadOptions = Required<
  Pick<
    SdkThreadOptions,
    | "model"
    | "sandboxMode"
    | "approvalPolicy"
    | "networkAccessEnabled"
    | "webSearchMode"
    | "workingDirectory"
    | "skipGitRepoCheck"
    | "additionalDirectories"
  >
> & {
  sandboxMode: "read-only";
  approvalPolicy: "never";
  networkAccessEnabled: false;
  webSearchMode: "disabled";
  skipGitRepoCheck: true;
  additionalDirectories: [];
};

export type CodexRunOptions = Required<
  Pick<SdkTurnOptions, "outputSchema" | "signal">
>;

export interface CodexThread {
  readonly id: string | null;
  run(prompt: string, options: CodexRunOptions): Promise<CodexTurn>;
}

export interface CodexClient {
  startThread(options: CodexThreadOptions): CodexThread;
}

export interface CodexFactoryContext {
  environment: Readonly<Record<string, string>>;
}

export type CodexFactory = (
  context: CodexFactoryContext,
) => CodexClient | Promise<CodexClient>;

type CodexConstructor = new (options: {
  env: Readonly<Record<string, string>>;
}) => CodexClient;

export interface CodexSdkModule {
  Codex: CodexConstructor;
}

export type WorkspaceRemover = (path: string) => Promise<void>;

function nativeImport(specifier: string): Promise<unknown> {
  // TypeScript's CommonJS transform rewrites import() to require(). Keep this
  // native boundary because the pinned SDK is ESM-only.
  const load = new Function("moduleName", "return import(moduleName);") as (
    moduleName: string,
  ) => Promise<unknown>;
  return load(specifier);
}

export async function loadCodexSdk(): Promise<CodexSdkModule> {
  const module = (await nativeImport("@openai/codex-sdk")) as {
    Codex?: CodexConstructor;
  };
  if (!module.Codex) throw new Error("Codex SDK export is unavailable");
  return { Codex: module.Codex };
}

const defaultCodexFactory: CodexFactory = async ({ environment }) => {
  const { Codex } = await loadCodexSdk();
  return new Codex({ env: environment });
};

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || /\babort(?:ed|ing)?\b/i.test(error.message))
  );
}

function isAuthenticationError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /auth|credential|api key|unauthori[sz]ed|\b401\b/i.test(error.message);
}

function threadIdOf(thread: CodexThread): string | null {
  return typeof thread.id === "string" &&
    thread.id.length > 0 &&
    thread.id.length <= 128
    ? thread.id
    : null;
}

function usageOf(
  usage: CodexUsage | null | undefined,
): CreativeExecutionOutcome["metadata"]["usage"] {
  if (!usage) return null;
  if (
    !Number.isSafeInteger(usage.input_tokens) ||
    usage.input_tokens < 0 ||
    !Number.isSafeInteger(usage.cached_input_tokens) ||
    usage.cached_input_tokens < 0 ||
    !Number.isSafeInteger(usage.output_tokens) ||
    usage.output_tokens < 0
  ) {
    return null;
  }
  return {
    inputTokens: usage.input_tokens,
    cachedInputTokens: usage.cached_input_tokens,
    outputTokens: usage.output_tokens,
  };
}

function metadata(
  config: WorkerConfig,
  thread: CodexThread | null,
  usage: CodexUsage | null | undefined,
): CreativeExecutionOutcome["metadata"] {
  return {
    instructionVersion: STORYBOARD_INSTRUCTION_VERSION,
    sdkVersion: config.sdkVersion,
    model: config.model,
    threadId: thread ? threadIdOf(thread) : null,
    usage: usageOf(usage),
  };
}

function failedOutcome(
  config: WorkerConfig,
  thread: CodexThread | null,
  errorCode: "AUTH_FAILED" | "INVALID_OUTPUT" | "EXECUTION_FAILED",
  usage: CodexUsage | null | undefined = null,
): CreativeExecutionOutcome {
  return {
    status: "FAILED",
    errorCode,
    metadata: metadata(config, thread, usage),
  };
}

function sanitizeChildEnvironment(
  environment: unknown,
): Record<string, string> {
  if (
    environment === null ||
    typeof environment !== "object" ||
    Array.isArray(environment)
  ) {
    return {};
  }

  const allowed = new Set<string>(CODEX_CHILD_ENVIRONMENT_KEYS);
  const safe: Record<string, string> = {};
  for (const [key, value] of Object.entries(environment)) {
    if (!allowed.has(key) || typeof value !== "string") continue;
    const normalized = value.trim();
    if (normalized) safe[key] = normalized;
  }
  return safe;
}

function validateRequest(request: CreativeExecutionRequest): CreativeInput {
  if (request.task !== "STORYBOARD") {
    throw new Error(`Unsupported creative task: ${String(request.task)}`);
  }

  const input = normalizeCreativeInput(request.input);
  if (request.inputHash !== hashCreativeValue(input)) {
    throw new Error("Creative input hash does not match the immutable input");
  }
  return input;
}

async function createWorkspace(
  config: WorkerConfig,
  removeWorkspace: WorkspaceRemover = defaultWorkspaceRemover,
): Promise<{
  path: string;
  environment: Readonly<Record<string, string>>;
}> {
  let path: string | undefined;
  try {
    await mkdir(config.workDirectory, { recursive: true, mode: 0o700 });
    path = await mkdtemp(join(config.workDirectory, "job-"));
    const home = join(path, "home");
    const codexHome = join(path, "codex-home");
    const temp = join(path, "tmp");
    await Promise.all([
      mkdir(home, { mode: 0o700 }),
      mkdir(codexHome, { mode: 0o700 }),
      mkdir(temp, { mode: 0o700 }),
    ]);

    return {
      path,
      environment: {
        ...sanitizeChildEnvironment(config.childEnvironment),
        HOME: home,
        CODEX_HOME: codexHome,
        TMPDIR: temp,
      },
    };
  } catch (error) {
    if (path) await cleanupWorkspace(path, removeWorkspace);
    throw error;
  }
}

const defaultWorkspaceRemover: WorkspaceRemover = async (path) => {
  await rm(path, { recursive: true, force: true });
};

async function cleanupWorkspace(
  path: string,
  removeWorkspace: WorkspaceRemover,
): Promise<void> {
  try {
    await removeWorkspace(path);
  } catch {
    // Cleanup is best effort and must not change the execution outcome.
  }
}

export async function executeStoryboard(
  request: CreativeExecutionRequest,
  config: WorkerConfig,
  createCodex: CodexFactory = defaultCodexFactory,
  removeWorkspace: WorkspaceRemover = defaultWorkspaceRemover,
): Promise<CreativeExecutionOutcome> {
  const input = validateRequest(request);
  if (config.isolationVerified !== true) {
    return failedOutcome(config, null, "EXECUTION_FAILED");
  }

  let workspace: Awaited<ReturnType<typeof createWorkspace>>;
  try {
    workspace = await createWorkspace(config, removeWorkspace);
  } catch {
    return failedOutcome(config, null, "EXECUTION_FAILED");
  }
  let thread: CodexThread | null = null;

  try {
    let codex: CodexClient;
    try {
      codex = await createCodex({ environment: workspace.environment });
      thread = codex.startThread({
        model: config.model,
        sandboxMode: "read-only",
        approvalPolicy: "never",
        networkAccessEnabled: false,
        webSearchMode: "disabled",
        workingDirectory: workspace.path,
        skipGitRepoCheck: true,
        additionalDirectories: [],
      });
    } catch (error) {
      if (isAbortError(error)) throw error;
      return failedOutcome(
        config,
        thread,
        isAuthenticationError(error) ? "AUTH_FAILED" : "EXECUTION_FAILED",
      );
    }

    let turn: CodexTurn;
    try {
      turn = await thread.run(buildStoryboardPrompt(input), {
        outputSchema: creativeOutputSchema,
        signal: AbortSignal.timeout(config.executionTimeoutMs),
      });
    } catch (error) {
      if (isAbortError(error)) throw error;
      return failedOutcome(
        config,
        thread,
        isAuthenticationError(error) ? "AUTH_FAILED" : "EXECUTION_FAILED",
      );
    }

    try {
      const rawResult: unknown = JSON.parse(turn.finalResponse);
      const result = normalizeCreativeResult(rawResult, input);
      return {
        status: "COMPLETED",
        result,
        metadata: metadata(config, thread, turn.usage),
      };
    } catch {
      return failedOutcome(config, thread, "INVALID_OUTPUT", turn.usage);
    }
  } finally {
    await cleanupWorkspace(workspace.path, removeWorkspace);
  }
}
