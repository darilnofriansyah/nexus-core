import * as assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "node:test";

import {
  FfprobeService,
  parseRationalFrameRate,
  type FfprobeSpawn,
  type FfprobeSpawnOptions,
} from "./ffprobe.service";
import { RenderWorkerError } from "./media-transfer.service";

const FFPROBE_PATH = "/opt/bin/ffprobe";

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly killSignals: NodeJS.Signals[] = [];

  kill(signal?: NodeJS.Signals): boolean {
    if (signal) this.killSignals.push(signal);
    return true;
  }

  finish(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.stdout.end();
    this.stderr.end();
    this.emit("close", code, signal);
  }
}

interface SpawnCall {
  command: string;
  args: string[];
  options: FfprobeSpawnOptions;
}

function createSpawn(output = "{}", exitCode = 0, stderr = "") {
  const calls: SpawnCall[] = [];
  const children: FakeChild[] = [];
  const spawn: FfprobeSpawn = (
    command: string,
    args: string[],
    options: FfprobeSpawnOptions,
  ) => {
    const child = new FakeChild();
    calls.push({ command, args, options });
    children.push(child);
    queueMicrotask(() => {
      if (output) child.stdout.write(output);
      if (stderr) child.stderr.write(stderr);
      child.finish(exitCode);
    });
    return child;
  };
  return { calls, children, spawn };
}

function createPendingSpawn() {
  const calls: SpawnCall[] = [];
  const children: FakeChild[] = [];
  const spawn: FfprobeSpawn = (
    command: string,
    args: string[],
    options: FfprobeSpawnOptions,
  ) => {
    const child = new FakeChild();
    calls.push({ command, args, options });
    children.push(child);
    return child;
  };
  return { calls, children, spawn };
}

function createService(spawn: FfprobeSpawn): FfprobeService {
  return new FfprobeService({ ffprobePath: FFPROBE_PATH }, spawn);
}

function assertErrorCode(error: unknown, code: string): void {
  assert.ok(error instanceof RenderWorkerError);
  assert.equal(error.code, code);
}

const SOURCE_JSON = JSON.stringify({
  streams: [
    {
      index: 0,
      codec_name: "vp9",
      codec_type: "video",
      width: 720,
      height: 1280,
      pix_fmt: "yuv420p",
      r_frame_rate: "30000/1001",
      duration: "4.25",
    },
  ],
  format: { duration: "4.25", tags: { title: "source" } },
});

const MASTER_JSON = JSON.stringify({
  streams: [
    {
      index: 0,
      codec_name: "h264",
      codec_type: "video",
      width: 1080,
      height: 1920,
      pix_fmt: "yuv420p",
      r_frame_rate: "30/1",
      duration: "10.00",
    },
    { index: 1, codec_name: "aac", codec_type: "audio", sample_rate: "48000" },
    { index: 2, codec_name: "mov_text", codec_type: "subtitle" },
  ],
  format: {
    duration: "10.05",
    format_name: "mov,mp4,m4a,3gp,3g2,mj2",
    tags: { encoder: "Lavf" },
  },
});

test("probes a source video with a safe ffprobe argv and parses its primary stream", async () => {
  const fake = createSpawn(SOURCE_JSON);

  const result = await createService(fake.spawn).probeVideo(
    "/safe/generated/source file.mp4",
    new AbortController().signal,
  );

  assert.deepEqual(result, {
    codec: "vp9",
    width: 720,
    height: 1280,
    pixelFormat: "yuv420p",
    frameRate: 30000 / 1001,
    durationSeconds: 4.25,
  });
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0]?.command, FFPROBE_PATH);
  assert.equal(fake.calls[0]?.options.shell, false);
  assert.deepEqual(fake.calls[0]?.options.stdio, ["ignore", "pipe", "pipe"]);
  assert.deepEqual(fake.calls[0]?.args, [
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    "/safe/generated/source file.mp4",
  ]);
});

test("parses rational frame rates and rejects invalid values", () => {
  assert.equal(parseRationalFrameRate("30/1"), 30);
  assert.equal(parseRationalFrameRate("30000/1001"), 30000 / 1001);
  for (const value of [
    "30/0",
    "0/1",
    "-30/1",
    "-30/-1",
    "NaN/1",
    "Infinity/1",
    "not-a-rate",
  ]) {
    assert.equal(parseRationalFrameRate(value), null, value);
  }
});

test("verifies the configured ffprobe binary without invoking a shell", async () => {
  const fake = createSpawn("");

  await createService(fake.spawn).verifyBinary();

  assert.deepEqual(fake.calls[0]?.args, ["-hide_banner", "-version"]);
  assert.equal(fake.calls[0]?.options.shell, false);
});

