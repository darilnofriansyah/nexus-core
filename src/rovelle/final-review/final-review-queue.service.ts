import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { RovelleEpisodeStatus } from "../../generated/prisma/client";
import type {
  ApprovedFinalMasterDto,
  FinalReviewQueueItemDto,
} from "./dto/final-review.dto";
import { toFinalRenderReviewDto } from "./final-review-mapper";
import { FinalReviewRepository } from "./final-review.repository";
import { toRenderDto } from "../render/render-mapper";
import { AssetService } from "../assets/asset.service";

@Injectable()
export class FinalReviewQueueService {
  constructor(
    private readonly repository: FinalReviewRepository,
    private readonly assetService: AssetService,
  ) {}

  async listQueue(
    episodeId?: string,
  ): Promise<FinalReviewQueueItemDto[]> {
    const candidates = await this.repository.listFinalReviewCandidates(episodeId);

    return Promise.all(
      candidates
        .filter(({ episode }) => episode.status === RovelleEpisodeStatus.FINAL_REVIEW)
        .map(async ({ episode, render, reviews }) => ({
        episode: {
          id: episode.id,
          code: episode.code,
          title: episode.title,
          status: "FINAL_REVIEW" as const,
        },
        render: toRenderDto(render),
        reviews: reviews.map(toFinalRenderReviewDto),
        preview: (
          await this.assetService.createReadUrl(render.outputAssetId)
        ).download,
        })),
    );
  }

  async getApprovedFinalMaster(
    episodeId: string,
  ): Promise<ApprovedFinalMasterDto> {
    const master = await this.repository.findApprovedMaster(episodeId);
    if (!master) {
      if (!(await this.repository.episodeExists(episodeId))) {
        throw new NotFoundException("Rovelle episode not found");
      }
      throw new BadRequestException(
        "Episode does not have an approved final render",
      );
    }

    return {
      episode: master.episode,
      render: toRenderDto(master.render),
      read: (
        await this.assetService.createReadUrl(master.render.outputAssetId)
      ).download,
    };
  }
}
