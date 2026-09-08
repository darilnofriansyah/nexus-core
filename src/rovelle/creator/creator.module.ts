import { Module } from "@nestjs/common";
import { PrismaModule } from "../../database/prisma.module";
import { CanonModule } from "../canon/canon.module";
import { GenerationModule } from "../generation/generation.module";
import { ProductionModule } from "../production/production.module";
import { ReviewModule } from "../review/review.module";
import { CreatorController } from "./creator.controller";
import { CreatorRepository } from "./creator.repository";
import { CreatorService } from "./creator.service";

@Module({
  imports: [PrismaModule, ProductionModule, CanonModule, GenerationModule, ReviewModule],
  controllers: [CreatorController],
  providers: [CreatorRepository, CreatorService],
  exports: [CreatorService],
})
export class CreatorModule {}
