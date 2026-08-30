import * as assert from "node:assert/strict";
import { test } from "node:test";

import { RovelleAssetStatus } from "../generated/prisma/client";
import { hashRenderSpec, type RenderSpecV1 } from "../rovelle/render/render-spec";
import { RenderWorkerError } from "./media-transfer.service";
import type { RenderWorkspace } from "./temp-workspace.service";
import {
  RenderJobProcessor,
  type RenderJobProcessorConfig,
} from "./render-job.processor";
import type { ClaimedRenderJob } from "./render-worker.repository";

const JOB_ID = "750e8400-e29b-41d4-a716-446655440000";
const RENDER_ID = "650e8400-e29b-41d4-a716-446655440000";
const EPISODE_ID = "550e8400-e29b-41d4-a716-446655440000";
const LEASE_TOKEN = "950e8400-e29b-41d4-a716-446655440000";
const OUTPUT_ID = "850e8400-e29b-41d4-a716-446655440000";

const renderSpec: RenderSpecV1 = {
  version: 1,
  profile: "VERTICAL_SHORT_V1",
  output: {
    container: "mp4",
    width: 1080,
    height: 1920,
    frameRate: 30,
    videoCodec: "libx264",
    pixelFormat: "yuv420p",
    audioCodec: "aac",
    audioSampleRate: 48000,
  },
  shots: [],
  audio: {
    assetId: "a50e8400-e29b-41d4-a716-446655440000",
    mediaType: "audio/mpeg",
    byteSize: "10",
    etag: null,
  },
  captions: null,
};

const workspace: RenderWorkspace = {
  root: "/tmp/render-worker/750e8400-e29b-41d4-a716-446655440000",
  shotsDir: "/tmp/render-worker/750e8400-e29b-41d4-a716-446655440000/shots",
  normalizedDir: "/tmp/render-worker/750e8400-e29b-41d4-a716-446655440000/normalized",
  audioPath: "/tmp/render-worker/750e8400-e29b-41d4-a716-446655440000/audio.source",
  captionVttPath: "/tmp/render-worker/750e8400-e29b-41d4-a716-446655440000/captions.vtt",
  captionSrtPath: "/tmp/render-worker/750e8400-e29b-41d4-a716-446655440000/captions.srt",
  concatListPath: "/tmp/render-worker/750e8400-e29b-41d4-a716-446655440000/concat.txt",
  concatenatedVideoPath: "/tmp/render-worker/750e8400-e29b-41d4-a716-446655440000/video-concat.mp4",
  finalOutputPath: "/tmp/render-worker/750e8400-e29b-41d4-a716-446655440000/master.mp4",
};

type FailureCall = {
  jobId: string;
  leaseToken: string;
  errorCode: string;
  errorMessage: string;
};

type Event = { kind: string; input?: unknown };

type HarnessOptions = {
  claim?: ClaimedRenderJob;
  failJob?: (call: FailureCall) => Promise<"failed" | "lease_lost">;
  completeJob?: (call: unknown) => Promise<"completed" | "lease_lost">;
  heartbeat?: () => Promise<boolean>;
  downloadFrozenAsset?: (input: { expected: unknown; destinationPath: string }) => Promise<void>;
  probeVideo?: (path: string, signal: AbortSignal) => Promise<unknown>;
  normalizeShot?: (input: unknown, signal: AbortSignal) => Promise<void>;
  concatenate?: (inputPaths: string[], listPath: string, outputPath: string, signal: AbortSignal) => Promise<void>;
  muxFinal?: (input: unknown, signal: AbortSignal) => Promise<void>;
  verifyMaster?: (input: unknown, signal: AbortSignal) => Promise<unknown>;
  uploadRenderOutput?: (input: { storageKey: string; sourcePath: string }) => Promise<{ byteSize: bigint; etag: string | null }>;
  removeWorkspace?: () => Promise<void>;
};

function claimWith(overrides: Partial<ClaimedRenderJob> = {}): ClaimedRenderJob {
  return {
    jobId: JOB_ID,
    renderId: RENDER_ID,
    episodeId: EPISODE_ID,
    leaseToken: LEASE_TOKEN,
    workerId: "worker-a",
    renderSpec,
    specHash: hashRenderSpec(renderSpec),
    outputAsset: {
      id: OUTPUT_ID,
      storageKey: "rovelle/private/output.mp4",
      status: RovelleAssetStatus.RESERVED,
      mediaType: "video/mp4",
    },
    ...overrides,
  };
}

