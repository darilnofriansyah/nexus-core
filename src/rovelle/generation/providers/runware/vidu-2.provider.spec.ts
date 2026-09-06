import * as assert from "node:assert/strict";
import { test } from "node:test";
import {
  BadRequestException,
  ServiceUnavailableException,
} from "@nestjs/common";
import type {
  GenerationProviderSubmission,
  GenerationProviderSubmissionResult,
} from "../generation-provider";
import { Vidu2Provider, type RunwareTaskSubmitter } from "./vidu-2.provider";

const TASK_ID = "123e4567-e89b-42d3-a456-426614174000";
const WEBHOOK_TOKEN = "runware-webhook-token-0123456789abcdef";
const BASE_REQUEST: GenerationProviderSubmission = {
  taskId: TASK_ID,
  prompt: "Make Koko walk.",
  duration: 4,
  width: 1280,
  height: 720,
  referenceImageUrls: ["https://assets.test/reference.png"],
  uploadUrl: "https://assets.test/upload",
};
const WEBHOOK_CONFIG: {
  nodeEnv: string;
  runwareVideoModel: string;
  runwareWebhookBaseUrl?: string;
  runwareWebhookToken?: string;
} = {
  nodeEnv: "development",
  runwareVideoModel: "vidu:2@0",
  runwareWebhookBaseUrl: "https://core.test/api/rovelle/webhooks/runware",
  runwareWebhookToken: WEBHOOK_TOKEN,
};

class FakeSubmitClient implements RunwareTaskSubmitter {
  tasks: unknown[] = [];
  result: GenerationProviderSubmissionResult = { providerTaskId: TASK_ID };

  async submit(task: unknown): Promise<GenerationProviderSubmissionResult> {
    this.tasks.push(task);
    return this.result;
  }
}

function createProvider(
  client = new FakeSubmitClient(),
  config = WEBHOOK_CONFIG,
): {
  service: Vidu2Provider;
  client: FakeSubmitClient;
} {
  return { service: new Vidu2Provider(client, config), client };
}

test("submits the exact Vidu 2 task payload", async () => {
  const { service, client } = createProvider();

  await service.submit(BASE_REQUEST);

  assert.deepEqual(client.tasks, [
    {
      taskType: "videoInference",
      taskUUID: TASK_ID,
      model: "vidu:2@0",
      positivePrompt: "Make Koko walk.",
      width: 1280,
      height: 720,
      duration: 4,
      inputs: {
        referenceImages: BASE_REQUEST.referenceImageUrls,
      },
      deliveryMethod: "async",
      numberResults: 1,
      outputType: "URL",
      outputFormat: "MP4",
      includeCost: true,
      uploadEndpoint: BASE_REQUEST.uploadUrl,
      webhookURL:
        "https://core.test/api/rovelle/webhooks/runware?token=runware-webhook-token-0123456789abcdef",
    },
  ]);
});

test("rejects missing webhook configuration", async () => {
  await assert.rejects(
    () =>
      createProvider(new FakeSubmitClient(), {
        ...WEBHOOK_CONFIG,
        runwareWebhookBaseUrl: undefined,
      }).service.submit(BASE_REQUEST),
    (error: unknown) => error instanceof ServiceUnavailableException,
  );
  await assert.rejects(
    () =>
      createProvider(new FakeSubmitClient(), {
        ...WEBHOOK_CONFIG,
        runwareWebhookToken: undefined,
      }).service.submit(BASE_REQUEST),
    (error: unknown) => error instanceof ServiceUnavailableException,
  );
});

test("rejects a configured model other than Vidu 2", async () => {
  const { service, client } = createProvider(new FakeSubmitClient(), {
    ...WEBHOOK_CONFIG,
    runwareVideoModel: "bytedance:seedance@2.5",
  });

  await assert.rejects(
    () => service.submit(BASE_REQUEST),
    /RUNWARE_VIDEO_MODEL must be vidu:2@0/,
  );
  assert.equal(client.tasks.length, 0);
});

test("rejects webhook tokens shorter than thirty-two characters", async () => {
  await assert.rejects(
    () =>
      createProvider(new FakeSubmitClient(), {
        ...WEBHOOK_CONFIG,
        runwareWebhookToken: "too-short",
      }).service.submit(BASE_REQUEST),
    (error: unknown) => error instanceof ServiceUnavailableException,
  );
});

