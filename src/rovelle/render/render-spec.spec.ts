import * as assert from "node:assert/strict";
import { test } from "node:test";

const { buildRenderSpecV1, hashRenderSpec, stableRenderSpecJson } = require("./render-spec") as {
  buildRenderSpecV1(input: {
    shots: readonly Record<string, unknown>[];
    audio: Record<string, unknown>;
    captions?: Record<string, unknown> | null;
  }): Record<string, any>;
  hashRenderSpec(spec: Record<string, any>): string;
  stableRenderSpecJson(spec: Record<string, any>): string;
};

const asset = (assetId: string, mediaType: string, byteSize: string, etag: string | null) => ({
  assetId,
  mediaType,
  byteSize,
  etag,
});

const AUDIO = asset("audio-asset", "audio/mpeg", "1200", "audio-etag");
const CAPTIONS = asset("caption-asset", "text/vtt", "88", "caption-etag");
const SHOTS = [
  {
    sequence: 2,
    shotId: "shot-2",
    generationId: "generation-2",
    targetDurationSeconds: 6,
    video: asset("video-2", "video/mp4", "2002", "video-etag-2"),
  },
  {
    sequence: 1,
    shotId: "shot-1",
    generationId: "generation-1",
    targetDurationSeconds: 4,
    video: asset("video-1", "video/mp4", "1001", null),
  },
];

test("builds a deterministic V1 render spec with sorted shots and approved output", () => {
  const spec = buildRenderSpecV1({ shots: SHOTS, audio: AUDIO, captions: CAPTIONS });

  assert.deepEqual(spec.shots.map((shot: { sequence: number }) => shot.sequence), [1, 2]);
  assert.deepEqual(spec.output, {
    container: "mp4",
    width: 1080,
    height: 1920,
    frameRate: 30,
    videoCodec: "libx264",
    pixelFormat: "yuv420p",
    audioCodec: "aac",
    audioSampleRate: 48000,
  });
  assert.equal(spec.version, 1);
  assert.equal(spec.profile, "VERTICAL_SHORT_V1");
  assert.equal(spec.captions.format, "WEBVTT");
  assert.equal(spec.captions.byteSize, "88");
  assert.equal(typeof spec.audio.byteSize, "string");
  assert.equal("storageKey" in spec, false);
  assert.equal("storageKey" in spec.audio, false);
  assert.equal("url" in spec.audio, false);
  assert.equal("url" in spec.shots[0].video, false);
});

test("maps SRT captions and preserves a null caption", () => {
  assert.equal(
    buildRenderSpecV1({
      shots: [],
      audio: AUDIO,
      captions: { ...CAPTIONS, mediaType: " application/x-subrip " },
    }).captions.format,
    "SRT",
  );
  assert.equal(buildRenderSpecV1({ shots: [], audio: AUDIO, captions: null }).captions, null);
});

test("stable render JSON and SHA-256 hash are repeatable and sensitive to asset identity", () => {
  const first = buildRenderSpecV1({ shots: SHOTS, audio: AUDIO, captions: CAPTIONS });
  const second = buildRenderSpecV1({
    shots: [SHOTS[1], SHOTS[0]],
    audio: { ...AUDIO },
    captions: { ...CAPTIONS },
  });

  assert.equal(stableRenderSpecJson(first), stableRenderSpecJson(second));
  assert.equal(hashRenderSpec(first), hashRenderSpec(second));
  assert.match(hashRenderSpec(first), /^[0-9a-f]{64}$/);
  assert.notEqual(
    hashRenderSpec(first),
    hashRenderSpec({ ...first, audio: { ...first.audio, etag: "changed" } }),
  );
  assert.notEqual(
    hashRenderSpec(first),
    hashRenderSpec({ ...first, audio: { ...first.audio, assetId: "other-audio" } }),
  );
});

test("stable JSON sorts object keys recursively while preserving array order", () => {
  assert.equal(
    stableRenderSpecJson({ z: 3, a: { z: 2, a: 1 }, list: [{ b: 2, a: 1 }, "x"] }),
    '{"a":{"a":1,"z":2},"list":[{"a":1,"b":2},"x"],"z":3}',
  );
});