test("maps ffprobe process failures and sanitizes only a bounded stderr tail", async () => {
  const stderr = `prefix-only-diagnostic\n${"x".repeat(20000)}\u001b[31mfinal failure https://secret.example/token\u001b[0m\u0000`;
  const fake = createSpawn("{}", 1, stderr);

  await assert.rejects(
    createService(fake.spawn).probeVideo(
      "/safe/source.mp4",
      new AbortController().signal,
    ),
    (error: unknown) => {
      assertErrorCode(error, "FFPROBE_FAILED");
      assert.ok(error instanceof Error);
      assert.ok(error.message.length <= 4000);
      assert.ok(error.message.includes("final failure"));
      assert.equal(error.message.includes("https://secret.example/token"), false);
      assert.ok(error.message.includes("[redacted-url]"));
      assert.equal(error.message.includes("\u001b"), false);
      assert.equal(error.message.includes("\u0000"), false);
      assert.equal(error.message.includes("\n"), false);
      assert.equal(error.message.includes("prefix-only-diagnostic"), false);
      return true;
    },
  );
});

test("maps malformed ffprobe JSON to FFPROBE_FAILED", async () => {
  const fake = createSpawn("not-json");

  await assert.rejects(
    createService(fake.spawn).probeVideo(
      "/safe/source.mp4",
      new AbortController().signal,
    ),
    (error: unknown) => {
      assertErrorCode(error, "FFPROBE_FAILED");
      return true;
    },
  );
});

test("rejects source media without a positive video stream", async () => {
  for (const output of [
    JSON.stringify({ streams: [], format: { duration: "5" } }),
    JSON.stringify({
      streams: [
        {
          codec_name: "h264",
          codec_type: "video",
          width: 0,
          height: 1080,
          r_frame_rate: "30/1",
          duration: "5",
        },
      ],
      format: { duration: "5" },
    }),
    JSON.stringify({
      streams: [
        {
          codec_name: "h264",
          codec_type: "video",
          width: 1080,
          height: 1920,
          r_frame_rate: "30/1",
          duration: "0",
        },
      ],
      format: { duration: "0" },
    }),
  ]) {
    await assert.rejects(
      createService(createSpawn(output).spawn).probeVideo(
        "/safe/source.mp4",
        new AbortController().signal,
      ),
      (error: unknown) => {
        assertErrorCode(error, "OUTPUT_MEDIA_INVALID");
        return true;
      },
    );
  }
});

test("accepts the final master contract and ignores benign metadata", async () => {
  const fake = createSpawn(MASTER_JSON);

  const result = await createService(fake.spawn).verifyMaster(
    {
      path: "/safe/generated/master.mp4",
      expectedDurationSeconds: 10,
      captionsExpected: true,
    },
    new AbortController().signal,
  );

  assert.equal(result.video.codec, "h264");
  assert.equal(result.video.width, 1080);
  assert.equal(result.video.height, 1920);
  assert.equal(result.video.pixelFormat, "yuv420p");
  assert.equal(result.video.frameRate, 30);
  assert.equal(result.audio.codec, "aac");
  assert.equal(result.audio.sampleRate, 48000);
  assert.equal(result.subtitleCodec, "mov_text");
  assert.equal(result.durationSeconds, 10.05);
});

test("rejects a final master that is not an MP4 container", async () => {
  const output = JSON.stringify({
    streams: [
      {
        codec_name: "h264",
        codec_type: "video",
        width: 1080,
        height: 1920,
        pix_fmt: "yuv420p",
        r_frame_rate: "30/1",
      },
      { codec_name: "aac", codec_type: "audio", sample_rate: "48000" },
    ],
    format: { duration: "10", format_name: "matroska,webm" },
  });

  await assert.rejects(
    createService(createSpawn(output).spawn).verifyMaster(
      {
        path: "/safe/master.mkv",
        expectedDurationSeconds: 10,
        captionsExpected: false,
      },
      new AbortController().signal,
    ),
    (error: unknown) => {
      assertErrorCode(error, "OUTPUT_MEDIA_INVALID");
      return true;
    },
  );
});