test("rejects production HTTP webhook URLs", async () => {
  await assert.rejects(
    () =>
      createProvider(new FakeSubmitClient(), {
        ...WEBHOOK_CONFIG,
        nodeEnv: "production",
        runwareWebhookBaseUrl: "http://localhost:3000/webhooks/runware",
      }).service.submit(BASE_REQUEST),
    (error: unknown) => error instanceof ServiceUnavailableException,
  );
});

test("rejects non-loopback HTTP webhook URLs outside production", async () => {
  await assert.rejects(
    () =>
      createProvider(new FakeSubmitClient(), {
        ...WEBHOOK_CONFIG,
        runwareWebhookBaseUrl: "http://core.test/webhooks/runware",
      }).service.submit(BASE_REQUEST),
    (error: unknown) => error instanceof ServiceUnavailableException,
  );
});

test("allows HTTP loopback webhook URLs outside production", async () => {
  const { service, client } = createProvider(new FakeSubmitClient(), {
    ...WEBHOOK_CONFIG,
    runwareWebhookBaseUrl: "http://127.0.0.1:3000/webhooks/runware",
  });

  await service.submit(BASE_REQUEST);

  assert.equal(
    (client.tasks[0] as { webhookURL: string }).webhookURL,
    "http://127.0.0.1:3000/webhooks/runware?token=runware-webhook-token-0123456789abcdef",
  );
});

test("rejects webhook base URLs with query, hash, or userinfo", async () => {
  for (const runwareWebhookBaseUrl of [
    "https://core.test/webhooks/runware?existing=1",
    "https://core.test/webhooks/runware#fragment",
    "https://user:password@core.test/webhooks/runware",
  ]) {
    await assert.rejects(
      () =>
        createProvider(new FakeSubmitClient(), {
          ...WEBHOOK_CONFIG,
          runwareWebhookBaseUrl,
        }).service.submit(BASE_REQUEST),
      (error: unknown) => error instanceof ServiceUnavailableException,
    );
  }
});

test("rejects empty webhook userinfo", async () => {
  await assert.rejects(
    () =>
      createProvider(new FakeSubmitClient(), {
        ...WEBHOOK_CONFIG,
        runwareWebhookBaseUrl: "https://@core.test/webhooks/runware",
      }).service.submit(BASE_REQUEST),
    (error: unknown) => error instanceof ServiceUnavailableException,
  );
});

test("rejects canonicalized empty webhook userinfo variants", async () => {
  for (const runwareWebhookBaseUrl of [
    "https:@core.test/webhooks/runware",
    "https:////@core.test/webhooks/runware",
    "https:///@core.test/webhooks/runware",
  ]) {
    await assert.rejects(
      () =>
        createProvider(new FakeSubmitClient(), {
          ...WEBHOOK_CONFIG,
          runwareWebhookBaseUrl,
        }).service.submit(BASE_REQUEST),
      (error: unknown) => error instanceof ServiceUnavailableException,
    );
  }
});

test("accepts an at-sign in the path after a backslash separator", async () => {
  const { service, client } = createProvider(new FakeSubmitClient(), {
    ...WEBHOOK_CONFIG,
    runwareWebhookBaseUrl: "https://core.test\\path@segment/runware",
  });

  await service.submit(BASE_REQUEST);

  assert.equal(
    (client.tasks[0] as { webhookURL: string }).webhookURL,
    "https://core.test/path@segment/runware?token=runware-webhook-token-0123456789abcdef",
  );
});

test("rejects tab, LF, and CR in webhook base URLs", async () => {
  for (const controlCharacter of ["\t", "\n", "\r"]) {
    await assert.rejects(
      () =>
        createProvider(new FakeSubmitClient(), {
          ...WEBHOOK_CONFIG,
          runwareWebhookBaseUrl: `https://core.test/webhooks${controlCharacter}/runware`,
        }).service.submit(BASE_REQUEST),
      (error: unknown) => error instanceof ServiceUnavailableException,
    );
  }
});

