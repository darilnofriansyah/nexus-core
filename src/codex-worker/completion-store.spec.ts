import * as assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  creativeInput,
  creativeResult,
} from "../rovelle/creative/creative.fixture";
import { hashCreativeValue } from "../rovelle/creative/creative-validation";
import type {
  CreativeClaim,
  CreativeCompletion,
} from "../rovelle/creative/dto/creative.dto";

interface SpoolRecord {
  jobId: string;
  state:
    | "accepted"
    | "claiming"
    | "started"
    | "completed"
    | "acknowledged"
    | "quarantined"
    | "not_claimed";
  claim?: Extract<CreativeClaim, { claimed: true }>;
  completion?: CreativeCompletion;
  deliveryAttempts: number;
  acknowledgedAt?: string | null;
}

interface CompletionStoreApi {
  initialize(): Promise<void>;
  createAccepted(jobId: string, now?: Date): Promise<boolean>;
  markClaiming(jobId: string, now?: Date): Promise<void>;
  markStarted(
    jobId: string,
    claim: Extract<CreativeClaim, { claimed: true }>,
    now?: Date,
  ): Promise<void>;
  markCompleted(
    jobId: string,
    completion: CreativeCompletion,
    now?: Date,
  ): Promise<void>;
  markDeliveryAttempt(jobId: string, now?: Date): Promise<SpoolRecord>;
  markAcknowledged(jobId: string, now?: Date): Promise<void>;
  get(jobId: string): Promise<SpoolRecord | null>;
  list(): Promise<SpoolRecord[]>;
  cleanupAcknowledged(now?: Date): Promise<number>;
}

const { CompletionStore } = require("./completion-store") as {
  CompletionStore: new (
    directory: string,
    maxBytes?: number,
  ) => CompletionStoreApi;
};

const JOB_ID = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-09-12T00:00:00.000Z");
const CLAIM: Extract<CreativeClaim, { claimed: true }> = {
  claimed: true,
  jobId: JOB_ID,
  task: "STORYBOARD",
  attemptToken: "A".repeat(43),
  inputHash: hashCreativeValue(creativeInput),
  leaseExpiresAt: "2026-09-12T00:10:00.000Z",
  input: creativeInput,
};
const COMPLETION: CreativeCompletion = {
  status: "COMPLETED",
  result: creativeResult,
  metadata: {
    instructionVersion: "storyboard-v1",
    sdkVersion: "0.154.0",
    model: "gpt-storyboard-test",
    threadId: "thread-1",
    usage: { inputTokens: 11, cachedInputTokens: 2, outputTokens: 13 },
  },
  attemptToken: CLAIM.attemptToken,
  inputHash: CLAIM.inputHash,
};

async function withSpool<T>(
  callback: (directory: string) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "codex-spool-test-"));
  try {
    return await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("persists private markers and the original completion across restarts", async () => {
  await withSpool(async (directory) => {
    const store = new CompletionStore(directory);
    await store.initialize();
    assert.equal(await store.createAccepted(JOB_ID, NOW), true);
    assert.equal(await store.createAccepted(JOB_ID, NOW), false);
    await store.markClaiming(JOB_ID, NOW);
    await store.markStarted(JOB_ID, CLAIM, NOW);
    await store.markCompleted(JOB_ID, COMPLETION, NOW);

    const file = await stat(join(directory, `${JOB_ID}.json`));
    assert.equal(file.mode & 0o777, 0o600);
    assert.equal((await stat(directory)).mode & 0o777, 0o700);

    const reopened = new CompletionStore(directory);
    await reopened.initialize();
    const record = await reopened.get(JOB_ID);
    assert.equal(record?.state, "completed");
    assert.deepEqual(record?.completion, COMPLETION);
    assert.equal(record?.claim?.attemptToken, CLAIM.attemptToken);
  });
});

test("retains acknowledgements for 24 hours and keeps unacknowledged output", async () => {
  await withSpool(async (directory) => {
    const store = new CompletionStore(directory);
    await store.initialize();
    await store.createAccepted(JOB_ID, NOW);
    await store.markClaiming(JOB_ID, NOW);
    await store.markStarted(JOB_ID, CLAIM, NOW);
    await store.markCompleted(JOB_ID, COMPLETION, NOW);
    await store.markDeliveryAttempt(JOB_ID, NOW);

    assert.equal(
      await store.cleanupAcknowledged(new Date(NOW.getTime() + 90_000_000)),
      0,
    );
    assert.equal((await store.get(JOB_ID))?.state, "completed");

    await store.markAcknowledged(JOB_ID, NOW);
    assert.equal(
      await store.cleanupAcknowledged(
        new Date(NOW.getTime() + 23 * 60 * 60 * 1000),
      ),
      0,
    );
    assert.equal(
      await store.cleanupAcknowledged(
        new Date(NOW.getTime() + 24 * 60 * 60 * 1000 + 1),
      ),
      1,
    );
    assert.equal(await store.get(JOB_ID), null);
  });
});

test("rejects caller-controlled paths and fails closed when the spool is full", async () => {
  await withSpool(async (directory) => {
    const store = new CompletionStore(directory, 64);
    await store.initialize();
    await assert.rejects(store.get("../../etc/passwd"), /uuid|job id/i);
    await assert.rejects(
      store.createAccepted(JOB_ID, NOW),
      /capacity|full|space/i,
    );
    assert.deepEqual(await store.list(), []);
  });
});
