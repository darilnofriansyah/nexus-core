import * as assert from "node:assert/strict";
import { test } from "node:test";
import type {
  GenerationProviderSubmission,
  GenerationProviderSubmissionResult,
} from "../generation-provider";
import { ViduQ3Provider } from "./vidu-q3.provider";

const TASK_ID = "123e4567-e89b-42d3-a456-426614174000";
const WEBHOOK_TOKEN = "runware-webhook-token-0123456789abcdef";
const FRAME_URL = "https://assets.test/otti-meadow.png";

const BASE_REQUEST: GenerationProviderSubmission = {
  taskId: TASK_ID,
  prompt: "Otti waves from Meadow Village.",
  duration: 4,
  width: 1280,
  height: 720,
  referenceImageUrls: [],
  frameImageUrl: FRAME_URL,
  uploadUrl: "https://assets.test/upload",
};

class FakeSubmitClient {
  tasks: unknown[] = [];

  async submit(task: unknown): Promise<GenerationProviderSubmissionResult> {
    this.tasks.push(task);
    return { providerTaskId: TASK_ID };
  }
}

test("submits the exact Vidu Q3 first-frame payload", async () => {
  const client = new FakeSubmitClient();
  const provider = new ViduQ3Provider(client, {
    nodeEnv: "production",
    runwareVideoModel: "vidu:4@1",
    runwareWebhookBaseUrl: "https://core.test/api/rovelle/webhooks/runware",
    runwareWebhookToken: WEBHOOK_TOKEN,
  });

  await provider.submit(BASE_REQUEST);

  assert.deepEqual(client.tasks, [
    {
      taskType: "videoInference",
      taskUUID: TASK_ID,
      model: "vidu:4@1",
      positivePrompt: "Otti waves from Meadow Village.",
      width: 1280,
      height: 720,
      duration: 4,
      inputs: { frameImages: [{ image: FRAME_URL, frame: "first" }] },
      providerSettings: { vidu: { audio: false } },
      deliveryMethod: "async",
      numberResults: 1,
      outputType: "URL",
      outputFormat: "MP4",
      includeCost: true,
      uploadEndpoint: "https://assets.test/upload",
      webhookURL:
        "https://core.test/api/rovelle/webhooks/runware?token=runware-webhook-token-0123456789abcdef",
    },
  ]);
});