test("encodes the webhook token only on the outgoing task", async () => {
  const token = "runware/webhook?token&0123456789abcdef";
  const { service, client } = createProvider(new FakeSubmitClient(), {
    ...WEBHOOK_CONFIG,
    runwareWebhookToken: token,
  });

  await service.submit(BASE_REQUEST);

  const expected = new URL(WEBHOOK_CONFIG.runwareWebhookBaseUrl!);
  expected.searchParams.set("token", token);
  assert.equal(
    (client.tasks[0] as { webhookURL: string }).webhookURL,
    expected.toString(),
  );
  assert.match(expected.toString(), /%2F/);
  assert.match(expected.toString(), /%3F/);
  assert.match(expected.toString(), /%26/);
});

test("rejects empty references", async () => {
  await assert.rejects(
    () =>
      createProvider().service.submit({
        ...BASE_REQUEST,
        referenceImageUrls: [],
      }),
    (error: unknown) => error instanceof BadRequestException,
  );
});

test("rejects more than three Vidu references", async () => {
  await assert.rejects(
    () =>
      createProvider().service.submit({
        ...BASE_REQUEST,
        referenceImageUrls: Array.from(
          { length: 4 },
          (_, index) => `https://assets.test/${index}`,
        ),
      }),
    /at most 3 references/,
  );
});

test("enforces prompt length from two through ten thousand characters", async () => {
  await assert.rejects(
    () => createProvider().service.submit({ ...BASE_REQUEST, prompt: "x" }),
    /prompt must be between 2 and 10,000 characters/,
  );
  await assert.rejects(
    () =>
      createProvider().service.submit({
        ...BASE_REQUEST,
        prompt: "x".repeat(10_001),
      }),
    /prompt must be between 2 and 10,000 characters/,
  );
});

test("requires Vidu's four-second duration", async () => {
  await assert.rejects(
    () => createProvider().service.submit({ ...BASE_REQUEST, duration: 3 }),
    /duration must be 4 seconds/,
  );
  await assert.rejects(
    () => createProvider().service.submit({ ...BASE_REQUEST, duration: 5 }),
    /duration must be 4 seconds/,
  );
});

test("accepts only Vidu's 720p landscape dimensions", async () => {
  await createProvider().service.submit(BASE_REQUEST);

  await assert.rejects(
    () =>
      createProvider().service.submit({
        ...BASE_REQUEST,
        width: 720,
        height: 1280,
      }),
    /dimensions must be 1280x720/,
  );
});

test("rejects a returned provider task ID that differs from the Core task UUID", async () => {
  const client = new FakeSubmitClient();
  client.result = { providerTaskId: "different-task" };

  await assert.rejects(
    () => new Vidu2Provider(client, WEBHOOK_CONFIG).submit(BASE_REQUEST),
    /provider task ID does not match task ID/,
  );
});

test("does not merge caller webhook fields into the task or result", async () => {
  const { service, client } = createProvider();
  const request = {
    ...BASE_REQUEST,
    webhookURL: "https://attacker.test",
  } as GenerationProviderSubmission & {
    webhookURL: string;
  };

  const result = await service.submit(request);

  const submitted = client.tasks[0] as Record<string, unknown>;
  assert.equal(
    submitted.webhookURL,
    "https://core.test/api/rovelle/webhooks/runware?token=runware-webhook-token-0123456789abcdef",
  );
  assert.equal(JSON.stringify(submitted).includes("attacker.test"), false);
  assert.deepEqual(result, { providerTaskId: TASK_ID });
  assert.equal(JSON.stringify(result).includes("webhook"), false);
  assert.deepEqual(Object.keys(submitted).sort(), [
    "deliveryMethod",
    "duration",
    "height",
    "includeCost",
    "inputs",
    "model",
    "numberResults",
    "outputFormat",
    "outputType",
    "positivePrompt",
    "taskType",
    "taskUUID",
    "uploadEndpoint",
    "webhookURL",
    "width",
  ]);
});

test("returns only the provider task ID", async () => {
  const client = new FakeSubmitClient();
  client.result = {
    providerTaskId: TASK_ID,
    webhookURL: "https://core.test/webhooks/runware?token=secret",
  } as GenerationProviderSubmissionResult;

  const result = await createProvider(client).service.submit(BASE_REQUEST);

  assert.deepEqual(result, { providerTaskId: TASK_ID });
});
