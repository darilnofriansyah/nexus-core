import { createHash } from "node:crypto";
import { BadRequestException } from "@nestjs/common";
import type {
  CreativeCompletion,
  CreativeExecutionMetadata,
  CreativeInput,
  CreativeResult,
} from "./dto/creative.dto";

const INPUT_PAYLOAD_LIMIT = 512 * 1024;
const COMPLETION_PAYLOAD_LIMIT = 512 * 1024;
const CANON_DEFINITION_LIMIT = 64 * 1024;
// ponytail: cap recursive JSON at 128 levels; use iterative traversal before raising it.
const MAX_JSON_DEPTH = 128;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CANON_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const ATTEMPT_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const INPUT_HASH_PATTERN = /^[0-9a-f]{64}$/;

const INPUT_KEYS = [
  "schemaVersion",
  "inputRevision",
  "title",
  "targetDurationSeconds",
  "premise",
  "learningGoal",
  "tone",
  "canon",
  "previousResult",
  "feedback",
] as const;
const CANON_PIN_KEYS = ["entityId", "versionId", "code", "definition"] as const;
const RESULT_KEYS = ["synopsis", "script", "shots"] as const;
const SHOT_KEYS = [
  "sequence",
  "durationSeconds",
  "direction",
  "narration",
  "imagePrompt",
] as const;
const METADATA_KEYS = [
  "instructionVersion",
  "sdkVersion",
  "model",
  "threadId",
  "usage",
] as const;
const USAGE_KEYS = [
  "inputTokens",
  "cachedInputTokens",
  "outputTokens",
] as const;

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

function reject(message: string): never {
  throw new BadRequestException(message);
}

function requireObject(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    reject(`${field} must be an object`);
  }

  return value as Record<string, unknown>;
}

function assertExactKeys(
  value: unknown,
  keys: readonly string[],
  field: string,
): Record<string, unknown> {
  const object = requireObject(value, field);
  const allowed = new Set(keys);
  const ownKeys = Reflect.ownKeys(object);

  if (
    ownKeys.length !== keys.length ||
    ownKeys.some((key) => typeof key !== "string" || !allowed.has(key))
  ) {
    reject(`${field} contains unknown or missing fields`);
  }

  return object;
}

function requireArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) {
    reject(`${field} must be an array`);
  }

  const ownKeys = Reflect.ownKeys(value);
  for (const key of ownKeys) {
    if (key === "length") continue;
    if (
      typeof key !== "string" ||
      !/^(0|[1-9][0-9]*)$/.test(key) ||
      Number(key) >= value.length
    ) {
      reject(`${field} must be a JSON array`);
    }
  }

  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) {
      reject(`${field} must not contain holes`);
    }
  }

  return value;
}

function requireText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string") {
    reject(`${field} must be a string`);
  }

  const normalized = value.trim();
  if (!normalized) {
    reject(`${field} is required`);
  }
  if (normalized.length > maxLength) {
    reject(`${field} must be at most ${maxLength} characters`);
  }

  return normalized;
}

function requireOptionalText(
  value: unknown,
  field: string,
  maxLength: number,
): string | null {
  if (value === null) return null;
  if (typeof value !== "string") {
    reject(`${field} must be a string or null`);
  }

  const normalized = value.trim();
  if (normalized.length > maxLength) {
    reject(`${field} must be at most ${maxLength} characters`);
  }

  return normalized;
}

function requireTextAllowEmpty(
  value: unknown,
  field: string,
  maxLength: number,
): string {
  if (typeof value !== "string") {
    reject(`${field} must be a string`);
  }

  const normalized = value.trim();
  if (normalized.length > maxLength) {
    reject(`${field} must be at most ${maxLength} characters`);
  }

  return normalized;
}

function requireUuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value.trim())) {
    reject(`${field} must be a valid UUID`);
  }

  return value.trim();
}

function requireCanonCode(value: unknown, field: string): string {
  if (typeof value !== "string") {
    reject(`${field} must be a string`);
  }

  const normalized = value.trim().toUpperCase();
  if (!CANON_CODE_PATTERN.test(normalized)) {
    reject(`${field} must be a valid canon code`);
  }

  return normalized;
}

function requireSafeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    reject(`${field} must be a safe integer`);
  }

  return value;
}

function requirePositiveInteger(value: unknown, field: string): number {
  const normalized = requireSafeInteger(value, field);
  if (normalized < 1) {
    reject(`${field} must be a positive integer`);
  }

  return normalized;
}

function requireTargetDuration(value: unknown, field: string): number {
  const normalized = requireSafeInteger(value, field);
  if (normalized < 4 || normalized > 120 || normalized % 4 !== 0) {
    reject(`${field} must be a multiple of 4 seconds from 4 to 120`);
  }

  return normalized;
}

function cloneJsonValue(
  value: unknown,
  field: string,
  ancestors = new Set<object>(),
  depth = 0,
): JsonValue {
  if (depth > MAX_JSON_DEPTH) {
    reject(`${field} exceeds the maximum JSON nesting depth`);
  }

  if (value === null) return null;

  switch (typeof value) {
    case "boolean":
    case "string":
      return value;
    case "number":
      if (!Number.isFinite(value)) reject(`${field} must contain JSON values`);
      return value;
    case "object":
      break;
    default:
      reject(`${field} must contain JSON values`);
  }

  const object = value as object;
  if (ancestors.has(object)) {
    reject(`${field} must not contain cycles`);
  }

  if (Array.isArray(value)) {
    requireArray(value, field);
    ancestors.add(object);
    const cloned: JsonValue[] = [];
    for (let index = 0; index < value.length; index += 1) {
      cloned.push(
        cloneJsonValue(
          value[index],
          `${field}[${index}]`,
          ancestors,
          depth + 1,
        ),
      );
    }
    ancestors.delete(object);
    return cloned;
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    reject(`${field} must contain JSON values`);
  }

  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.some((key) => typeof key !== "string") ||
    ownKeys.length !== Object.keys(value).length
  ) {
    reject(`${field} must contain JSON values`);
  }

  ancestors.add(object);
  const cloned: Record<string, JsonValue> = {};
  for (const key of Object.keys(value)) {
    Object.defineProperty(cloned, key, {
      configurable: true,
      enumerable: true,
      value: cloneJsonValue(
        (value as Record<string, unknown>)[key],
        `${field}.${key}`,
        ancestors,
        depth + 1,
      ),
      writable: true,
    });
  }
  ancestors.delete(object);
  return cloned;
}

function normalizeDefinition(
  value: unknown,
  field: string,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    reject(`${field} must be a non-empty plain object`);
  }

  const cloned = cloneJsonValue(value, field);
  if (
    cloned === null ||
    Array.isArray(cloned) ||
    typeof cloned !== "object" ||
    Object.keys(cloned).length === 0
  ) {
    reject(`${field} must be a non-empty plain object`);
  }

  return cloned;
}

function serializedByteLength(value: unknown): number {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) reject("value must be JSON serializable");
  return Buffer.byteLength(serialized, "utf8");
}

function assertPayloadLimit(
  value: unknown,
  limit: number,
  field: string,
): void {
  if (serializedByteLength(value) > limit) {
    reject(`${field} exceeds the ${limit}-byte payload limit`);
  }
}

function normalizeShot(
  value: unknown,
  index: number,
): CreativeResult["shots"][number] {
  const shot = assertExactKeys(value, SHOT_KEYS, `shots[${index}]`);
  const sequence = requirePositiveInteger(
    shot.sequence,
    `shots[${index}].sequence`,
  );
  if (sequence !== index + 1) {
    reject(`shots[${index}].sequence must be ${index + 1}`);
  }

  if (shot.durationSeconds !== 4) {
    reject(`shots[${index}].durationSeconds must be exactly 4`);
  }

  return {
    sequence,
    durationSeconds: 4,
    direction: requireText(shot.direction, `shots[${index}].direction`, 4000),
    narration: requireTextAllowEmpty(
      shot.narration,
      `shots[${index}].narration`,
      2000,
    ),
    imagePrompt: requireText(
      shot.imagePrompt,
      `shots[${index}].imagePrompt`,
      4000,
    ),
  };
}

