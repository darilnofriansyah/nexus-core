export interface CreativeInput {
  schemaVersion: 1;
  inputRevision: number;
  title: string;
  targetDurationSeconds: number;
  premise: string;
  learningGoal: string;
  tone: string;
  canon: Array<{
    entityId: string;
    versionId: string;
    code: string;
    definition: Record<string, unknown>;
  }>;
  previousResult: CreativeResult | null;
  feedback: string | null;
}

export interface CreativeResult {
  synopsis: string;
  script: string;
  shots: Array<{
    sequence: number;
    durationSeconds: 4;
    direction: string;
    narration: string;
    imagePrompt: string;
  }>;
}

export interface CreativeExecutionMetadata {
  instructionVersion: "storyboard-v1";
  sdkVersion: string;
  model: string;
  threadId: string | null;
  usage: {
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
  } | null;
}

export type CreativeExecutionOutcome = {
  metadata: CreativeExecutionMetadata;
} & (
  | { status: "COMPLETED"; result: CreativeResult }
  | {
      status: "FAILED";
      errorCode: "AUTH_FAILED" | "INVALID_OUTPUT" | "EXECUTION_FAILED";
    }
);

export type CreativeCompletion = CreativeExecutionOutcome & {
  attemptToken: string;
  inputHash: string;
};

export interface CreativeExecutionRequest {
  jobId: string;
  task: "STORYBOARD";
  input: CreativeInput;
  inputHash: string;
}

export type CreativeClaim =
  | { claimed: false }
  | {
      claimed: true;
      jobId: string;
      task: "STORYBOARD";
      attemptToken: string;
      inputHash: string;
      leaseExpiresAt: string;
      input: CreativeInput;
    };

export const creativeOutputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["synopsis", "script", "shots"],
  properties: {
    synopsis: { type: "string", minLength: 1, maxLength: 2000 },
    script: { type: "string", minLength: 1, maxLength: 12000 },
    shots: {
      type: "array",
      minItems: 1,
      maxItems: 30,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "sequence",
          "durationSeconds",
          "direction",
          "narration",
          "imagePrompt",
        ],
        properties: {
          sequence: { type: "integer", minimum: 1, maximum: 30 },
          durationSeconds: { const: 4 },
          direction: { type: "string", minLength: 1, maxLength: 4000 },
          narration: { type: "string", maxLength: 2000 },
          imagePrompt: { type: "string", minLength: 1, maxLength: 4000 },
        },
      },
    },
  },
} as const;
