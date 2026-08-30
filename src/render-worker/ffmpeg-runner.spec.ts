import * as assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  FfmpegRunner,
  type FfmpegSpawn,
  type FfmpegSpawnOptions,
  type FinalMuxInput,
} from "./ffmpeg-runner";
import { RenderWorkerError } from "./media-transfer.service";

const FFMPEG_PATH = "/opt/bin/ffmpeg";

class FakeChild extends EventEmitter {
  readonly stderr = new PassThrough();
  readonly killSignals: NodeJS.Signals[] = [];

  kill(signal?: NodeJS.Signals): boolean {
    if (signal) this.killSignals.push(signal);
    return true;
  }

  finish(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.stderr.end();
    this.emit("close", code, signal);
  }
}

interface SpawnCall {
  command: string;
  args: string[];
  options: FfmpegSpawnOptions;
}

function createSpawn(exitCode = 0, stderr = "") {
  const calls: SpawnCall[] = [];
  const children: FakeChild[] = [];
  const spawn: FfmpegSpawn = (command, args, options) => {
    const child = new FakeChild();
    calls.push({ command, args, options });
    children.push(child);
    queueMicrotask(() => {
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
  const spawn: FfmpegSpawn = (command, args, options) => {
    const child = new FakeChild();
    calls.push({ command, args, options });
    children.push(child);
    return child;
  };
  return { calls, children, spawn };
}

function createRunner(spawn: FfmpegSpawn): FfmpegRunner {
  return new FfmpegRunner({ ffmpegPath: FFMPEG_PATH }, spawn);
}

function assertFfmpegFailure(
  error: unknown,
): asserts error is RenderWorkerError {
  assert.ok(error instanceof RenderWorkerError);
  assert.equal(error.code, "FFMPEG_FAILED");
}

function assertWorkerShutdown(
  error: unknown,
): asserts error is RenderWorkerError {
  assert.ok(error instanceof RenderWorkerError);
  assert.equal(error.code, "WORKER_SHUTDOWN");
}

test("runs the configured binary without a shell and keeps argv values separate", async () => {
  const fake = createSpawn();
  const runner = createRunner(fake.spawn);

  await runner.normalizeShot(
    {
      sourcePath: "/safe/generated/source.mp4",
      outputPath: "/safe/generated/normalized.mp4",
      durationSeconds: 5,
    },
    new AbortController().signal,
  );

  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0]?.command, FFMPEG_PATH);
  assert.equal(fake.calls[0]?.options.shell, false);
  assert.deepEqual(fake.calls[0]?.args, [
    "-hide_banner",
    "-nostdin",
    "-y",
    "-i",
    "/safe/generated/source.mp4",
    "-map",
    "0:v:0",
    "-an",
    "-vf",
    "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=30,tpad=stop_mode=clone:stop_duration=5,setpts=PTS-STARTPTS,format=yuv420p",
    "-t",
    "5",
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-crf",
    "18",
    "-pix_fmt",
    "yuv420p",
    "-threads",
    "1",
    "-map_metadata",
    "-1",
    "/safe/generated/normalized.mp4",
  ]);
});

test("verifies ffmpeg with hide_banner and version", async () => {
  const fake = createSpawn();
  await createRunner(fake.spawn).verifyBinary();

  assert.deepEqual(fake.calls[0]?.args, ["-hide_banner", "-version"]);
});

test("rejects non-positive or non-integer shot durations", async () => {
  for (const durationSeconds of [0, -1, 1.5, Infinity, NaN]) {
    const fake = createSpawn();
    const runner = createRunner(fake.spawn);

    await assert.rejects(
      runner.normalizeShot(
        {
          sourcePath: "/safe/source.mp4",
          outputPath: "/safe/output.mp4",
          durationSeconds,
        },
        new AbortController().signal,
      ),
      (error: unknown) => {
        assertFfmpegFailure(error);
        return true;
      },
    );
    assert.equal(fake.calls.length, 0);
  }
});

test("includes only a bounded sanitized stderr tail in ffmpeg failures", async () => {
  const stderr = `prefix-only-diagnostic\n${"x".repeat(20000)}\u001b[31mfinal failure https://secret.example/token\u001b[0m\u0000`;
  const fake = createSpawn(1, stderr);
  const runner = createRunner(fake.spawn);

  await assert.rejects(runner.verifyBinary(), (error: unknown) => {
    assertFfmpegFailure(error);
    assert.ok(error.message.length <= 4000);
    assert.ok(error.message.includes("final failure"));
    assert.equal(error.message.includes("https://secret.example/token"), false);
    assert.ok(error.message.includes("[redacted-url]"));
    assert.equal(error.message.includes("\u001b"), false);
    assert.equal(error.message.includes("\u0000"), false);
    assert.equal(error.message.includes("\n"), false);
    assert.equal(error.message.includes("prefix-only-diagnostic"), false);
    return true;
  });
});

test("writes a safe concat list and invokes concat without audio", async () => {
  const root = await mkdtemp(join(tmpdir(), "ffmpeg-runner-test-"));
  try {
    const listPath = join(root, "concat.txt");
    const fake = createSpawn();
    await createRunner(fake.spawn).concatenate(
      [
        "/safe/generated/shot-0001.mp4",
        "/safe/generated/shot-0002.mp4",
        "/safe/generated/shot-00'03.mp4",
      ],
      listPath,
      "/safe/generated/concat.mp4",
      new AbortController().signal,
    );

    assert.equal(
      await readFile(listPath, "utf8"),
      "file '/safe/generated/shot-0001.mp4'\n" +
        "file '/safe/generated/shot-0002.mp4'\n" +
        "file '/safe/generated/shot-00'\\''03.mp4'\n",
    );
    assert.deepEqual(fake.calls[0]?.args, [
      "-hide_banner",
      "-nostdin",
      "-y",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      listPath,
      "-map",
      "0:v:0",
      "-an",
      "-c:v",
      "copy",
      "-fflags",
      "+genpts",
      "-map_metadata",
      "-1",
      "/safe/generated/concat.mp4",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("requires at least one normalized shot", async () => {
  const fake = createSpawn();
  await assert.rejects(
    createRunner(fake.spawn).concatenate(
      [],
      "/safe/generated/concat.txt",
      "/safe/generated/concat.mp4",
      new AbortController().signal,
    ),
    (error: unknown) => {
      assertFfmpegFailure(error);
      return true;
    },
  );
  assert.equal(fake.calls.length, 0);
});

test("muxes video and padded AAC audio with an authoritative duration", async () => {
  const input: FinalMuxInput = {
    concatenatedVideoPath: "/safe/generated/concat.mp4",
    audioPath: "/safe/generated/audio.source",
    captionPath: null,
    captionFormat: null,
    durationSeconds: 10,
    outputPath: "/safe/generated/master.mp4",
  };
  const fake = createSpawn();

  await createRunner(fake.spawn).muxFinal(input, new AbortController().signal);

  assert.deepEqual(fake.calls[0]?.args, [
    "-hide_banner",
    "-nostdin",
    "-y",
    "-i",
    input.concatenatedVideoPath,
    "-i",
    input.audioPath,
    "-map",
    "0:v:0",
    "-map",
    "1:a:0",
    "-c:v",
    "copy",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-ar",
    "48000",
    "-af",
    "apad",
    "-t",
    "10",
    "-threads",
    "1",
    "-movflags",
    "+faststart",
    "-map_metadata",
    "-1",
    "-metadata",
    "creation_time=",
    input.outputPath,
  ]);
  assert.equal(fake.calls[0]?.args.includes("-shortest"), false);
});

test("adds an optional caption stream and converts it to mov_text", async () => {
  const fake = createSpawn();

  await createRunner(fake.spawn).muxFinal(
    {
      concatenatedVideoPath: "/safe/generated/concat.mp4",
      audioPath: "/safe/generated/audio.source",
      captionPath: "/safe/generated/captions.vtt",
      captionFormat: "WEBVTT",
      durationSeconds: 10,
      outputPath: "/safe/generated/master.mp4",
    },
    new AbortController().signal,
  );

  assert.deepEqual(fake.calls[0]?.args, [
    "-hide_banner",
    "-nostdin",
    "-y",
    "-i",
    "/safe/generated/concat.mp4",
    "-i",
    "/safe/generated/audio.source",
    "-i",
    "/safe/generated/captions.vtt",
    "-map",
    "0:v:0",
    "-map",
    "1:a:0",
    "-map",
    "2:0",
    "-c:v",
    "copy",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-ar",
    "48000",
    "-af",
    "apad",
    "-c:s",
    "mov_text",
    "-metadata:s:s:0",
    "title=Captions",
    "-t",
    "10",
    "-threads",
    "1",
    "-movflags",
    "+faststart",
    "-map_metadata",
    "-1",
    "-metadata",
    "creation_time=",
    "/safe/generated/master.mp4",
  ]);
});

test("sends SIGTERM to an active child when the signal aborts", async () => {
  const fake = createPendingSpawn();
  const controller = new AbortController();
  const pending = createRunner(fake.spawn).normalizeShot(
    {
      sourcePath: "/safe/generated/source.mp4",
      outputPath: "/safe/generated/output.mp4",
      durationSeconds: 5,
    },
    controller.signal,
  );

  await new Promise<void>((resolve) => queueMicrotask(resolve));
  controller.abort();
  assert.deepEqual(fake.children[0]?.killSignals, ["SIGTERM"]);
  fake.children[0]?.finish(null, "SIGTERM");

  await assert.rejects(pending, (error: unknown) => {
    assertWorkerShutdown(error);
    return true;
  });
});

test("terminateActiveProcess sends SIGTERM to only the current child", async () => {
  const fake = createPendingSpawn();
  const runner = createRunner(fake.spawn);
  const pending = runner.verifyBinary();

  await new Promise<void>((resolve) => queueMicrotask(resolve));
  runner.terminateActiveProcess();
  assert.deepEqual(fake.children[0]?.killSignals, ["SIGTERM"]);
  fake.children[0]?.finish(null, "SIGTERM");

  await assert.rejects(pending, (error: unknown) => {
    assertWorkerShutdown(error);
    return true;
  });
});

test("does not start a second ffmpeg child while one is active", async () => {
  const fake = createPendingSpawn();
  const runner = createRunner(fake.spawn);
  const first = runner.verifyBinary();

  await new Promise<void>((resolve) => queueMicrotask(resolve));
  await assert.rejects(runner.verifyBinary(), (error: unknown) => {
    assertFfmpegFailure(error);
    return true;
  });
  assert.equal(fake.children.length, 1);
  fake.children[0]?.finish(0);
  await first;
});
