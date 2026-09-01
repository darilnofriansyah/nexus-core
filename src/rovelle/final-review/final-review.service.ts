import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type {
  FinalRenderReviewDto,
  SubmitFinalRenderReviewRequestDto,
} from "./dto/final-review.dto";
import {
  toFinalRenderReviewDto,
  toFinalRenderReviewResultDto,
  type FinalRenderReviewResultDto,
} from "./final-review-mapper";
import { FinalReviewRepository } from "./final-review.repository";
import { normalizeFinalRenderReviewRequest } from "./final-review-validation";
import { RenderService } from "../render/render.service";

@Injectable()
export class FinalReviewService {
  constructor(
    private readonly repository: FinalReviewRepository,
    private readonly renderService: RenderService,
  ) {}

  async submitHumanReview(
    renderId: string,
    request: SubmitFinalRenderReviewRequestDto,
  ): Promise<FinalRenderReviewResultDto> {
    const normalized = normalizeFinalRenderReviewRequest(request);
    const result = await this.repository.submitHumanReview({
      clientRequestId: normalized.requestId,
      renderId,
      decision: normalized.decision,
      notes: normalized.notes ?? null,
    });

    if (result.status === "reviewed" || result.status === "existing") {
      return toFinalRenderReviewResultDto(result);
    }
    if (result.status === "not_found") {
      throw new NotFoundException("Rovelle render not found");
    }
    if (result.status === "request_conflict") {
      throw new ConflictException(
        "Final review request ID was already used for another render",
      );
    }
    if (result.status === "render_not_reviewable") {
      throw new BadRequestException(
        "Only completed renders can receive final review",
      );
    }
    if (result.status === "output_not_available") {
      throw new BadRequestException(
        "Render output is not available for final review",
      );
    }
    throw new BadRequestException(
      "Episode is not awaiting final render review",
    );
  }

  async listRenderReviews(renderId: string): Promise<FinalRenderReviewDto[]> {
    await this.renderService.getRender(renderId);
    return (await this.repository.listRenderReviews(renderId)).map(
      toFinalRenderReviewDto,
    );
  }
}