export function normalizeCreativeResult(
  value: unknown,
  input: CreativeInput,
): CreativeResult {
  const result = assertExactKeys(value, RESULT_KEYS, "result");
  const targetDurationSeconds = requireTargetDuration(
    input !== null && typeof input === "object"
      ? (input as { targetDurationSeconds?: unknown }).targetDurationSeconds
      : undefined,
    "input.targetDurationSeconds",
  );
  const shots = requireArray(result.shots, "shots");
  const expectedShotCount = targetDurationSeconds / 4;

  if (shots.length !== expectedShotCount) {
    reject(`shots must contain exactly ${expectedShotCount} items`);
  }

  const normalized: CreativeResult = {
    synopsis: requireText(result.synopsis, "synopsis", 2000),
    script: requireText(result.script, "script", 12000),
    shots: shots.map((shot, index) => normalizeShot(shot, index)),
  };

  assertPayloadLimit(normalized, COMPLETION_PAYLOAD_LIMIT, "result");
  return normalized;
}

export function normalizeCreativeInput(value: unknown): CreativeInput {
  const input = assertExactKeys(value, INPUT_KEYS, "input");

  if (input.schemaVersion !== 1) {
    reject("schemaVersion must be 1");
  }

  const targetDurationSeconds = requireTargetDuration(
    input.targetDurationSeconds,
    "targetDurationSeconds",
  );
  const canonValue = requireArray(input.canon, "canon");
  if (canonValue.length > 16) {
    reject("canon must contain at most 16 pins");
  }

  let definitionBytes = 0;
  const canon = canonValue.map((value, index) => {
    const pin = assertExactKeys(value, CANON_PIN_KEYS, `canon[${index}]`);
    const definition = normalizeDefinition(
      pin.definition,
      `canon[${index}].definition`,
    );
    definitionBytes += serializedByteLength(definition);
    if (definitionBytes > CANON_DEFINITION_LIMIT) {
      reject("serialized canon definitions exceed 64 KiB");
    }

    return {
      entityId: requireUuid(pin.entityId, `canon[${index}].entityId`),
      versionId: requireUuid(pin.versionId, `canon[${index}].versionId`),
      code: requireCanonCode(pin.code, `canon[${index}].code`),
      definition,
    };
  });

  const normalized: CreativeInput = {
    schemaVersion: 1,
    inputRevision: requirePositiveInteger(input.inputRevision, "inputRevision"),
    title: requireText(input.title, "title", 200),
    targetDurationSeconds,
    premise: requireText(input.premise, "premise", 2000),
    learningGoal: requireText(input.learningGoal, "learningGoal", 2000),
    tone: requireText(input.tone, "tone", 2000),
    canon,
    previousResult: null,
    feedback: requireOptionalText(input.feedback, "feedback", 2000),
  };

  if (input.previousResult !== null) {
    normalized.previousResult = normalizeCreativeResult(
      input.previousResult,
      normalized,
    );
  }

  assertPayloadLimit(normalized, INPUT_PAYLOAD_LIMIT, "input");
  return normalized;
}

function normalizeMetadata(value: unknown): CreativeExecutionMetadata {
  const metadata = assertExactKeys(value, METADATA_KEYS, "metadata");
  if (metadata.instructionVersion !== "storyboard-v1") {
    reject("metadata.instructionVersion must be storyboard-v1");
  }

  const threadId =
    metadata.threadId === null
      ? null
      : requireText(metadata.threadId, "metadata.threadId", 128);
  const usageValue = metadata.usage;
  let usage: CreativeExecutionMetadata["usage"] = null;
  if (usageValue !== null) {
    const rawUsage = assertExactKeys(usageValue, USAGE_KEYS, "metadata.usage");
    usage = {
      inputTokens: requireNonNegativeSafeInteger(
        rawUsage.inputTokens,
        "metadata.usage.inputTokens",
      ),
      cachedInputTokens: requireNonNegativeSafeInteger(
        rawUsage.cachedInputTokens,
        "metadata.usage.cachedInputTokens",
      ),
      outputTokens: requireNonNegativeSafeInteger(
        rawUsage.outputTokens,
        "metadata.usage.outputTokens",
      ),
    };
  }

  return {
    instructionVersion: "storyboard-v1",
    sdkVersion: requireText(metadata.sdkVersion, "metadata.sdkVersion", 128),
    model: requireText(metadata.model, "metadata.model", 128),
    threadId,
    usage,
  };
}

