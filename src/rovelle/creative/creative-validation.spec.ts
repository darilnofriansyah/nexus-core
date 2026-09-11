import * as assert from "node:assert/strict";
import { describe, test } from "node:test";
import { BadRequestException } from "@nestjs/common";
import type {
  CreativeCompletion,
  CreativeInput,
  CreativeResult,
} from "./dto/creative.dto";
import { creativeOutputSchema } from "./dto/creative.dto";
import { creativeInput, creativeResult } from "./creative.fixture";
import {
  hashCreativeValue,
  normalizeCreativeCompletion,
  normalizeCreativeInput,
  normalizeCreativeResult,
} from "./creative-validation";

const ATTEMPT_TOKEN = "A".repeat(43);
const INPUT_HASH = hashCreativeValue(creativeInput);

function assertBadRequest(action: () => unknown): void {
  assert.throws(action, BadRequestException);
}

function withResult(overrides: Partial<CreativeResult>): CreativeResult {
  return { ...creativeResult, ...overrides };
}

function withInput(overrides: Partial<CreativeInput>): CreativeInput {
  return { ...creativeInput, ...overrides };
}

function completed(overrides: Partial<CreativeCompletion> = {}) {
  return {
    attemptToken: ATTEMPT_TOKEN,
    inputHash: INPUT_HASH,
    status: "COMPLETED" as const,
    metadata: {
      instructionVersion: "storyboard-v1" as const,
      sdkVersion: "sdk-test",
      model: "model-test",
      threadId: null,
      usage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 2 },
    },
    result: creativeResult,
    ...overrides,
  };
}

test("rejects an otherwise valid storyboard with the wrong duration", () => {
  assert.throws(() =>
    normalizeCreativeResult(
      {
        ...creativeResult,
        shots: [{ ...creativeResult.shots[0], durationSeconds: 8 }],
      },
      creativeInput,
    ),
  );
});

describe("creative input validation", () => {
  test("round-trips every valid input field and accepts a full previous result", () => {
    const input = withInput({
      inputRevision: 2,
      title: "  Sharing  ",
      canon: [
        {
          entityId: "550e8400-e29b-41d4-a716-446655440000",
          versionId: "123e4567-e89b-42d3-a456-426614174000",
          code: "FRIEND_ONE",
          definition: { color: "yellow", nested: { age: 5 } },
        },
      ],
      previousResult: creativeResult,
      feedback: "",
    });

    const normalized = normalizeCreativeInput(input);

    assert.equal(normalized.title, "Sharing");
    assert.equal(normalized.feedback, "");
    assert.deepEqual(normalized.previousResult, creativeResult);
    assert.deepEqual(normalized.canon[0].definition, {
      color: "yellow",
      nested: { age: 5 },
    });
  });

  test("rejects unknown top-level and nested keys", () => {
    assertBadRequest(() =>
      normalizeCreativeInput({ ...creativeInput, extra: true }),
    );
    assertBadRequest(() =>
      normalizeCreativeInput({
        ...creativeInput,
        canon: [
          {
            entityId: "550e8400-e29b-41d4-a716-446655440000",
            versionId: "123e4567-e89b-42d3-a456-426614174000",
            code: "FRIEND_ONE",
            definition: {},
            extra: true,
          },
        ],
      }),
    );
  });

  test("rejects malformed containers, numbers, required text, and target limits", () => {
    for (const value of [null, [], "input", 1, false]) {
      assertBadRequest(() => normalizeCreativeInput(value));
    }

    for (const overrides of [
      { schemaVersion: 2 },
      { inputRevision: 0 },
      { inputRevision: 1.5 },
      { inputRevision: Number.NaN },
      { targetDurationSeconds: 0 },
      { targetDurationSeconds: 5 },
      { targetDurationSeconds: 124 },
      { targetDurationSeconds: Number.POSITIVE_INFINITY },
      { title: "   " },
      { premise: "" },
      { learningGoal: "   " },
      { tone: null },
      { canon: {} },
      { feedback: 1 },
      { previousResult: [] },
    ]) {
      assertBadRequest(() =>
        normalizeCreativeInput(withInput(overrides as Partial<CreativeInput>)),
      );
    }
  });

  test("enforces text, canon-count, definition, UUID, and byte caps", () => {
    for (const [field, value] of [
      ["title", "x".repeat(201)],
      ["premise", "x".repeat(2001)],
      ["learningGoal", "x".repeat(2001)],
      ["tone", "x".repeat(2001)],
      ["feedback", "x".repeat(2001)],
    ] as const) {
      assertBadRequest(() =>
        normalizeCreativeInput(withInput({ [field]: value })),
      );
    }

    const validCanon = (index: number) => ({
      entityId: "550e8400-e29b-41d4-a716-446655440000",
      versionId: "123e4567-e89b-42d3-a456-426614174000",
      code: `FRIEND_${index}`,
      definition: { index },
    });

    assertBadRequest(() =>
      normalizeCreativeInput(
        withInput({
          canon: Array.from({ length: 17 }, (_, index) => validCanon(index)),
        }),
      ),
    );
    assertBadRequest(() =>
      normalizeCreativeInput(
        withInput({
          canon: [
            {
              ...validCanon(1),
              entityId: "not-a-uuid",
            },
          ],
        }),
      ),
    );
    assertBadRequest(() =>
      normalizeCreativeInput(
        withInput({
          canon: [
            {
              ...validCanon(1),
              definition: { text: "x".repeat(64 * 1024) },
            },
          ],
        }),
      ),
    );
    assertBadRequest(() =>
      normalizeCreativeInput(
        withInput({
          canon: Array.from({ length: 16 }, (_, index) => ({
            ...validCanon(index),
            definition: { text: "x".repeat(40_000) },
          })),
        }),
      ),
    );
  });

  test("rejects non-JSON definition values", () => {
    for (const definition of [
      { value: undefined },
      { value: Number.NaN },
      { value: Number.POSITIVE_INFINITY },
      { value: 1n },
      { value: () => "nope" },
      ["array"],
    ]) {
      assertBadRequest(() =>
        normalizeCreativeInput(
          withInput({
            canon: [
              {
                entityId: "550e8400-e29b-41d4-a716-446655440000",
                versionId: "123e4567-e89b-42d3-a456-426614174000",
                code: "FRIEND_ONE",
                definition: definition as Record<string, unknown>,
              },
            ],
          }),
        ),
      );
    }
  });
});

