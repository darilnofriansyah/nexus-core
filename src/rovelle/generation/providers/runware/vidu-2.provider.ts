import {
  BadRequestException,
  Inject,
  Injectable,
  Optional,
  ServiceUnavailableException,
} from "@nestjs/common";
import { readEnv, type CoreApiEnv } from "../../../../config/env";
import type {
  GenerationProvider,
  GenerationProviderSubmission,
  GenerationProviderSubmissionResult,
} from "../generation-provider";
import {
  RunwareSubmissionError,
  RunwareSubmitClient,
  type RunwareVideoTask,
} from "./runware-submit.client";

export interface RunwareTaskSubmitter {
  submit(task: RunwareVideoTask): Promise<GenerationProviderSubmissionResult>;
}

export type RunwareVideoProviderConfig = Pick<
  CoreApiEnv,
  "runwareVideoModel" | "runwareWebhookBaseUrl" | "runwareWebhookToken"
> & {
  nodeEnv?: string;
};

type Vidu2RunwareTask = RunwareVideoTask & { webhookURL: string };

const SUPPORTED_DIMENSIONS = new Set(["1280x720"]);
const MIN_WEBHOOK_TOKEN_LENGTH = 32;
const VIDU_2_MODEL = "vidu:2@0";

@Injectable()
export class Vidu2Provider implements GenerationProvider {
  private readonly config: RunwareVideoProviderConfig;

  constructor(
    @Inject(RunwareSubmitClient)
    private readonly client: RunwareTaskSubmitter,
    @Optional()
    config: RunwareVideoProviderConfig = readEnv(),
  ) {
    this.config = config;
  }

  async submit(
    request: GenerationProviderSubmission,
  ): Promise<GenerationProviderSubmissionResult> {
    this.validate(request);
    this.assertModel();
    const webhookURL = createRunwareWebhookUrl(this.config);

    const task: Vidu2RunwareTask = {
      taskType: "videoInference",
      taskUUID: request.taskId,
      model: this.config.runwareVideoModel,
      positivePrompt: request.prompt,
      width: request.width,
      height: request.height,
      duration: request.duration,
      inputs: { referenceImages: [...request.referenceImageUrls] },
      deliveryMethod: "async",
      numberResults: 1,
      outputType: "URL",
      outputFormat: "MP4",
      includeCost: true,
      uploadEndpoint: request.uploadUrl,
      webhookURL,
    };

    const result = await this.client.submit(task);
    if (
      typeof result.providerTaskId !== "string" ||
      result.providerTaskId !== request.taskId
    ) {
      throw new RunwareSubmissionError(
        "PROVIDER",
        "provider task ID does not match task ID",
        false,
      );
    }
    return { providerTaskId: result.providerTaskId };
  }

  private assertModel(): void {
    if (this.config.runwareVideoModel !== VIDU_2_MODEL) {
      throw new ServiceUnavailableException(
        "RUNWARE_VIDEO_MODEL must be vidu:2@0",
      );
    }
  }

  private validate(request: GenerationProviderSubmission): void {
    if (
      !Array.isArray(request.referenceImageUrls) ||
      request.referenceImageUrls.length === 0
    ) {
      throw new BadRequestException("at least one reference image is required");
    }
    if (request.referenceImageUrls.length > 3) {
      throw new BadRequestException("at most 3 references are supported");
    }
    if (
      request.referenceImageUrls.some(
        (referenceUrl) =>
          typeof referenceUrl !== "string" || referenceUrl.length === 0,
      )
    ) {
      throw new BadRequestException("reference image URLs must be strings");
    }
    if (
      typeof request.prompt !== "string" ||
      request.prompt.length < 2 ||
      request.prompt.length > 10_000
    ) {
      throw new BadRequestException(
        "prompt must be between 2 and 10,000 characters",
      );
    }
    if (!Number.isInteger(request.duration) || request.duration !== 4) {
      throw new BadRequestException("duration must be 4 seconds for Vidu 2");
    }
    if (
      typeof request.width !== "number" ||
      typeof request.height !== "number" ||
      !SUPPORTED_DIMENSIONS.has(`${request.width}x${request.height}`)
    ) {
      throw new BadRequestException("dimensions must be 1280x720 for Vidu 2");
    }
  }
}

export function createRunwareWebhookUrl(
  config: RunwareVideoProviderConfig,
): string {
  const baseUrl = config.runwareWebhookBaseUrl?.trim();
  const token = config.runwareWebhookToken?.trim();

  if (!baseUrl) {
    throw new ServiceUnavailableException(
      "Runware webhook base URL is not configured",
    );
  }
  if (!token || token.length < MIN_WEBHOOK_TOKEN_LENGTH) {
    throw new ServiceUnavailableException(
      "Runware webhook token is not configured",
    );
  }
  if (/[\t\n\r]/.test(baseUrl)) {
    throw new ServiceUnavailableException("Runware webhook URL is invalid");
  }

  let webhookUrl: URL;
  try {
    webhookUrl = new URL(baseUrl);
  } catch {
    throw new ServiceUnavailableException("Runware webhook URL is invalid");
  }

  if (
    /[?#]/.test(baseUrl) ||
    hasUserInfo(baseUrl) ||
    webhookUrl.username ||
    webhookUrl.password
  ) {
    throw new ServiceUnavailableException("Runware webhook URL is invalid");
  }

  const isHttps = webhookUrl.protocol === "https:";
  const isDevelopmentHttp =
    webhookUrl.protocol === "http:" &&
    config.nodeEnv !== "production" &&
    isLoopback(webhookUrl.hostname);
  if (!isHttps && !isDevelopmentHttp) {
    throw new ServiceUnavailableException(
      "Runware webhook URL must use HTTPS",
    );
  }

  webhookUrl.searchParams.set("token", token);
  return webhookUrl.toString();
}

function isLoopback(hostname: string): boolean {
  return (
    hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]"
  );
}

function hasUserInfo(baseUrl: string): boolean {
  const schemeSeparator = baseUrl.indexOf(":");
  if (schemeSeparator < 0) return false;

  const authority = baseUrl
    .slice(schemeSeparator + 1)
    .replace(/^[\/\\]*/, "")
    .split(/[/?#\\]/, 1)[0];
  return authority.includes("@");
}