test("prefers average frame rate and falls back to raw frame rate", async () => {
  const vfrOutput = JSON.stringify({
    streams: [
      {
        codec_name: "h264",
        codec_type: "video",
        width: 1080,
        height: 1920,
        pix_fmt: "yuv420p",
        r_frame_rate: "30/1",
        avg_frame_rate: "24/1",
      },
      { codec_name: "aac", codec_type: "audio", sample_rate: "48000" },
    ],
    format: {
      duration: "10",
      format_name: "mov,mp4,m4a,3gp,3g2,mj2",
    },
  });

  await assert.rejects(
    createService(createSpawn(vfrOutput).spawn).verifyMaster(
      {
        path: "/safe/master.mp4",
        expectedDurationSeconds: 10,
        captionsExpected: false,
      },
      new AbortController().signal,
    ),
    (error: unknown) => {
      assertErrorCode(error, "OUTPUT_MEDIA_INVALID");
      return true;
    },
  );

  const fallbackOutput = JSON.stringify({
    streams: [
      {
        codec_name: "h264",
        codec_type: "video",
        width: 1080,
        height: 1920,
        pix_fmt: "yuv420p",
        r_frame_rate: "30/1",
      },
      { codec_name: "aac", codec_type: "audio", sample_rate: "48000" },
    ],
    format: {
      duration: "10",
      format_name: "mov,mp4,m4a,3gp,3g2,mj2",
    },
  });

  const result = await createService(createSpawn(fallbackOutput).spawn).verifyMaster(
    {
      path: "/safe/master.mp4",
      expectedDurationSeconds: 10,
      captionsExpected: false,
    },
    new AbortController().signal,
  );
  assert.equal(result.video.frameRate, 30);
});

test("rejects unsupported subtitle codecs even when captions are optional", async () => {
  const output = JSON.stringify({
    streams: [
      {
        codec_name: "h264",
        codec_type: "video",
        width: 1080,
        height: 1920,
        pix_fmt: "yuv420p",
        r_frame_rate: "30/1",
      },
      { codec_name: "aac", codec_type: "audio", sample_rate: "48000" },
      { codec_name: "subrip", codec_type: "subtitle" },
    ],
    format: {
      duration: "10",
      format_name: "mov,mp4,m4a,3gp,3g2,mj2",
    },
  });

  await assert.rejects(
    createService(createSpawn(output).spawn).verifyMaster(
      {
        path: "/safe/master.mp4",
        expectedDurationSeconds: 10,
        captionsExpected: false,
      },
      new AbortController().signal,
    ),
    (error: unknown) => {
      assertErrorCode(error, "OUTPUT_MEDIA_INVALID");
      return true;
    },
  );
});

test("requires the final video, audio, caption, and duration contract", async () => {
  type MasterCase = {
    name: string;
    stream: Record<string, unknown>;
    audio?: Record<string, unknown>;
    expectedDurationSeconds: number;
    actualDuration?: string;
    captionsExpected: boolean;
  };
  const cases: MasterCase[] = [
    {
      name: "h264 video",
      stream: { codec_name: "hevc", codec_type: "video", width: 1080, height: 1920, pix_fmt: "yuv420p", r_frame_rate: "30/1" },
      expectedDurationSeconds: 10,
      captionsExpected: false,
    },
    {
      name: "dimensions",
      stream: { codec_name: "h264", codec_type: "video", width: 720, height: 1280, pix_fmt: "yuv420p", r_frame_rate: "30/1" },
      expectedDurationSeconds: 10,
      captionsExpected: false,
    },
    {
      name: "pixel format",
      stream: { codec_name: "h264", codec_type: "video", width: 1080, height: 1920, pix_fmt: "yuv444p", r_frame_rate: "30/1" },
      expectedDurationSeconds: 10,
      captionsExpected: false,
    },
    {
      name: "frame rate",
      stream: { codec_name: "h264", codec_type: "video", width: 1080, height: 1920, pix_fmt: "yuv420p", r_frame_rate: "30000/1001" },
      expectedDurationSeconds: 10,
      captionsExpected: false,
    },
    {
      name: "audio codec",
      stream: { codec_name: "h264", codec_type: "video", width: 1080, height: 1920, pix_fmt: "yuv420p", r_frame_rate: "30/1" },
      audio: { codec_name: "opus", codec_type: "audio", sample_rate: "48000" },
      expectedDurationSeconds: 10,
      captionsExpected: false,
    },
    {
      name: "audio sample rate",
      stream: { codec_name: "h264", codec_type: "video", width: 1080, height: 1920, pix_fmt: "yuv420p", r_frame_rate: "30/1" },
      audio: { codec_name: "aac", codec_type: "audio", sample_rate: "44100" },
      expectedDurationSeconds: 10,
      captionsExpected: false,
    },
    {
      name: "required captions",
      stream: { codec_name: "h264", codec_type: "video", width: 1080, height: 1920, pix_fmt: "yuv420p", r_frame_rate: "30/1" },
      expectedDurationSeconds: 10,
      captionsExpected: true,
    },
    {
      name: "duration",
      stream: { codec_name: "h264", codec_type: "video", width: 1080, height: 1920, pix_fmt: "yuv420p", r_frame_rate: "30/1" },
      expectedDurationSeconds: 10,
      actualDuration: "10.21",
      captionsExpected: false,
    },
  ];

  for (const testCase of cases) {
    const output = JSON.stringify({
      streams: [
        testCase.stream,
        testCase.audio ?? { codec_name: "aac", codec_type: "audio", sample_rate: "48000" },
        ...(testCase.name === "required captions"
          ? []
          : [{ codec_name: "mov_text", codec_type: "subtitle" }]),
      ],
      format: {
        duration: testCase.actualDuration ?? "10",
        format_name: "mov,mp4,m4a,3gp,3g2,mj2",
      },
    });

    await assert.rejects(
      createService(createSpawn(output).spawn).verifyMaster(
        {
          path: "/safe/master.mp4",
          expectedDurationSeconds: testCase.expectedDurationSeconds,
          captionsExpected: testCase.captionsExpected,
        },
        new AbortController().signal,
      ),
      (error: unknown) => {
        assertErrorCode(error, "OUTPUT_MEDIA_INVALID");
        return true;
      },
      testCase.name,
    );
  }
});

