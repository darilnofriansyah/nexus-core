import { Module } from "@nestjs/common";
import { AssetsModule } from "./assets/assets.module";
import { CanonModule } from "./canon/canon.module";
import { GenerationModule } from "./generation/generation.module";
import { FinalReviewModule } from "./final-review/final-review.module";
import { ProductionModule } from "./production/production.module";
import { RenderModule } from "./render/render.module";
import { ReviewModule } from "./review/review.module";
import { CreatorModule } from "./creator/creator.module";
import { CreativeModule } from "./creative/creative.module";

@Module({
  imports: [
    ProductionModule,
    AssetsModule,
    CanonModule,
    GenerationModule,
    RenderModule,
    FinalReviewModule,
    ReviewModule,
    CreatorModule,
    CreativeModule,
  ],
})
export class RovelleModule {}
