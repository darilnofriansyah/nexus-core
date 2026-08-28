import * as assert from "node:assert/strict";
import { describe, test } from "node:test";
import { BadRequestException } from "@nestjs/common";
import type { RunwareWebhookEvent } from "./runware-webhook.dto";
import { parseRunwareWebhook } from "./runware-webhook.parser";

const TASK_ID = "123e4567-e89b-42d3-a456-426614174000";
const VIDEO_ID = "987e6543-e21b-45d3-a456-426614174000";

function assertBadRequest(action: () => unknown): void {
  assert.throws(action, BadRequestException);
}

describe("Runware webhook parser", () => {
  test("normalizes a direct successful video callback", () => {
    const event = parseRunwareWebhook({
      taskType: "videoInference",
      taskUUID: TASK_ID,
      status: "success",
      videoUUID: VIDEO_ID,
      videoURL: "https://provider.invalid/video.mp4",
      documentationURL: "https://provider.invalid/docs",
      providerURL: "https://attacker.invalid/redirect",
      cost: 1.25,
    });

    const expected: RunwareWebhookEvent = {
      kind: "success",
      taskId: TASK_ID,
      providerOutputId: VIDEO_ID,
      costUsd: "1.25",
    };
    assert.deepEqual(event, expected);
    assert.equal("videoURL" in event, false);
    assert.equal("documentationURL" in event, false);
    assert.equal("providerURL" in event, false);
  });

  test("infers success without status from a video output identity", () => {
    assert.deepEqual(
      parseRunwareWebhook({
        taskType: "videoInference",
        taskUUID: TASK_ID,
        videoUUID: VIDEO_ID,
      }),
      {
        kind: "success",
        taskId: TASK_ID,
        providerOutputId: VIDEO_ID,
        costUsd: null,
      },
    );
  });

  test("normalizes a direct processing callback", () => {
    assert.deepEqual(
      parseRunwareWebhook({
        taskType: "videoInference",
        taskUUID: TASK_ID,
        status: "processing",
        progress: 37.5,
      }),
      {
        kind: "processing",
        taskId: TASK_ID,
        progress: 37.5,
      },
    );

    assert.deepEqual(
      parseRunwareWebhook({
        taskType: "videoInference",
        taskUUID: TASK_ID,
        status: "processing",
      }),
      {
        kind: "processing",
        taskId: TASK_ID,
        progress: null,
      },
    );
  });

  test("normalizes a direct error callback", () => {
    assert.deepEqual(
      parseRunwareWebhook({
        taskType: "videoInference",
        taskUUID: TASK_ID,
        status: "error",
        code: "PROVIDER_FAILURE",
        message: "The provider could not render the video",
        cost: 0,
      }),
      {
        kind: "failure",
        taskId: TASK_ID,
        code: "PROVIDER_FAILURE",
        message: "The provider could not render the video",
        costUsd: "0",
      },
    );
  });

  test("unwraps exactly one data item", () => {
    assert.deepEqual(
      parseRunwareWebhook({
        data: [
          {
            taskType: "videoInference",
            taskUUID: TASK_ID,
            status: "success",
            videoUUID: VIDEO_ID,
          },
        ],
      }),
      {
        kind: "success",
        taskId: TASK_ID,
        providerOutputId: VIDEO_ID,
        costUsd: null,
      },
    );
  });

  test("unwraps exactly one error item", () => {
    assert.deepEqual(
      parseRunwareWebhook({
        errors: [
          {
            taskType: "videoInference",
            taskUUID: TASK_ID,
            code: "INVALID_INPUT",
            message: "The prompt is invalid",
            cost: 0.5,
          },
        ],
      }),
      {
        kind: "failure",
        taskId: TASK_ID,
        code: "INVALID_INPUT",
        message: "The prompt is invalid",
        costUsd: "0.5",
      },
    );
  });

  test("rejects unsupported callback containers and item counts", () => {
    for (const payload of [
      [],
      [{ taskType: "videoInference", taskUUID: TASK_ID, status: "success" }],
      { data: [] },
      { data: [{ taskType: "videoInference" }, { taskType: "videoInference" }] },
      { errors: [] },
      { errors: [{ taskType: "videoInference" }, { taskType: "videoInference" }] },
      { data: [{}], errors: [{}] },
      null,
      "payload",
    ]) {
      assertBadRequest(() => parseRunwareWebhook(payload));
    }
  });

  test("rejects missing or malformed task UUIDs and wrong task types", () => {
    for (const taskUUID of [
      undefined,
      null,
      "",
      "not-a-uuid",
      "00000000-0000-0000-0000-000000000000",
      "123e4567-e89b-02d3-a456-426614174000",
      1,
    ]) {
      assertBadRequest(() =>
        parseRunwareWebhook({
          taskType: "videoInference",
          taskUUID,
          status: "success",
        }),
      );
    }

    assertBadRequest(() =>
      parseRunwareWebhook({
        taskType: "imageInference",
        taskUUID: TASK_ID,
        status: "success",
      }),
    );
  });

  test("rejects unknown statuses and success without an output identity", () => {
    assertBadRequest(() =>
      parseRunwareWebhook({
        taskType: "videoInference",
        taskUUID: TASK_ID,
        status: "queued",
      }),
    );
    assertBadRequest(() =>
      parseRunwareWebhook({
        taskType: "videoInference",
        taskUUID: TASK_ID,
        videoURL: "https://provider.invalid/video.mp4",
      }),
    );
  });

  test("rejects processing progress outside the finite 0 through 100 range", () => {
    for (const progress of [-1, 101, NaN, Infinity, -Infinity, "50"]) {
      assertBadRequest(() =>
        parseRunwareWebhook({
          taskType: "videoInference",
          taskUUID: TASK_ID,
          status: "processing",
          progress,
        }),
      );
    }
  });

  test("rejects negative, non-finite, and non-numeric costs", () => {
    for (const cost of [-0.01, NaN, Infinity, -Infinity, "0.5", true]) {
      assertBadRequest(() =>
        parseRunwareWebhook({
          taskType: "videoInference",
          taskUUID: TASK_ID,
          status: "success",
          cost,
        }),
      );
    }
  });

  test("rejects errors missing a non-empty code or message", () => {
    for (const field of ["code", "message"] as const) {
      const payload = {
        taskType: "videoInference",
        taskUUID: TASK_ID,
        status: "error",
        code: "FAILURE",
        message: "render failed",
      };
      delete payload[field];
      assertBadRequest(() => parseRunwareWebhook(payload));
    }

    for (const value of ["", "   ", 1, null, undefined]) {
      assertBadRequest(() =>
        parseRunwareWebhook({
          taskType: "videoInference",
          taskUUID: TASK_ID,
          status: "error",
          code: value,
          message: "render failed",
        }),
      );
      assertBadRequest(() =>
        parseRunwareWebhook({
          taskType: "videoInference",
          taskUUID: TASK_ID,
          status: "error",
          code: "FAILURE",
          message: value,
        }),
      );
    }
  });
});