test("accepts a master without captions when captions are not expected", async () => {
  const output = JSON.stringify({
    streams: [
      {
        codec_name: "h264",
        codec_type: "video",
        width: 1080,
        height: 1920,
        pix_fmt: "yuv420p",
        r_frame_rate: "30/1",
      },
      { codec_name: "aac", codec_type: "audio", sample_rate: "48000" },
    ],
    format: {
      duration: "10",
      format_name: "mov,mp4,m4a,3gp,3g2,mj2",
    },
  });

  const result = await createService(createSpawn(output).spawn).verifyMaster(
    {
      path: "/safe/master.mp4",
      expectedDurationSeconds: 10,
      captionsExpected: false,
    },
    new AbortController().signal,
  );

  assert.equal(result.subtitleCodec, null);
});

test("accepts inclusive frame-rate and duration tolerance boundaries", async () => {
  const output = JSON.stringify({
    streams: [
      {
        codec_name: "h264",
        codec_type: "video",
        width: 1080,
        height: 1920,
        pix_fmt: "yuv420p",
        r_frame_rate: "2999/100",
      },
      { codec_name: "aac", codec_type: "audio", sample_rate: "48000" },
    ],
    format: {
      duration: "10.2",
      format_name: "mov,mp4,m4a,3gp,3g2,mj2",
    },
  });

  await createService(createSpawn(output).spawn).verifyMaster(
    {
      path: "/safe/master.mp4",
      expectedDurationSeconds: 10,
      captionsExpected: false,
    },
    new AbortController().signal,
  );
});

test("uses a valid AAC stream when another AAC stream is malformed", async () => {
  const output = JSON.stringify({
    streams: [
      {
        codec_name: "h264",
        codec_type: "video",
        width: 1080,
        height: 1920,
        pix_fmt: "yuv420p",
        r_frame_rate: "30/1",
      },
      { codec_name: "aac", codec_type: "audio", sample_rate: "44100" },
      { codec_name: "aac", codec_type: "audio", sample_rate: "48000" },
    ],
    format: {
      duration: "10",
      format_name: "mov,mp4,m4a,3gp,3g2,mj2",
    },
  });

  const result = await createService(createSpawn(output).spawn).verifyMaster(
    {
      path: "/safe/master.mp4",
      expectedDurationSeconds: 10,
      captionsExpected: false,
    },
    new AbortController().signal,
  );

  assert.deepEqual(result.audio, { codec: "aac", sampleRate: 48000 });
});

test("rejects invalid rational frame rates instead of accepting non-finite values", async () => {
  for (const frameRate of ["30/0", "NaN/1", "Infinity/1", "not-a-rate"]) {
    const output = JSON.stringify({
      streams: [
        {
          codec_name: "h264",
          codec_type: "video",
          width: 1080,
          height: 1920,
          pix_fmt: "yuv420p",
          r_frame_rate: frameRate,
        },
        { codec_name: "aac", codec_type: "audio", sample_rate: "48000" },
      ],
      format: {
        duration: "10",
        format_name: "mov,mp4,m4a,3gp,3g2,mj2",
      },
    });

    await assert.rejects(
      createService(createSpawn(output).spawn).verifyMaster(
        {
          path: "/safe/master.mp4",
          expectedDurationSeconds: 10,
          captionsExpected: false,
        },
        new AbortController().signal,
      ),
      (error: unknown) => {
        assertErrorCode(error, "OUTPUT_MEDIA_INVALID");
        return true;
      },
    );
  }
});

test("terminates ffprobe when the caller aborts", async () => {
  const fake = createPendingSpawn();
  const controller = new AbortController();
  const pending = createService(fake.spawn).probeVideo(
    "/safe/source.mp4",
    controller.signal,
  );

  await new Promise<void>((resolve) => queueMicrotask(resolve));
  controller.abort();
  assert.deepEqual(fake.children[0]?.killSignals, ["SIGTERM"]);
  fake.children[0]?.finish(null, "SIGTERM");

  await assert.rejects(pending, (error: unknown) => {
    assertErrorCode(error, "WORKER_SHUTDOWN");
    return true;
  });
});
