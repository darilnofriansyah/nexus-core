import { randomUUID } from "node:crypto";
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { buildAssetStorageKey } from "../assets/asset-validation";
import type {
  CreateRenderRequestDto,
  RetryRenderRequestDto,
} from "./dto/render.dto";
import { toRenderDto, type RenderDto } from "./render-mapper";
import { RenderRepository } from "./render.repository";
import {
  normalizeCreateRenderRequest,
  normalizeRetryRenderRequest,
} from "./render-validation";

@Injectable()
export class RenderService {
  constructor(private readonly repository: RenderRepository) {}

  async createRender(
    episodeId: string,
    request: CreateRenderRequestDto,
  ): Promise<RenderDto> {
    const normalized = normalizeCreateRenderRequest(request);
    const outputAssetId = randomUUID();
    const result = await this.repository.createQueuedRender({
      clientRequestId: normalized.requestId,
      episodeId,
      audioAssetId: normalized.audioAssetId,
      captionAssetId: normalized.captionAssetId ?? null,
      outputAssetId,
      outputStorageKey: buildAssetStorageKey(outputAssetId),
    });

    if (result.status === "created" || result.status === "existing") {
      return toRenderDto(result.render);
    }
    if (result.status === "episode_not_found") {
      throw new NotFoundException("Rovelle episode not found");
    }
    if (result.status === "invalid_episode_state") {
      throw new BadRequestException(
        "Episode must be generation-approved before rendering",
      );
    }
    if (result.status === "no_shots") {
      throw new BadRequestException(
        "Episode must contain at least one approved shot",
      );
    }
    if (result.status === "shot_not_approved") {
      throw new BadRequestException(
        "Every shot must have an approved generation before rendering",
      );
    }
    if (result.status === "approved_generation_invalid") {
      throw new BadRequestException(
        "An approved shot generation is not renderable",
      );
    }
    if (result.status === "audio_invalid") {
      throw new BadRequestException("Audio master is not valid for this episode");
    }
    throw new BadRequestException("Caption asset is not valid for this episode");
  }

  async getRender(renderId: string): Promise<RenderDto> {
    const render = await this.repository.findRender(renderId);
    if (!render) throw new NotFoundException("Rovelle render not found");
    return toRenderDto(render);
  }

  async listEpisodeRenders(episodeId: string): Promise<RenderDto[]> {
    return (await this.repository.listEpisodeRenders(episodeId)).map(toRenderDto);
  }

  async retryRender(
    renderId: string,
    request: RetryRenderRequestDto,
  ): Promise<RenderDto> {
    const normalized = normalizeRetryRenderRequest(request);
    const result = await this.repository.retryRender({
      renderId,
      clientRequestId: normalized.requestId,
    });

    if (result.status === "queued" || result.status === "existing") {
      return toRenderDto(result.render);
    }
    if (result.status === "not_found") {
      throw new NotFoundException("Rovelle render not found");
    }
    if (result.status === "request_conflict") {
      throw new ConflictException(
        "Render retry request ID was already used for another render",
      );
    }
    if (result.status === "invalid_render_state") {
      throw new BadRequestException("Only failed renders can be retried");
    }
    if (result.status === "invalid_episode_state") {
      throw new BadRequestException(
        "Episode is not in a renderable retry state",
      );
    }
    if (result.status === "output_not_retryable") {
      throw new BadRequestException(
        "Render output reservation cannot be retried",
      );
    }
    throw new ConflictException("Render already has an active job");
  }
}
