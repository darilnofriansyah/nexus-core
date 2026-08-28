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

type SeedanceConfig = Pick<
  CoreApiEnv,
  "runwareVideoModel" | "runwareWebhookBaseUrl" | "runwareWebhookToken"
> & {
  nodeEnv?: string;
};

type SeedanceRunwareTask = RunwareVideoTask & { webhookURL: string };

const SUPPORTED_DIMENSIONS = new Set(["480x854", "720x1280"]);
const MIN_WEBHOOK_TOKEN_LENGTH = 32;

@Injectable()
export class Seedance25Provider implements GenerationProvider {
  private readonly config: SeedanceConfig;

  constructor(
    @Inject(RunwareSubmitClient)
    private readonly client: RunwareTaskSubmitter,
    @Optional()
    config: SeedanceConfig = readEnv(),
  ) {
    this.config = config;
  }

  async submit(
    request: GenerationProviderSubmission,
  ): Promise<GenerationProviderSubmissionResult> {
    this.validate(request);
    const webhookURL = this.createWebhookUrl();

    const task: SeedanceRunwareTask = {
      taskType: "videoInference",
      taskUUID: request.taskId,
      model: this.config.runwareVideoModel,
      positivePrompt: request.prompt,
      width: request.width,
      height: request.height,
      duration: request.duration,
      inputs: { referenceImages: [...request.referenceImageUrls] },
      settings: { audio: false },
      deliveryMethod: "async",
      numberResults: 1,
      outputType: "URL",
      outputFormat: "MP4",
      includeCost: true,
      ttl: 60,
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

  private createWebhookUrl(): string {
    const baseUrl = this.config.runwareWebhookBaseUrl?.trim();
    const token = this.config.runwareWebhookToken?.trim();

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

    let webhookUrl: URL;
    try {
      webhookUrl = new URL(baseUrl);
    } catch {
      throw new ServiceUnavailableException("Runware webhook URL is invalid");
    }

    if (
      /[?#]/.test(baseUrl) ||
      webhookUrl.username ||
      webhookUrl.password
    ) {
      throw new ServiceUnavailableException("Runware webhook URL is invalid");
    }

    const isHttps = webhookUrl.protocol === "https:";
    const isDevelopmentHttp =
      webhookUrl.protocol === "http:" &&
      this.config.nodeEnv !== "production" &&
      isLoopback(webhookUrl.hostname);
    if (!isHttps && !isDevelopmentHttp) {
      throw new ServiceUnavailableException(
        "Runware webhook URL must use HTTPS",
      );
    }

    webhookUrl.searchParams.set("token", token);
    return webhookUrl.toString();
  }

  private validate(request: GenerationProviderSubmission): void {
    if (
      !Array.isArray(request.referenceImageUrls) ||
      request.referenceImageUrls.length === 0
    ) {
      throw new BadRequestException("at least one reference image is required");
    }
    if (request.referenceImageUrls.length > 30) {
      throw new BadRequestException("at most 30 references are supported");
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
    if (
      !Number.isInteger(request.duration) ||
      request.duration < 4 ||
      request.duration > 30
    ) {
      throw new BadRequestException(
        "duration must be an integer from 4 to 30",
      );
    }
    if (
      typeof request.width !== "number" ||
      typeof request.height !== "number" ||
      !SUPPORTED_DIMENSIONS.has(`${request.width}x${request.height}`)
    ) {
      throw new BadRequestException(
        "dimensions must be 480x854 or 720x1280",
      );
    }
  }
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}
