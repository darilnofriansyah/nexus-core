import { Module } from "@nestjs/common";
import { EpisodeController } from "./episode.controller";
import { EpisodeRepository } from "./episode.repository";
import { EpisodeService } from "./episode.service";

@Module({
  controllers: [EpisodeController],
  providers: [EpisodeRepository, EpisodeService],
  exports: [EpisodeService],
})
export class ProductionModule {}