function asset(assetId: string, mediaType: string) {
  return { assetId, mediaType, byteSize: "10", etag: `etag-${assetId}` };
}

function specWith(
  overrides: Partial<Pick<RenderSpecV1, "shots" | "audio" | "captions">> = {},
): RenderSpecV1 {
  return {
    ...renderSpec,
    ...overrides,
  };
}

function createHarness(input: HarnessOptions = {}) {
  const events: Event[] = [];
  const failures: FailureCall[] = [];
  let terminateCalls = 0;
  let removals = 0;
  const repository = {
    heartbeat: async (call: unknown) => {
      events.push({ kind: "heartbeat", input: call });
      return input.heartbeat ? input.heartbeat() : true;
    },
    completeJob: async (call: unknown) => {
      events.push({ kind: "complete", input: call });
      return input.completeJob ? input.completeJob(call) : ("completed" as const);
    },
    failJob: async (call: FailureCall) => {
      events.push({ kind: "fail", input: call });
      failures.push(call);
      return input.failJob ? input.failJob(call) : ("failed" as const);
    },
  };
  const workspaceService = {
    create: async () => {
      events.push({ kind: "workspace.create" });
      return workspace;
    },
    remove: async () => {
      removals++;
      events.push({ kind: "workspace.remove" });
      if (input.removeWorkspace) await input.removeWorkspace();
    },
  };
  const mediaTransfer = {
    downloadFrozenAsset: async (call: { expected: unknown; destinationPath: string }) => {
      events.push({ kind: "download", input: call });
      if (input.downloadFrozenAsset) await input.downloadFrozenAsset(call);
    },
    uploadRenderOutput: async (call: { storageKey: string; sourcePath: string }) => {
      events.push({ kind: "upload", input: call });
      return input.uploadRenderOutput
        ? input.uploadRenderOutput(call)
        : { byteSize: 20n, etag: "etag" };
    },
  };
  const ffmpegRunner = {
    normalizeShot: async (call: unknown, signal: AbortSignal) => {
      events.push({ kind: "normalize", input: call });
      if (input.normalizeShot) await input.normalizeShot(call, signal);
    },
    concatenate: async (inputPaths: string[], listPath: string, outputPath: string, signal: AbortSignal) => {
      events.push({ kind: "concatenate", input: { inputPaths, listPath, outputPath } });
      if (input.concatenate) await input.concatenate(inputPaths, listPath, outputPath, signal);
    },
    muxFinal: async (call: unknown, signal: AbortSignal) => {
      events.push({ kind: "mux", input: call });
      if (input.muxFinal) await input.muxFinal(call, signal);
    },
    terminateActiveProcess: () => {
      terminateCalls++;
      events.push({ kind: "terminate" });
    },
  };
  const ffprobeService = {
    probeVideo: async (path: string, signal: AbortSignal) => {
      events.push({ kind: "probe", input: path });
      return input.probeVideo
        ? input.probeVideo(path, signal)
        : {
            codec: "h264",
            width: 1080,
            height: 1920,
            pixelFormat: "yuv420p",
            frameRate: 30,
            durationSeconds: 1,
          };
    },
    verifyMaster: async (call: unknown, signal: AbortSignal) => {
      events.push({ kind: "verify", input: call });
      return input.verifyMaster
        ? input.verifyMaster(call, signal)
        : {
            video: {
              codec: "h264",
              width: 1080,
              height: 1920,
              pixelFormat: "yuv420p",
              frameRate: 30,
              durationSeconds: 1,
            },
            audio: { codec: "aac", sampleRate: 48000 },
            subtitleCodec: null,
            durationSeconds: 1,
          };
    },
  };
  const processor = new RenderJobProcessor(
    repository as never,
    workspaceService as never,
    mediaTransfer as never,
    ffmpegRunner as never,
    ffprobeService as never,
    { leaseSeconds: 120, heartbeatSeconds: 30 } satisfies RenderJobProcessorConfig,
  );

  return {
    processor,
    claim: input.claim ?? claimWith(),
    events,
    failures,
    get terminateCalls() {
      return terminateCalls;
    },
    get removals() {
      return removals;
    },
  };
}

