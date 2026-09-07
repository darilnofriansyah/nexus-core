import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type {
  GenerationReviewResultDto,
  SubmitHumanReviewRequestDto,
} from "./dto/review.dto";
import { GenerationReviewRepository } from "./generation-review.repository";
import { normalizeSubmitHumanReviewRequest } from "./review-validation";

@Injectable()
export class GenerationReviewService {
  constructor(private readonly repository: GenerationReviewRepository) {}

  async submitHumanReview(
    generationId: string,
    request: SubmitHumanReviewRequestDto,
  ): Promise<GenerationReviewResultDto> {
    const normalized = normalizeSubmitHumanReviewRequest(request);
    const result = await this.repository.submitHumanReview({
      clientRequestId: normalized.requestId,
      generationId,
      decision: normalized.decision,
      notes: normalized.notes ?? null,
    });

    if (result.status === "reviewed" || result.status === "existing") {
      return {
        review: {
          id: result.review.id,
          requestId: result.review.clientRequestId,
          generationId: result.review.generationId,
          reviewerType: "HUMAN",
          decision: humanDecision(result.review.decision),
          notes: result.review.notes,
          createdAt: result.review.createdAt.toISOString(),
        },
        generation: result.generation,
        shot: result.shot,
        episode: result.episode,
      };
    }
    if (result.status === "not_found") {
      throw new NotFoundException("Rovelle generation not found");
    }
    if (result.status === "request_conflict") {
      throw new ConflictException(
        "Generation review request ID was already used for another generation",
      );
    }
    if (result.status === "generation_not_reviewable") {
      throw new BadRequestException(
        "Only completed generations can receive review",
      );
    }
    if (result.status === "output_not_available") {
      throw new BadRequestException(
        "Generation output is not available for review",
      );
    }
    throw new BadRequestException("Shot is not awaiting generation review");
  }
}

function humanDecision(decision: string): "APPROVE" | "REJECT" | "REGENERATE" {
  if (
    decision === "APPROVE" ||
    decision === "REJECT" ||
    decision === "REGENERATE"
  ) {
    return decision;
  }
  throw new BadRequestException("Stored review is not a human decision");
}
