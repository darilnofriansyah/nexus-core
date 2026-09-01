import { Module } from "@nestjs/common";
import { AssetsModule } from "../assets/assets.module";
import { RenderModule } from "../render/render.module";
import { FinalReviewController } from "./final-review.controller";
import { FinalReviewQueueService } from "./final-review-queue.service";
import { FinalReviewRepository } from "./final-review.repository";
import { FinalReviewService } from "./final-review.service";

@Module({
  imports: [AssetsModule, RenderModule],
  controllers: [FinalReviewController],
  providers: [
    FinalReviewRepository,
    FinalReviewService,
    FinalReviewQueueService,
  ],
  exports: [
    FinalReviewRepository,
    FinalReviewService,
    FinalReviewQueueService,
  ],
})
export class FinalReviewModule {}