test("fails an active job before downloading when the render spec hash mismatches", async () => {
  const harness = createHarness({ claim: claimWith({ specHash: "wrong" }) });

  const result = await harness.processor.process(
    harness.claim,
    new AbortController().signal,
  );

  assert.deepEqual(result, { outcome: "failed" });
  assert.equal(harness.events.filter(({ kind }) => kind === "download").length, 0);
  assert.equal(harness.removals, 1);
  assert.deepEqual(harness.failures, [
    {
      jobId: JOB_ID,
      leaseToken: LEASE_TOKEN,
      errorCode: "RENDER_SPEC_HASH_MISMATCH",
      errorMessage: "Render spec hash does not match the persisted render",
    },
  ]);
});

test("downloads, probes, and normalizes shots in sequence order before composing", async () => {
  const orderedSpec = specWith({
    shots: [
      {
        sequence: 2,
        shotId: "b50e8400-e29b-41d4-a716-446655440000",
        generationId: "b60e8400-e29b-41d4-a716-446655440000",
        targetDurationSeconds: 3,
        video: asset("b70e8400-e29b-41d4-a716-446655440000", "video/mp4"),
      },
      {
        sequence: 1,
        shotId: "b80e8400-e29b-41d4-a716-446655440000",
        generationId: "b90e8400-e29b-41d4-a716-446655440000",
        targetDurationSeconds: 2,
        video: asset("ba0e8400-e29b-41d4-a716-446655440000", "video/mp4"),
      },
    ],
  });
  const harness = createHarness({
    claim: claimWith({ renderSpec: orderedSpec, specHash: hashRenderSpec(orderedSpec) }),
  });

  const result = await harness.processor.process(
    harness.claim,
    new AbortController().signal,
  );

  assert.deepEqual(result, { outcome: "completed" });
  assert.deepEqual(
    harness.events.map(({ kind }) => kind),
    [
      "workspace.create",
      "download",
      "probe",
      "normalize",
      "download",
      "probe",
      "normalize",
      "download",
      "concatenate",
      "mux",
      "verify",
      "upload",
      "complete",
      "workspace.remove",
    ],
  );
  const downloads = harness.events.filter(({ kind }) => kind === "download");
  assert.deepEqual(downloads.map(({ input }) => input), [
    {
      expected: orderedSpec.shots[1]?.video,
      destinationPath: `${workspace.shotsDir}/shot-0001.source`,
    },
    {
      expected: orderedSpec.shots[0]?.video,
      destinationPath: `${workspace.shotsDir}/shot-0002.source`,
    },
    {
      expected: orderedSpec.audio,
      destinationPath: workspace.audioPath,
    },
  ]);
  const normalizations = harness.events.filter(({ kind }) => kind === "normalize");
  assert.deepEqual(normalizations.map(({ input }) => input), [
    {
      sourcePath: `${workspace.shotsDir}/shot-0001.source`,
      outputPath: `${workspace.normalizedDir}/shot-0001.mp4`,
      durationSeconds: 2,
    },
    {
      sourcePath: `${workspace.shotsDir}/shot-0002.source`,
      outputPath: `${workspace.normalizedDir}/shot-0002.mp4`,
      durationSeconds: 3,
    },
  ]);
  assert.deepEqual(harness.events.find(({ kind }) => kind === "probe")?.input, `${workspace.shotsDir}/shot-0001.source`);
  assert.deepEqual(
    harness.events.find(({ kind }) => kind === "concatenate")?.input,
    {
      inputPaths: [
        `${workspace.normalizedDir}/shot-0001.mp4`,
        `${workspace.normalizedDir}/shot-0002.mp4`,
      ],
      listPath: workspace.concatListPath,
      outputPath: workspace.concatenatedVideoPath,
    },
  );
  assert.deepEqual(harness.events.find(({ kind }) => kind === "mux")?.input, {
    concatenatedVideoPath: workspace.concatenatedVideoPath,
    audioPath: workspace.audioPath,
    captionPath: null,
    captionFormat: null,
    durationSeconds: 5,
    outputPath: workspace.finalOutputPath,
  });
  assert.deepEqual(harness.events.find(({ kind }) => kind === "verify")?.input, {
    path: workspace.finalOutputPath,
    expectedDurationSeconds: 5,
    captionsExpected: false,
  });
  assert.deepEqual(harness.events.find(({ kind }) => kind === "upload")?.input, {
    storageKey: "rovelle/private/output.mp4",
    sourcePath: workspace.finalOutputPath,
  });
  assert.deepEqual(harness.events.find(({ kind }) => kind === "complete")?.input, {
    jobId: JOB_ID,
    leaseToken: LEASE_TOKEN,
    byteSize: 20n,
    etag: "etag",
  });
});

