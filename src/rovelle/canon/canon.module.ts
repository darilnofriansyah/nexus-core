import { Module } from "@nestjs/common";
import { AssetsModule } from "../assets/assets.module";
import { CanonController } from "./canon.controller";
import { CanonPinRepository } from "./canon-pin.repository";
import { CanonPinService } from "./canon-pin.service";
import { CanonRepository } from "./canon.repository";
import { CanonService } from "./canon.service";
import { EpisodeCanonController } from "./episode-canon.controller";
import { ShotCanonController } from "./shot-canon.controller";

@Module({
  imports: [AssetsModule],
  controllers: [
    CanonController,
    EpisodeCanonController,
    ShotCanonController,
  ],
  providers: [
    CanonRepository,
    CanonService,
    CanonPinRepository,
    CanonPinService,
  ],
  exports: [CanonService, CanonPinService],
})
export class CanonModule {}
