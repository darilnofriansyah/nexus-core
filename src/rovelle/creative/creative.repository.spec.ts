import * as assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { RovelleCreativeJobStatus } from "../../generated/prisma/client";
import { hashCreativeValue } from "./creative-validation";
import { creativeInput, creativeResult } from "./creative.fixture";
import { CreativeRepository } from "./creative.repository";
import type { CreativeCompletion } from "./dto/creative.dto";

type CreativeActionData = {
  token: string;
  telegramUserId: string;
  kind: string;
  payload: Record<string, unknown>;
  expiresAt: Date;
};

test("creative input hashes are stable for the persisted fixture", () => {
  const first = hashCreativeValue(creativeInput);
  const second = hashCreativeValue({
    ...creativeInput,
    canon: [...creativeInput.canon],
  });

  assert.equal(first, second);
  assert.match(first, /^[0-9a-f]{64}$/);
});

test("completion stores the first full preview and atomic page-one review actions", async () => {
  const fixture = createCompletionFixture();
  const response = await fixture.repository.complete(fixture.job.id, fixture.completed, new Date());

  assert.match(response.reply.text, /Creative draft \(page 1 of 1\)/);
  assert.match(response.reply.text, /One toy, two happy friends\./);
  assert.deepEqual(
    response.reply.inlineKeyboard?.flat().map((button) => button.text),
    ["Revise", "Approve plan"],
  );
  assert.deepEqual(
    fixture.actions.map((action) => action.data.kind),
    ["CREATIVE_REVISE", "CREATIVE_APPROVE"],
  );
  assert.ok(
    fixture.actions.every(
      ({ data }) =>
        data.payload &&
        typeof data.payload === "object" &&
        !Array.isArray(data.payload) &&
        data.payload.jobId === fixture.job.id &&
        data.payload.inputRevision === creativeInput.inputRevision &&
        data.payload.inputHash === fixture.job.inputHash &&
        data.payload.page === 1,
    ),
  );
  assert.deepEqual(fixture.session.data.creativeReviewProgress, {
    jobId: fixture.job.id,
    inputRevision: creativeInput.inputRevision,
    inputHash: fixture.job.inputHash,
    currentPage: 1,
    viewedPages: [1],
  });
  assert.deepEqual(fixture.job.completionResponse, response.reply);
  assert.equal(fixture.sessionLockTaken, true);
  assert.deepEqual(fixture.events.slice(0, 2), ["session-lock", "job-reconcile"]);
});

test("failed completion offers an explicit retry action and creates no job", async () => {
  const fixture = createCompletionFixture({
    status: "FAILED",
    errorCode: "EXECUTION_FAILED",
  } as Partial<CreativeCompletion>);
  const response = await fixture.repository.complete(fixture.job.id, fixture.completed, new Date());

  assert.match(response.reply.text, /not retried automatically/i);
  assert.equal(response.reply.inlineKeyboard?.flat()[0]?.text, "Retry");
  assert.equal(fixture.actions.length, 1);
  assert.equal(fixture.actions[0]?.data.kind, "CREATIVE_RETRY");
  assert.equal(fixture.job.status, RovelleCreativeJobStatus.FAILED);
});

function createCompletionFixture(overrides: Partial<CreativeCompletion> = {}) {
  const attemptToken = Buffer.alloc(32, 71).toString("base64url");
  const inputHash = hashCreativeValue(creativeInput);
  const job = {
    id: "job-1",
    creatorSessionId: "550e8400-e29b-41d4-a716-446655440000",
    telegramUserId: "976684739",
    chatId: "976684739",
    inputRevision: creativeInput.inputRevision,
    task: "STORYBOARD",
    input: creativeInput,
    inputHash,
    status: RovelleCreativeJobStatus.RUNNING,
    attemptTokenHash: createHash("sha256").update(attemptToken).digest("hex"),
    leaseExpiresAt: new Date(Date.now() + 60_000),
    result: null as unknown,
    completionMetadata: null as unknown,
    completionResponse: null as unknown,
    completionHash: null as string | null,
    failureCode: null as string | null,
    supersededAt: null as Date | null,
  };
  const session = {
    id: job.creatorSessionId,
    telegramUserId: job.telegramUserId,
    step: "CREATIVE_REVIEW",
    data: {
      creativeJobId: job.id,
      creativeInputRevision: job.inputRevision,
    } as Record<string, unknown>,
  };
  const actions: Array<{ data: CreativeActionData }> = [];
  const events: string[] = [];
  let sessionLockTaken = false;
  const transaction = {
    $queryRaw: async () => {
      events.push("session-lock");
      sessionLockTaken = true;
      return [];
    },
    rovelleCreativeJob: {
      findUnique: async () => ({ ...job }),
      updateMany: async ({
        where,
        data,
      }: {
        where: {
          status?: RovelleCreativeJobStatus;
          supersededAt?: null;
          leaseExpiresAt?: { lte: Date };
        };
        data: Record<string, unknown>;
      }) => {
        events.push("job-reconcile");
        if (where.status && where.status !== job.status) return { count: 0 };
        if (where.supersededAt === null && job.supersededAt !== null) return { count: 0 };
        if (
          where.leaseExpiresAt?.lte &&
          job.leaseExpiresAt &&
          job.leaseExpiresAt > where.leaseExpiresAt.lte
        ) {
          return { count: 0 };
        }
        Object.assign(job, data);
        return { count: 1 };
      },
    },
    rovelleCreatorSession: {
      findUnique: async () => session,
      update: async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(session, data);
        return session;
      },
    },
    rovelleCreatorAction: {
      create: async ({ data }: { data: CreativeActionData }) => {
        actions.push({ data });
        return { id: `action-${actions.length}`, ...data };
      },
    },
  };
  const repository = new CreativeRepository({
    client: {
      $transaction: async <T>(operation: (tx: typeof transaction) => Promise<T>) => operation(transaction),
    },
  } as never);
  const metadata = {
    instructionVersion: "storyboard-v1" as const,
    sdkVersion: "0.154.0",
    model: "gpt-5.6-luna",
    threadId: null,
    usage: null,
  };
  const completed = (
    overrides.status === "FAILED"
      ? {
          attemptToken,
          inputHash,
          status: "FAILED",
          metadata,
          errorCode: overrides.errorCode ?? "EXECUTION_FAILED",
        }
      : {
          attemptToken,
          inputHash,
          status: "COMPLETED",
          metadata,
          result: creativeResult,
          ...overrides,
        }
  ) as CreativeCompletion;
  return {
    repository,
    job,
    session,
    actions,
    events,
    completed,
    get sessionLockTaken() {
      return sessionLockTaken;
    },
  };
}
