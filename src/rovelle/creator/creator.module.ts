import { Module } from "@nestjs/common";
import { readEnv } from "../../config/env";
import { PrismaModule } from "../../database/prisma.module";
import { AssetsModule } from "../assets/assets.module";
import { CanonModule } from "../canon/canon.module";
import { GenerationModule } from "../generation/generation.module";
import { ProductionModule } from "../production/production.module";
import { ReviewModule } from "../review/review.module";
import { RenderModule } from "../render/render.module";
import { CreatorController } from "./creator.controller";
import { CreatorRepository } from "./creator.repository";
import { CreatorService } from "./creator.service";
import { CreatorUploadController } from "./creator-upload.controller";
import { CREATOR_UPLOAD_BASE_URL, CreatorUploadService } from "./creator-upload.service";

@Module({
  imports: [PrismaModule, AssetsModule, ProductionModule, CanonModule, GenerationModule, ReviewModule, RenderModule],
  controllers: [CreatorController, CreatorUploadController],
  providers: [
    CreatorRepository,
    CreatorService,
    CreatorUploadService,
    { provide: CREATOR_UPLOAD_BASE_URL, useFactory: () => readEnv().corePublicBaseUrl },
  ],
  exports: [CreatorService],
})
export class CreatorModule {}