test("downloads WEBVTT captions to the generated VTT path and forwards the format", async () => {
  const caption = {
    ...asset("c50e8400-e29b-41d4-a716-446655440000", "text/vtt"),
    format: "WEBVTT" as const,
  };
  const spec = specWith({
    shots: [
      {
        sequence: 1,
        shotId: "c60e8400-e29b-41d4-a716-446655440000",
        generationId: "c70e8400-e29b-41d4-a716-446655440000",
        targetDurationSeconds: 4,
        video: asset("c80e8400-e29b-41d4-a716-446655440000", "video/mp4"),
      },
    ],
    captions: caption,
  });
  const harness = createHarness({
    claim: claimWith({ renderSpec: spec, specHash: hashRenderSpec(spec) }),
  });

  assert.deepEqual(
    await harness.processor.process(harness.claim, new AbortController().signal),
    { outcome: "completed" },
  );
  assert.deepEqual(harness.events.filter(({ kind }) => kind === "download").at(-1)?.input, {
    expected: caption,
    destinationPath: workspace.captionVttPath,
  });
  assert.deepEqual(harness.events.find(({ kind }) => kind === "mux")?.input, {
    concatenatedVideoPath: workspace.concatenatedVideoPath,
    audioPath: workspace.audioPath,
    captionPath: workspace.captionVttPath,
    captionFormat: "WEBVTT",
    durationSeconds: 4,
    outputPath: workspace.finalOutputPath,
  });
  assert.deepEqual(harness.events.find(({ kind }) => kind === "verify")?.input, {
    path: workspace.finalOutputPath,
    expectedDurationSeconds: 4,
    captionsExpected: true,
  });
});

test("downloads SRT captions to the generated SRT path without using an original filename", async () => {
  const caption = {
    ...asset("d50e8400-e29b-41d4-a716-446655440000", "application/x-subrip"),
    format: "SRT" as const,
  };
  const spec = specWith({
    shots: [
      {
        sequence: 1,
        shotId: "d60e8400-e29b-41d4-a716-446655440000",
        generationId: "d70e8400-e29b-41d4-a716-446655440000",
        targetDurationSeconds: 2,
        video: asset("d80e8400-e29b-41d4-a716-446655440000", "video/mp4"),
      },
    ],
    captions: caption,
  });
  const harness = createHarness({
    claim: claimWith({ renderSpec: spec, specHash: hashRenderSpec(spec) }),
  });

  assert.deepEqual(
    await harness.processor.process(harness.claim, new AbortController().signal),
    { outcome: "completed" },
  );
  assert.deepEqual(harness.events.filter(({ kind }) => kind === "download").at(-1)?.input, {
    expected: caption,
    destinationPath: workspace.captionSrtPath,
  });
  assert.equal(
    String(harness.events.find(({ kind }) => kind === "mux")?.input).includes("original"),
    false,
  );
});

test("fails a spec whose total shot duration is not a positive integer before media work", async () => {
  const spec = specWith({ shots: [] });
  const harness = createHarness({
    claim: claimWith({ renderSpec: spec, specHash: hashRenderSpec(spec) }),
  });

  assert.deepEqual(
    await harness.processor.process(harness.claim, new AbortController().signal),
    { outcome: "failed" },
  );
  assert.equal(harness.events.some(({ kind }) => kind === "download"), false);
  assert.deepEqual(harness.failures, [
    {
      jobId: JOB_ID,
      leaseToken: LEASE_TOKEN,
      errorCode: "RENDER_SPEC_INVALID",
      errorMessage: "Render duration must be a positive integer",
    },
  ]);
});

