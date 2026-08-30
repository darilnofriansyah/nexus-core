import * as assert from "node:assert/strict";
import { describe, test } from "node:test";
import { BadRequestException } from "@nestjs/common";

const { normalizeCreateRenderRequest, normalizeRetryRenderRequest } = require("./render-validation") as {
  normalizeCreateRenderRequest(input: unknown): Record<string, unknown>;
  normalizeRetryRenderRequest(input: unknown): Record<string, unknown>;
};

const REQUEST_ID = "550e8400-e29b-41d4-a716-446655440000";
const AUDIO_ASSET_ID = "123e4567-e89b-12d3-a456-426614174000";
const CAPTION_ASSET_ID = "123e4567-e89b-52d3-a456-426614174000";

function assertBadRequest(action: () => unknown): void {
  assert.throws(action, BadRequestException);
}

describe("Rovelle render request validation", () => {
  test("requires UUID request and audio asset IDs while accepting an optional caption UUID", () => {
    assert.deepEqual(
      normalizeCreateRenderRequest({
        requestId: `  ${REQUEST_ID} `,
        audioAssetId: ` ${AUDIO_ASSET_ID} `,
        captionAssetId: ` ${CAPTION_ASSET_ID} `,
      }),
      {
        requestId: REQUEST_ID,
        audioAssetId: AUDIO_ASSET_ID,
        captionAssetId: CAPTION_ASSET_ID,
      },
    );
    assert.equal(
      normalizeCreateRenderRequest({
        requestId: REQUEST_ID,
        audioAssetId: AUDIO_ASSET_ID,
        captionAssetId: null,
      }).captionAssetId,
      null,
    );

    for (const input of [
      { requestId: "not-a-uuid", audioAssetId: AUDIO_ASSET_ID },
      { requestId: REQUEST_ID, audioAssetId: "not-a-uuid" },
      { requestId: REQUEST_ID, audioAssetId: AUDIO_ASSET_ID, captionAssetId: "not-a-uuid" },
      { requestId: REQUEST_ID, audioAssetId: AUDIO_ASSET_ID, captionAssetId: "" },
    ]) {
      assertBadRequest(() => normalizeCreateRenderRequest(input));
    }
  });

  test("keeps only the create DTO fields and accepts omitted caption", () => {
    const normalized = normalizeCreateRenderRequest({
      requestId: REQUEST_ID,
      audioAssetId: AUDIO_ASSET_ID,
      storageKey: "caller/key",
      provider: "r2",
    });

    assert.deepEqual(normalized, {
      requestId: REQUEST_ID,
      audioAssetId: AUDIO_ASSET_ID,
      captionAssetId: undefined,
    });
    assert.equal("storageKey" in normalized, false);
    assert.equal("provider" in normalized, false);
  });

  test("retry requests require only a UUID request ID", () => {
    assert.deepEqual(
      normalizeRetryRenderRequest({ requestId: ` ${REQUEST_ID} `, storageKey: "ignored" }),
      { requestId: REQUEST_ID },
    );

    for (const requestId of [
      "",
      "not-a-uuid",
      "00000000-0000-0000-0000-000000000000",
      null,
      1,
    ]) {
      assertBadRequest(() => normalizeRetryRenderRequest({ requestId }));
    }
  });
});
