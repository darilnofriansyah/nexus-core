import { BadRequestException, Body, Controller, Get, Param, Post, Query } from "@nestjs/common";
import { ok } from "../../common/dto/api-response.dto";
import type { SubmitFinalRenderReviewRequestDto } from "./dto/final-review.dto";
import { FinalReviewQueueService } from "./final-review-queue.service";
import { FinalReviewService } from "./final-review.service";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function assertUuid(value: string, field: string): string {
  const normalized = value.trim();
  if (!UUID_PATTERN.test(normalized)) {
    throw new BadRequestException(`${field} must be a valid UUID`);
  }

  return normalized;
}

@Controller("rovelle")
export class FinalReviewController {
  constructor(
    private readonly finalReviewService: FinalReviewService,
    private readonly queueService: FinalReviewQueueService,
  ) {}

  @Post("renders/:renderId/final-reviews")
  async submitHumanReview(
    @Param("renderId") renderId: string,
    @Body() body: SubmitFinalRenderReviewRequestDto,
  ) {
    const normalizedRenderId = assertUuid(renderId, "renderId");
    return ok(
      await this.finalReviewService.submitHumanReview(normalizedRenderId, body),
    );
  }

  @Get("renders/:renderId/final-reviews")
  async listRenderReviews(@Param("renderId") renderId: string) {
    const normalizedRenderId = assertUuid(renderId, "renderId");
    return ok(await this.finalReviewService.listRenderReviews(normalizedRenderId));
  }

  @Get("final-reviews/queue")
  async listQueue(@Query("episodeId") episodeId?: string) {
    const normalizedEpisodeId =
      episodeId === undefined ? undefined : assertUuid(episodeId, "episodeId");
    return ok(await this.queueService.listQueue(normalizedEpisodeId));
  }

  @Get("episodes/:episodeId/final-master")
  async getApprovedFinalMaster(@Param("episodeId") episodeId: string) {
    const normalizedEpisodeId = assertUuid(episodeId, "episodeId");
    return ok(await this.queueService.getApprovedFinalMaster(normalizedEpisodeId));
  }
}