test("aborts active work and returns lease_lost when a heartbeat loses ownership", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  try {
    const spec = specWith({
      shots: [
        {
          sequence: 1,
          shotId: "e60e8400-e29b-41d4-a716-446655440000",
          generationId: "e70e8400-e29b-41d4-a716-446655440000",
          targetDurationSeconds: 2,
          video: asset("e80e8400-e29b-41d4-a716-446655440000", "video/mp4"),
        },
      ],
    });
    let normalizeStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      normalizeStarted = resolve;
    });
    const harness = createHarness({
      claim: claimWith({ renderSpec: spec, specHash: hashRenderSpec(spec) }),
      heartbeat: async () => false,
      normalizeShot: async (_input, signal) => {
        normalizeStarted();
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new RenderWorkerError("WORKER_SHUTDOWN", "aborted")),
            { once: true },
          );
        });
      },
    });

    const pending = harness.processor.process(
      harness.claim,
      new AbortController().signal,
    );
    await started;
    t.mock.timers.tick(30_000);
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    assert.deepEqual(await pending, { outcome: "lease_lost" });
    assert.deepEqual(harness.events.find(({ kind }) => kind === "heartbeat")?.input, {
      jobId: JOB_ID,
      leaseToken: LEASE_TOKEN,
      leaseSeconds: 120,
    });
    assert.equal(harness.terminateCalls, 1);
    assert.equal(harness.failures.length, 0);
    assert.equal(harness.events.some(({ kind }) => kind === "complete"), false);

    t.mock.timers.tick(30_000);
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    assert.equal(harness.events.filter(({ kind }) => kind === "heartbeat").length, 1);
  } finally {
    t.mock.timers.reset();
  }
});

test("persists WORKER_SHUTDOWN while the lease is active and cleans the workspace", async () => {
  const spec = specWith({
    shots: [
      {
        sequence: 1,
        shotId: "f60e8400-e29b-41d4-a716-446655440000",
        generationId: "f70e8400-e29b-41d4-a716-446655440000",
        targetDurationSeconds: 2,
        video: asset("f80e8400-e29b-41d4-a716-446655440000", "video/mp4"),
      },
    ],
  });
  let normalizeStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    normalizeStarted = resolve;
  });
  const harness = createHarness({
    claim: claimWith({ renderSpec: spec, specHash: hashRenderSpec(spec) }),
    normalizeShot: async (_input, signal) => {
      normalizeStarted();
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => reject(new RenderWorkerError("WORKER_SHUTDOWN", "aborted")),
          { once: true },
        );
      });
    },
  });
  const shutdown = new AbortController();
  const pending = harness.processor.process(harness.claim, shutdown.signal);

  await started;
  shutdown.abort();

  assert.deepEqual(await pending, { outcome: "shutdown" });
  assert.equal(harness.terminateCalls, 1);
  assert.equal(harness.removals, 1);
  assert.deepEqual(harness.failures, [
    {
      jobId: JOB_ID,
      leaseToken: LEASE_TOKEN,
      errorCode: "WORKER_SHUTDOWN",
      errorMessage: "Worker shutdown",
    },
  ]);
});

function singleShotSpec(): RenderSpecV1 {
  return specWith({
    shots: [
      {
        sequence: 1,
        shotId: "a60e8400-e29b-41d4-a716-446655440000",
        generationId: "a70e8400-e29b-41d4-a716-446655440000",
        targetDurationSeconds: 2,
        video: asset("a80e8400-e29b-41d4-a716-446655440000", "video/mp4"),
      },
    ],
  });
}

