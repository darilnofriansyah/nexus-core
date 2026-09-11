import type { CreativeInput, CreativeResult } from "./dto/creative.dto";

export const creativeInput: CreativeInput = {
  schemaVersion: 1,
  inputRevision: 1,
  title: "Sharing",
  targetDurationSeconds: 4,
  premise: "Two friends share a toy.",
  learningGoal: "Taking turns",
  tone: "Warm",
  canon: [],
  previousResult: null,
  feedback: null,
};

export const creativeResult: CreativeResult = {
  synopsis: "Two friends learn to take turns.",
  script: "One toy, two happy friends.",
  shots: [
    {
      sequence: 1,
      durationSeconds: 4,
      direction: "Wide shot of friends sharing.",
      narration: "There is a turn for everyone.",
      imagePrompt: "A warm scene of two friends.",
    },
  ],
};