function requireNonNegativeSafeInteger(value: unknown, field: string): number {
  const normalized = requireSafeInteger(value, field);
  if (normalized < 0) reject(`${field} must be non-negative`);
  return normalized;
}

function requireAttemptToken(value: unknown): string {
  if (typeof value !== "string" || !ATTEMPT_TOKEN_PATTERN.test(value)) {
    reject("attemptToken must be a base64url-encoded 32-byte token");
  }

  const decoded = Buffer.from(value, "base64url");
  if (decoded.length !== 32 || decoded.toString("base64url") !== value) {
    reject("attemptToken must be a base64url-encoded 32-byte token");
  }

  return value;
}

function requireInputHash(value: unknown, input: CreativeInput): string {
  if (typeof value !== "string" || !INPUT_HASH_PATTERN.test(value)) {
    reject("inputHash must be a lowercase SHA-256 hash");
  }

  const normalizedInput = normalizeCreativeInput(input);
  if (value !== hashCreativeValue(normalizedInput)) {
    reject("inputHash does not match the creative input");
  }

  return value;
}

export function normalizeCreativeCompletion(
  value: unknown,
  input: CreativeInput,
): CreativeCompletion {
  const completion = requireObject(value, "completion");
  if (completion.status !== "COMPLETED" && completion.status !== "FAILED") {
    reject("status must be COMPLETED or FAILED");
  }

  const keys =
    completion.status === "COMPLETED"
      ? ["attemptToken", "inputHash", "status", "metadata", "result"]
      : ["attemptToken", "inputHash", "status", "metadata", "errorCode"];
  const normalizedBase = assertExactKeys(completion, keys, "completion");
  const attemptToken = requireAttemptToken(normalizedBase.attemptToken);
  const inputHash = requireInputHash(normalizedBase.inputHash, input);
  const metadata = normalizeMetadata(normalizedBase.metadata);

  const normalized =
    completion.status === "COMPLETED"
      ? {
          attemptToken,
          inputHash,
          status: "COMPLETED" as const,
          metadata,
          result: normalizeCreativeResult(normalizedBase.result, input),
        }
      : {
          attemptToken,
          inputHash,
          status: "FAILED" as const,
          metadata,
          errorCode: requireErrorCode(normalizedBase.errorCode),
        };

  assertPayloadLimit(normalized, COMPLETION_PAYLOAD_LIMIT, "completion");
  return normalized;
}

function requireErrorCode(
  value: unknown,
): "AUTH_FAILED" | "INVALID_OUTPUT" | "EXECUTION_FAILED" {
  if (
    value !== "AUTH_FAILED" &&
    value !== "INVALID_OUTPUT" &&
    value !== "EXECUTION_FAILED"
  ) {
    reject("errorCode must be a supported creative execution error");
  }

  return value;
}

export function hashCreativeValue(value: unknown): string {
  const canonical = sortJsonValue(value);
  return createHash("sha256")
    .update(JSON.stringify(canonical), "utf8")
    .digest("hex");
}

function sortJsonValue(value: unknown): JsonValue {
  const cloned = cloneJsonValue(value, "value");
  if (Array.isArray(cloned)) {
    return cloned.map((item) => sortJsonValue(item));
  }
  if (cloned !== null && typeof cloned === "object") {
    const sorted: Record<string, JsonValue> = {};
    for (const key of Object.keys(cloned).sort()) {
      Object.defineProperty(sorted, key, {
        configurable: true,
        enumerable: true,
        value: sortJsonValue(cloned[key]),
        writable: true,
      });
    }
    return sorted;
  }
  return cloned;
}
