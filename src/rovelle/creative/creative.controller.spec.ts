import "reflect-metadata";
import * as assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { ConflictException, ForbiddenException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { Reflector } from "@nestjs/core";
import { ApiKeyGuard } from "../../common/guards/api-key.guard";
import { installBodyParsers } from "../../config/body-parser";
import { CreativeRepository } from "./creative.repository";
import { creativeInput, creativeResult } from "./creative.fixture";
import { CreativeController } from "./creative.controller";
import { CreativeWorkerGuard } from "./creative-worker.guard";
import type { CreativeCompletion } from "./dto/creative.dto";
import {
  hashCreativeValue,
  normalizeCreativeCompletion,
} from "./creative-validation";

const JOB_ID = "550e8400-e29b-41d4-a716-446655440000";
const WORKER_KEY = "worker-secret-0123456789-0123456789";
const ATTEMPT_TOKEN = Buffer.alloc(32, 7).toString("base64url");
const INPUT_HASH = hashCreativeValue(creativeInput);
const METADATA = {
  instructionVersion: "storyboard-v1",
  sdkVersion: "0.154.0",
  model: "gpt-5.6-luna",
  threadId: null,
  usage: null,
} as const;
const COMPLETION: CreativeCompletion = {
  attemptToken: ATTEMPT_TOKEN,
  inputHash: INPUT_HASH,
  status: "COMPLETED",
  metadata: METADATA,
  result: creativeResult,
};
const ENV_KEYS = [
  "CORE_API_KEY",
  "ROVELLE_CREATIVE_ENABLED",
  "ROVELLE_CREATIVE_WORKER_KEY",
  "ROVELLE_TELEGRAM_BOT_ID",
] as const;
const originalEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = originalEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test("guards the worker boundary and preserves Core-owned completion destination", async () => {
  process.env.CORE_API_KEY = "global-core-secret";
  process.env.ROVELLE_CREATIVE_ENABLED = "true";
  process.env.ROVELLE_CREATIVE_WORKER_KEY = WORKER_KEY;
  process.env.ROVELLE_TELEGRAM_BOT_ID = "test-bot";

  const calls: string[] = [];
  let completionBehavior: "success" | "token" | "hash" = "success";
  const savedResponse = {
    chatId: "core-owned-chat",
    reply: { text: "Creative result saved." },
  };
  const repository = {
    listQueued: async () => {
      calls.push("list");
      return [{ id: JOB_ID }];
    },
    claim: async (jobId: string) => {
      calls.push(`claim:${jobId}`);
      return { claimed: false };
    },
    complete: async (_jobId: string, value: unknown) => {
      const body = value as Record<string, unknown>;
      calls.push(`complete:${_jobId}`);
      if (_jobId !== JOB_ID) {
        throw new ForbiddenException("Creative execution token is invalid");
      }
      if (
        completionBehavior === "token" &&
        body.attemptToken !== ATTEMPT_TOKEN
      ) {
        throw new ForbiddenException("Creative execution token is invalid");
      }
      if (completionBehavior === "hash" && body.inputHash !== INPUT_HASH) {
        throw new ConflictException(
          "Creative completion input hash does not match",
        );
      }
      normalizeCreativeCompletion(value, creativeInput);
      return savedResponse;
    },
  };
  const app = await createHttpApp(repository);
  const endpoint = await endpointFor(app);
  const workerHeaders = {
    "content-type": "application/json",
    "x-rovelle-worker-key": WORKER_KEY,
  };

  try {
    const denied = await fetch(`${endpoint}?status=QUEUED`, {
      headers: { "x-core-api-key": "global-core-secret" },
    });
    assert.equal(denied.status, 401);
    assert.deepEqual(calls, []);

    const listed = await fetch(`${endpoint}?status=QUEUED`, {
      headers: workerHeaders,
    });
    assert.equal(listed.status, 200);
    assert.deepEqual(await listed.json(), {
      ok: true,
      data: { jobs: [{ id: JOB_ID }] },
    });

    const invalidStatus = await fetch(`${endpoint}?status=RUNNING`, {
      headers: workerHeaders,
    });
    assert.equal(invalidStatus.status, 400);

    const invalidId = await fetch(`${endpoint}/not-a-uuid/claim`, {
      method: "POST",
      headers: workerHeaders,
      body: "{}",
    });
    assert.equal(invalidId.status, 400);

    const claim = await fetch(`${endpoint}/${JOB_ID}/claim`, {
      method: "POST",
      headers: workerHeaders,
      body: "{}",
    });
    assert.equal(claim.status, 200);
    assert.deepEqual(await claim.json(), {
      ok: true,
      data: { claimed: false },
    });

    const malformed = await fetch(`${endpoint}/${JOB_ID}/result`, {
      method: "POST",
      headers: workerHeaders,
      body: JSON.stringify({
        status: "COMPLETED",
        result: { script: "private text" },
      }),
    });
    assert.equal(malformed.status, 400);
    assert.doesNotMatch(await malformed.text(), /private text|attemptToken/);

    completionBehavior = "token";
    const wrongToken = await fetch(`${endpoint}/${JOB_ID}/result`, {
      method: "POST",
      headers: workerHeaders,
      body: JSON.stringify({
        ...COMPLETION,
        attemptToken: Buffer.alloc(32, 8).toString("base64url"),
      }),
    });
    assert.equal(wrongToken.status, 403);

    completionBehavior = "hash";
    const wrongHash = await fetch(`${endpoint}/${JOB_ID}/result`, {
      method: "POST",
      headers: workerHeaders,
      body: JSON.stringify({ ...COMPLETION, inputHash: "0".repeat(64) }),
    });
    assert.equal(wrongHash.status, 409);

    const foreignJob = await fetch(
      `${endpoint}/650e8400-e29b-41d4-a716-446655440000/result`,
      {
        method: "POST",
        headers: workerHeaders,
        body: JSON.stringify(COMPLETION),
      },
    );
    assert.equal(foreignJob.status, 403);

    completionBehavior = "success";
    const first = await fetch(`${endpoint}/${JOB_ID}/result`, {
      method: "POST",
      headers: workerHeaders,
      body: JSON.stringify(COMPLETION),
    });
    const replay = await fetch(`${endpoint}/${JOB_ID}/result`, {
      method: "POST",
      headers: workerHeaders,
      body: JSON.stringify(COMPLETION),
    });
    assert.equal(first.status, 200);
    const firstBody = await first.json();
    assert.deepEqual(await replay.json(), firstBody);
    assert.deepEqual(firstBody, {
      ok: true,
      data: savedResponse,
    });

    const callerDestination = await fetch(`${endpoint}/${JOB_ID}/result`, {
      method: "POST",
      headers: workerHeaders,
      body: JSON.stringify({ ...COMPLETION, chatId: "attacker-chat" }),
    });
    assert.equal(callerDestination.status, 400);
    assert.doesNotMatch(await callerDestination.text(), /attacker-chat/);

    const callerOwner = await fetch(`${endpoint}/${JOB_ID}/result`, {
      method: "POST",
      headers: workerHeaders,
      body: JSON.stringify({ ...COMPLETION, telegramUserId: "foreign-user" }),
    });
    assert.equal(callerOwner.status, 400);
    assert.doesNotMatch(await callerOwner.text(), /foreign-user/);
  } finally {
    await app.close();
  }
});

test("rejects an oversized creative body before repository validation", async () => {
  process.env.CORE_API_KEY = "global-core-secret";
  process.env.ROVELLE_CREATIVE_ENABLED = "true";
  process.env.ROVELLE_CREATIVE_WORKER_KEY = WORKER_KEY;
  process.env.ROVELLE_TELEGRAM_BOT_ID = "test-bot";
  let calls = 0;
  const app = await createHttpApp({
    listQueued: async () => [],
    claim: async () => {
      calls += 1;
      return { claimed: false };
    },
    complete: async () => {
      calls += 1;
      return { chatId: "core-owned-chat", reply: { text: "saved" } };
    },
  });

  try {
    const endpoint = await endpointFor(app);
    const tooLarge = JSON.stringify({ data: "x".repeat(512 * 1024) });
    const response = await fetch(`${endpoint}/${JOB_ID}/claim`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-rovelle-worker-key": WORKER_KEY,
      },
      body: tooLarge,
    });
    assert.equal(response.status, 413);
    assert.equal(calls, 0);
  } finally {
    await app.close();
  }
});

async function createHttpApp(repository: object) {
  const moduleRef = await Test.createTestingModule({
    controllers: [CreativeController],
    providers: [
      CreativeWorkerGuard,
      { provide: CreativeRepository, useValue: repository },
    ],
  }).compile();
  const app = moduleRef.createNestApplication({ bodyParser: false });
  app.setGlobalPrefix("api");
  installBodyParsers(app);
  app.useLogger(false);
  app.useGlobalGuards(new ApiKeyGuard(new Reflector()));
  await app.init();
  await app.listen(0, "127.0.0.1");
  return app;
}

async function endpointFor(
  app: Awaited<ReturnType<typeof createHttpApp>>,
): Promise<string> {
  const address = app.getHttpServer().address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}/api/rovelle/creative-jobs`;
}
