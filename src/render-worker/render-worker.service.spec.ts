import * as assert from "node:assert/strict";
import { test } from "node:test";

import type {
  ClaimedRenderJob,
  RenderWorkerRepository,
} from "./render-worker.repository";
import {
  RenderWorkerService,
  renderWorkerSleep,
  type RenderWorkerSleep,
} from "./render-worker.service";
import type { RenderJobProcessor } from "./render-job.processor";
import type { TempWorkspaceService } from "./temp-workspace.service";
import type { RenderWorkerConfig } from "./worker-config";
import type { FfmpegRunner } from "./ffmpeg-runner";
import type { FfprobeService } from "./ffprobe.service";

const JOB_ONE = {
  jobId: "750e8400-e29b-41d4-a716-446655440000",
  renderId: "650e8400-e29b-41d4-a716-446655440000",
} as unknown as ClaimedRenderJob;
const JOB_TWO = {
  jobId: "850e8400-e29b-41d4-a716-446655440000",
  renderId: "950e8400-e29b-41d4-a716-446655440000",
} as unknown as ClaimedRenderJob;

const config: RenderWorkerConfig = {
  workerId: "worker-test",
  pollMs: 321,
  leaseSeconds: 120,
  heartbeatSeconds: 30,
  recoverySeconds: 10,
  tempDir: "/tmp/rovelle-render-worker",
  ffmpegPath: "/usr/bin/ffmpeg",
  ffprobePath: "/usr/bin/ffprobe",
};

type HarnessOptions = {
  claims?: Array<ClaimedRenderJob | null>;
  onClaim?: () => void;
  process?: (
    job: ClaimedRenderJob,
    signal: AbortSignal,
  ) => Promise<{ outcome: "completed" | "failed" | "lease_lost" | "shutdown" }>;
  sleep?: RenderWorkerSleep;
  verifyFfmpeg?: () => Promise<void>;
  verifyFfprobe?: () => Promise<void>;
  recover?: () => Promise<number>;
  cleanupStale?: () => Promise<number>;
};

function createHarness(options: HarnessOptions = {}) {
  const events: string[] = [];
  const claims = [...(options.claims ?? [])];
  let worker!: RenderWorkerService;
  let terminateCalls = 0;
  let recoveries = 0;

  const repository = {
    claimNext: async () => {
      events.push("claim");
      options.onClaim?.();
      return claims.length > 0 ? claims.shift()! : null;
    },
    recoverExpiredLeases: async () => {
      events.push("recover");
      recoveries++;
      return options.recover ? options.recover() : 0;
    },
  };
  const processor = {
    process: async (job: ClaimedRenderJob, signal: AbortSignal) => {
      events.push(`process:${job.jobId}`);
      return options.process
        ? options.process(job, signal)
        : ({ outcome: "completed" } as const);
    },
  };
  const workspaceService = {
    cleanupStale: async () => {
      events.push("cleanup");
      return options.cleanupStale ? options.cleanupStale() : 0;
    },
  };
  const ffmpegRunner = {
    verifyBinary: async () => {
      events.push("ffmpeg");
      if (options.verifyFfmpeg) await options.verifyFfmpeg();
    },
    terminateActiveProcess: () => {
      terminateCalls++;
      events.push("terminate");
    },
  };
  const ffprobeService = {
    verifyBinary: async () => {
      events.push("ffprobe");
      if (options.verifyFfprobe) await options.verifyFfprobe();
    },
  };

  worker = new RenderWorkerService(
    repository as unknown as RenderWorkerRepository,
    processor as unknown as RenderJobProcessor,
    workspaceService as unknown as TempWorkspaceService,
    ffmpegRunner as unknown as FfmpegRunner,
    ffprobeService as unknown as FfprobeService,
    config,
    options.sleep,
  );

  return {
    worker,
    events,
    get recoveries() {
      return recoveries;
    },
    get terminateCalls() {
      return terminateCalls;
    },
  };
}

async function flushMicrotasks(): Promise<void> {
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  await new Promise<void>((resolve) => queueMicrotask(resolve));
}

test("default idle sleep resolves when its signal is aborted", async () => {
  const controller = new AbortController();
  const pending = renderWorkerSleep(60_000, controller.signal);

  controller.abort();
  await pending;
});

test("runs startup gates in order before the first claim", async () => {
  let worker!: RenderWorkerService;
  const harness = createHarness({
    claims: [null],
    onClaim: () => worker.requestShutdown(),
  });
  worker = harness.worker;

  await harness.worker.run();

  assert.deepEqual(harness.events, [
    "cleanup",
    "ffmpeg",
    "ffprobe",
    "recover",
    "claim",
    "terminate",
  ]);
});

