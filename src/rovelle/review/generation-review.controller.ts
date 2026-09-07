import {
  BadRequestException,
  Body,
  Controller,
  Param,
  Post,
} from "@nestjs/common";
import { ok } from "../../common/dto/api-response.dto";
import type { SubmitHumanReviewRequestDto } from "./dto/review.dto";
import { GenerationReviewService } from "./generation-review.service";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Controller("rovelle")
export class GenerationReviewController {
  constructor(private readonly service: GenerationReviewService) {}

  @Post("generations/:generationId/reviews")
  async submitHumanReview(
    @Param("generationId") generationId: string,
    @Body() body: SubmitHumanReviewRequestDto,
  ) {
    const normalized = generationId.trim().toLowerCase();
    if (!UUID_PATTERN.test(normalized)) {
      throw new BadRequestException("generationId must be a valid UUID");
    }
    return ok(await this.service.submitHumanReview(normalized, body));
  }
}
