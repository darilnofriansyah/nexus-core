import { Module } from "@nestjs/common";
import { RenderController } from "./render.controller";
import { RenderRepository } from "./render.repository";
import { RenderService } from "./render.service";

@Module({
  controllers: [RenderController],
  providers: [RenderRepository, RenderService],
  exports: [RenderRepository, RenderService],
})
export class RenderModule {}
