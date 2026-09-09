import {
  BadRequestException,
  Inject,
  Injectable,
  Optional,
  ServiceUnavailableException,
} from "@nestjs/common";
import { readEnv } from "../../../../config/env";
import type {
  GenerationProvider,
  GenerationProviderSubmission,
  GenerationProviderSubmissionResult,
} from "../generation-provider";
import {
  RunwareSubmitClient,
  RunwareSubmissionError,
  type RunwareVideoTask,
} from "./runware-submit.client";
import {
  createRunwareWebhookUrl,
  type RunwareTaskSubmitter,
  type RunwareVideoProviderConfig,
} from "./vidu-2.provider";

const VIDU_Q3_MODEL = "vidu:4@1";
const SUPPORTED_DIMENSIONS = new Set(["1280x720"]);

type ViduQ3RunwareTask = RunwareVideoTask & { webhookURL: string };

@Injectable()
export class ViduQ3Provider implements GenerationProvider {
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
    if (this.config.runwareVideoModel !== VIDU_Q3_MODEL) {
      throw new ServiceUnavailableException(
        "RUNWARE_VIDEO_MODEL must be vidu:4@1",
      );
    }

    const task: ViduQ3RunwareTask = {
      taskType: "videoInference",
      taskUUID: request.taskId,
      model: this.config.runwareVideoModel,
      positivePrompt: request.prompt,
      width: request.width,
      height: request.height,
      duration: request.duration,
      inputs: {
        frameImages: [{ image: request.frameImageUrl!, frame: "first" }],
      },
      providerSettings: { vidu: { audio: false } },
      deliveryMethod: "async",
      numberResults: 1,
      outputType: "URL",
      outputFormat: "MP4",
      includeCost: true,
      uploadEndpoint: request.uploadUrl,
      webhookURL: createRunwareWebhookUrl(this.config),
    };

    const result = await this.client.submit(task);
    if (result.providerTaskId !== request.taskId) {
      throw new RunwareSubmissionError(
        "PROVIDER",
        "provider task ID does not match task ID",
        false,
      );
    }
    return { providerTaskId: result.providerTaskId };
  }

  private validate(request: GenerationProviderSubmission): void {
    if (!request.frameImageUrl) {
      throw new BadRequestException("a Q3 first-frame image is required");
    }
    if (request.prompt.length < 2 || request.prompt.length > 2000) {
      throw new BadRequestException(
        "prompt must be between 2 and 2,000 characters for Vidu Q3",
      );
    }
    if (
      !Number.isInteger(request.duration) ||
      request.duration < 1 ||
      request.duration > 16
    ) {
      throw new BadRequestException(
        "duration must be an integer from 1 to 16 for Vidu Q3",
      );
    }
    if (!SUPPORTED_DIMENSIONS.has(`${request.width}x${request.height}`)) {
      throw new BadRequestException("dimensions must be 1280x720 for Vidu Q3");
    }
  }
}