test("does not claim when startup binary verification fails", async () => {
  const harness = createHarness({
    claims: [JOB_ONE],
    verifyFfmpeg: async () => {
      throw new Error("configured ffmpeg is unavailable");
    },
  });

  await assert.rejects(
    harness.worker.run(),
    /configured ffmpeg is unavailable/,
  );
  assert.deepEqual(harness.events, ["cleanup", "ffmpeg"]);
});

test("does not claim a second job while the current processor is pending", async () => {
  let releaseFirst!: () => void;
  const firstFinished = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let firstStarted!: () => void;
  const firstStartedPromise = new Promise<void>((resolve) => {
    firstStarted = resolve;
  });
  let releaseSecond!: () => void;
  const secondFinished = new Promise<void>((resolve) => {
    releaseSecond = resolve;
  });
  let secondStarted!: () => void;
  const secondStartedPromise = new Promise<void>((resolve) => {
    secondStarted = resolve;
  });

  const harness = createHarness({
    claims: [JOB_ONE, JOB_TWO, null],
    process: async (job) => {
      if (job === JOB_ONE) {
        firstStarted();
        await firstFinished;
      } else {
        secondStarted();
        await secondFinished;
      }
      return { outcome: "completed" };
    },
  });

  const run = harness.worker.run();
  await firstStartedPromise;
  assert.equal(harness.events.filter((event) => event === "claim").length, 1);

  releaseFirst();
  await secondStartedPromise;
  assert.equal(harness.events.filter((event) => event === "claim").length, 2);

  releaseSecond();
  await flushMicrotasks();
  harness.worker.requestShutdown();
  await run;
});

test("sleeps for the configured poll interval and idle shutdown resolves promptly", async () => {
  const sleeps: Array<{ delayMs: number; signal: AbortSignal }> = [];
  const sleep: RenderWorkerSleep = (delayMs, signal) =>
    new Promise<void>((resolve) => {
      sleeps.push({ delayMs, signal });
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
  const harness = createHarness({ claims: [null], sleep });

  const run = harness.worker.run();
  while (sleeps.length === 0) await flushMicrotasks();

  assert.equal(sleeps[0]?.delayMs, config.pollMs);
  assert.equal(sleeps[0]?.signal.aborted, false);
  harness.worker.requestShutdown();

  await run;
  assert.equal(sleeps[0]?.signal.aborted, true);
});

test("recovers on its interval while a job is busy", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  try {
    let release!: () => void;
    const finished = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    const harness = createHarness({
      claims: [JOB_ONE],
      process: async () => {
        started();
        await finished;
        return { outcome: "completed" };
      },
    });

    const run = harness.worker.run();
    await startedPromise;
    assert.equal(harness.recoveries, 1);

    t.mock.timers.tick(config.recoverySeconds * 1000);
    await flushMicrotasks();
    assert.equal(harness.recoveries, 2);

    t.mock.timers.tick(config.recoverySeconds * 1000);
    await flushMicrotasks();
    assert.equal(harness.recoveries, 3);

    harness.worker.requestShutdown();
    release();
    await run;
  } finally {
    t.mock.timers.reset();
  }
});

test("recovers on its interval while the queue is idle", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  try {
    const sleep: RenderWorkerSleep = (_delayMs, signal) =>
      new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
    const harness = createHarness({ claims: [null], sleep });
    const run = harness.worker.run();
    await flushMicrotasks();
    assert.equal(harness.recoveries, 1);

    t.mock.timers.tick(config.recoverySeconds * 1000);
    await flushMicrotasks();
    assert.equal(harness.recoveries, 2);

    harness.worker.requestShutdown();
    await run;
  } finally {
    t.mock.timers.reset();
  }
});

test("shutdown is idempotent, aborts the current processor, and prevents another claim", async () => {
  let shutdownObserved!: () => void;
  const shutdownPromise = new Promise<void>((resolve) => {
    shutdownObserved = resolve;
  });
  let started!: () => void;
  const startedPromise = new Promise<void>((resolve) => {
    started = resolve;
  });
  const harness = createHarness({
    claims: [JOB_ONE, JOB_TWO],
    process: async (_job, signal) => {
      started();
      await new Promise<void>((resolve) => {
        signal.addEventListener(
          "abort",
          () => {
            shutdownObserved();
            resolve();
          },
          { once: true },
        );
      });
      return { outcome: "shutdown" };
    },
  });

  const run = harness.worker.run();
  await startedPromise;
  harness.worker.requestShutdown();
  harness.worker.requestShutdown();
  await shutdownPromise;
  await run;

  assert.equal(harness.events.filter((event) => event === "claim").length, 1);
  assert.equal(harness.terminateCalls, 1);
});
