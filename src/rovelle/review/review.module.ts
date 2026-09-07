import { Module } from "@nestjs/common";
import { GenerationReviewController } from "./generation-review.controller";
import { GenerationReviewRepository } from "./generation-review.repository";
import { GenerationReviewService } from "./generation-review.service";

@Module({
  controllers: [GenerationReviewController],
  providers: [GenerationReviewRepository, GenerationReviewService],
  exports: [GenerationReviewRepository, GenerationReviewService],
})
export class ReviewModule {}