for (const failureCase of [
  {
    name: "source download mismatch",
    error: new RenderWorkerError(
      "SOURCE_SIZE_MISMATCH",
      "Frozen asset size does not match its metadata",
    ),
    configure: (options: HarnessOptions, error: RenderWorkerError) => {
      options.downloadFrozenAsset = async () => {
        throw error;
      };
    },
  },
  {
    name: "corrupt source input",
    error: new RenderWorkerError("OUTPUT_MEDIA_INVALID", "A video stream is required"),
    configure: (options: HarnessOptions, error: RenderWorkerError) => {
      options.probeVideo = async () => {
        throw error;
      };
    },
  },
  {
    name: "FFmpeg failure",
    error: new RenderWorkerError("FFMPEG_FAILED", "FFmpeg failed"),
    configure: (options: HarnessOptions, error: RenderWorkerError) => {
      options.normalizeShot = async () => {
        throw error;
      };
    },
  },
  {
    name: "invalid final media",
    error: new RenderWorkerError("OUTPUT_MEDIA_INVALID", "Final media does not match the render contract"),
    configure: (options: HarnessOptions, error: RenderWorkerError) => {
      options.verifyMaster = async () => {
        throw error;
      };
    },
  },
  {
    name: "output upload failure",
    error: new RenderWorkerError("OUTPUT_UPLOAD_FAILED", "Render output upload failed"),
    configure: (options: HarnessOptions, error: RenderWorkerError) => {
      options.uploadRenderOutput = async () => {
        throw error;
      };
    },
  },
] satisfies Array<{
  name: string;
  error: RenderWorkerError;
  configure: (options: HarnessOptions, error: RenderWorkerError) => void;
}>) {
  test(`fails once for ${failureCase.name} while keeping the output reserved`, async () => {
    const spec = singleShotSpec();
    const options: HarnessOptions = {
      claim: claimWith({ renderSpec: spec, specHash: hashRenderSpec(spec) }),
    };
    failureCase.configure(options, failureCase.error);
    const harness = createHarness(options);

    assert.deepEqual(
      await harness.processor.process(harness.claim, new AbortController().signal),
      { outcome: "failed" },
    );
    assert.equal(harness.failures.length, 1);
    assert.deepEqual(harness.failures[0], {
      jobId: JOB_ID,
      leaseToken: LEASE_TOKEN,
      errorCode: failureCase.error.code,
      errorMessage: failureCase.error.message,
    });
    assert.equal(harness.events.filter(({ kind }) => kind === "complete").length, 0);
    assert.equal(harness.removals, 1);
  });
}

test("returns lease_lost when failure persistence discovers the lease is gone", async () => {
  const spec = singleShotSpec();
  const harness = createHarness({
    claim: claimWith({ renderSpec: spec, specHash: hashRenderSpec(spec) }),
    failJob: async () => "lease_lost",
    downloadFrozenAsset: async () => {
      throw new RenderWorkerError("SOURCE_DOWNLOAD_FAILED", "Frozen asset download failed");
    },
  });

  assert.deepEqual(
    await harness.processor.process(harness.claim, new AbortController().signal),
    { outcome: "lease_lost" },
  );
  assert.equal(harness.failures.length, 1);
  assert.equal(harness.events.some(({ kind }) => kind === "complete"), false);
});

test("does not change a committed result when workspace cleanup fails", async () => {
  const spec = singleShotSpec();
  const harness = createHarness({
    claim: claimWith({ renderSpec: spec, specHash: hashRenderSpec(spec) }),
    removeWorkspace: async () => {
      throw new Error("cleanup failed");
    },
  });

  assert.deepEqual(
    await harness.processor.process(harness.claim, new AbortController().signal),
    { outcome: "completed" },
  );
  assert.equal(harness.failures.length, 0);
  assert.equal(harness.removals, 1);
});

test("does not complete an uploaded output after lease loss during upload", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  try {
    const spec = singleShotSpec();
    let uploadStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      uploadStarted = resolve;
    });
    let releaseUpload!: () => void;
    const uploadReleased = new Promise<void>((resolve) => {
      releaseUpload = resolve;
    });
    const harness = createHarness({
      claim: claimWith({ renderSpec: spec, specHash: hashRenderSpec(spec) }),
      heartbeat: async () => false,
      uploadRenderOutput: async () => {
        uploadStarted();
        await uploadReleased;
        return { byteSize: 20n, etag: "etag" };
      },
    });
    const pending = harness.processor.process(
      harness.claim,
      new AbortController().signal,
    );

    await started;
    t.mock.timers.tick(30_000);
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    releaseUpload();

    assert.deepEqual(await pending, { outcome: "lease_lost" });
    assert.equal(harness.failures.length, 0);
    assert.equal(harness.events.some(({ kind }) => kind === "complete"), false);
  } finally {
    t.mock.timers.reset();
  }
});

test("returns lease_lost without failing again when completion loses the lease", async () => {
  const spec = singleShotSpec();
  const harness = createHarness({
    claim: claimWith({ renderSpec: spec, specHash: hashRenderSpec(spec) }),
    completeJob: async () => "lease_lost",
  });

  assert.deepEqual(
    await harness.processor.process(harness.claim, new AbortController().signal),
    { outcome: "lease_lost" },
  );
  assert.equal(harness.failures.length, 0);
  assert.equal(harness.events.filter(({ kind }) => kind === "complete").length, 1);
});
