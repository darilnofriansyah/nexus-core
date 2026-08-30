import { Module } from "@nestjs/common";
import { AssetsModule } from "./assets/assets.module";
import { CanonModule } from "./canon/canon.module";
import { GenerationModule } from "./generation/generation.module";
import { ProductionModule } from "./production/production.module";
import { RenderModule } from "./render/render.module";

@Module({
  imports: [
    ProductionModule,
    AssetsModule,
    CanonModule,
    GenerationModule,
    RenderModule,
  ],
})
export class RovelleModule {}
