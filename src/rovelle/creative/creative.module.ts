import { Module } from "@nestjs/common";
import { PrismaModule } from "../../database/prisma.module";
import { CanonModule } from "../canon/canon.module";
import { CreatorRepository } from "../creator/creator.repository";
import { ProductionModule } from "../production/production.module";
import { CreativeApprovalService } from "./creative-approval.service";
import { CreativeController } from "./creative.controller";
import { CreativeRepository } from "./creative.repository";
import { CreativeWorkerGuard } from "./creative-worker.guard";
import { readEnv, validateRovelleCreativeEnv } from "../../config/env";

@Module({
  imports: [PrismaModule, CanonModule, ProductionModule],
  controllers: [CreativeController],
  providers: [
    CreatorRepository,
    CreativeRepository,
    CreativeApprovalService,
    CreativeWorkerGuard,
    {
      provide: "ROVELLE_CREATIVE_CONFIG_VALIDATED",
      useFactory: () => {
        validateRovelleCreativeEnv(readEnv());
        return true;
      },
    },
  ],
  exports: [CreatorRepository, CreativeRepository, CreativeApprovalService],
})
export class CreativeModule {}
