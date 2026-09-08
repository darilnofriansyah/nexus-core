import { Module } from "@nestjs/common";
import { PrismaModule } from "../../database/prisma.module";
import { CreatorController } from "./creator.controller";
import { CreatorRepository } from "./creator.repository";
import { CreatorService } from "./creator.service";

@Module({
  imports: [PrismaModule],
  controllers: [CreatorController],
  providers: [CreatorRepository, CreatorService],
  exports: [CreatorService],
})
export class CreatorModule {}