describe("creative result validation", () => {
  test("round-trips full script and permits empty narration", () => {
    const result = withResult({
      script: "First line.\n\nSecond line.",
      shots: [{ ...creativeResult.shots[0], narration: "" }],
    });

    assert.deepEqual(normalizeCreativeResult(result, creativeInput), result);
  });

  test("rejects unknown keys, gaps, duplicates, out-of-order shots, and target mismatches", () => {
    assertBadRequest(() =>
      normalizeCreativeResult(
        { ...creativeResult, extra: true },
        creativeInput,
      ),
    );
    assertBadRequest(() =>
      normalizeCreativeResult(
        {
          ...creativeResult,
          shots: [{ ...creativeResult.shots[0], extra: true }],
        },
        creativeInput,
      ),
    );
    const twoShotInput = withInput({ targetDurationSeconds: 8 });
    const twoShots = [
      creativeResult.shots[0],
      { ...creativeResult.shots[0], sequence: 2 },
    ];
    for (const shots of [
      [{ ...twoShots[0], sequence: 2 }, twoShots[1]],
      [
        { ...twoShots[0], sequence: 1 },
        { ...twoShots[1], sequence: 1 },
      ],
      [
        { ...twoShots[0], sequence: 1 },
        { ...twoShots[1], sequence: 3 },
      ],
    ]) {
      assertBadRequest(() =>
        normalizeCreativeResult({ ...creativeResult, shots }, twoShotInput),
      );
    }
    assertBadRequest(() =>
      normalizeCreativeResult(creativeResult, twoShotInput),
    );
  });

  test("enforces result text and payload caps", () => {
    for (const [field, value] of [
      ["synopsis", "x".repeat(2001)],
      ["script", "x".repeat(12001)],
    ] as const) {
      assertBadRequest(() =>
        normalizeCreativeResult(withResult({ [field]: value }), creativeInput),
      );
    }

    assertBadRequest(() =>
      normalizeCreativeResult(
        withResult({
          shots: [
            {
              ...creativeResult.shots[0],
              direction: "x".repeat(4001),
            },
          ],
        }),
        creativeInput,
      ),
    );
    assertBadRequest(() =>
      normalizeCreativeResult(
        withResult({
          shots: [
            {
              ...creativeResult.shots[0],
              narration: "x".repeat(2001),
            },
          ],
        }),
        creativeInput,
      ),
    );
    assertBadRequest(() =>
      normalizeCreativeResult(
        withResult({
          shots: [
            {
              ...creativeResult.shots[0],
              imagePrompt: "x".repeat(4001),
            },
          ],
        }),
        creativeInput,
      ),
    );
  });
});

