import { Module } from "@nestjs/common";
import { AssetsModule } from "./assets/assets.module";
import { ProductionModule } from "./production/production.module";

@Module({
  imports: [ProductionModule, AssetsModule],
})
export class RovelleModule {}