describe("creative completion validation", () => {
  test("accepts completed and failed outcomes with bounded metadata", () => {
    const normalized = normalizeCreativeCompletion(completed(), creativeInput);
    assert.equal(normalized.status, "COMPLETED");
    if (normalized.status === "COMPLETED") {
      assert.deepEqual(normalized.result, creativeResult);
    }

    const failed = normalizeCreativeCompletion(
      {
        attemptToken: ATTEMPT_TOKEN,
        inputHash: INPUT_HASH,
        status: "FAILED",
        errorCode: "EXECUTION_FAILED",
        metadata: {
          instructionVersion: "storyboard-v1",
          sdkVersion: "sdk-test",
          model: "model-test",
          threadId: "thread-test",
          usage: null,
        },
      },
      creativeInput,
    );
    assert.equal(failed.status, "FAILED");
  });

  test("rejects malformed tokens, hashes, outcomes, metadata, and unknown keys", () => {
    for (const overrides of [
      { attemptToken: "not-a-token" },
      { attemptToken: `${"a".repeat(43)}=` },
      { inputHash: "not-a-hash" },
      { inputHash: "a".repeat(64) },
      { status: "UNKNOWN" },
      { result: undefined },
      { metadata: { ...completed().metadata, extra: true } },
      { metadata: { ...completed().metadata, sdkVersion: "x".repeat(129) } },
      {
        metadata: {
          ...completed().metadata,
          usage: { inputTokens: -1, cachedInputTokens: 0, outputTokens: 0 },
        },
      },
      {
        metadata: {
          ...completed().metadata,
          usage: {
            inputTokens: Number.MAX_SAFE_INTEGER + 1,
            cachedInputTokens: 0,
            outputTokens: 0,
          },
        },
      },
    ]) {
      assertBadRequest(() =>
        normalizeCreativeCompletion(
          { ...completed(), ...overrides },
          creativeInput,
        ),
      );
    }

    assertBadRequest(() =>
      normalizeCreativeCompletion(
        { ...completed(), extra: true },
        creativeInput,
      ),
    );
    assertBadRequest(() =>
      normalizeCreativeCompletion(
        {
          ...completed(),
          inputHash: hashCreativeValue(withInput({ inputRevision: 2 })),
        },
        creativeInput,
      ),
    );
    assertBadRequest(() =>
      normalizeCreativeCompletion(
        { ...completed(), status: "FAILED", result: creativeResult },
        creativeInput,
      ),
    );
    assertBadRequest(() =>
      normalizeCreativeCompletion(
        {
          ...completed(),
          status: "FAILED",
          errorCode: "EXECUTION_FAILED",
          result: undefined,
        },
        creativeInput,
      ),
    );
  });
});

describe("creative hashing and schema", () => {
  test("sorts object keys recursively while preserving array order", () => {
    assert.equal(
      hashCreativeValue({
        z: 1,
        nested: { b: 2, a: 1 },
        array: [{ z: 3, a: 4 }],
      }),
      hashCreativeValue({
        array: [{ a: 4, z: 3 }],
        nested: { a: 1, b: 2 },
        z: 1,
      }),
    );
    assert.notEqual(hashCreativeValue([1, 2]), hashCreativeValue([2, 1]));
  });

  test("rejects non-JSON hash values and cycles", () => {
    for (const value of [
      undefined,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      1n,
      () => "nope",
    ]) {
      assert.throws(() => hashCreativeValue(value));
    }
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    assert.throws(() => hashCreativeValue(cyclic));
  });

  test("rejects deeply nested JSON without overflowing the call stack", () => {
    let nested: Record<string, unknown> = { leaf: true };
    for (let depth = 0; depth < 5000; depth += 1) {
      nested = { next: nested };
    }

    assertBadRequest(() =>
      normalizeCreativeInput(
        withInput({
          canon: [
            {
              entityId: "550e8400-e29b-41d4-a716-446655440000",
              versionId: "123e4567-e89b-42d3-a456-426614174000",
              code: "FRIEND_ONE",
              definition: nested,
            },
          ],
        }),
      ),
    );
  });

  test("publishes a strict output schema", () => {
    assert.equal(creativeOutputSchema.type, "object");
    assert.equal(creativeOutputSchema.additionalProperties, false);
    assert.deepEqual(creativeOutputSchema.required, [
      "synopsis",
      "script",
      "shots",
    ]);
    assert.equal(
      creativeOutputSchema.properties.shots.items.additionalProperties,
      false,
    );
    assert.deepEqual(creativeOutputSchema.properties.shots.items.required, [
      "sequence",
      "durationSeconds",
      "direction",
      "narration",
      "imagePrompt",
    ]);
  });
});
