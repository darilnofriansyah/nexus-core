import { Module } from "@nestjs/common";
import { AssetController } from "./asset.controller";
import { AssetRepository } from "./asset.repository";
import { AssetService } from "./asset.service";
import {
  r2S3ClientProvider,
  r2UrlSignerProvider,
} from "./r2-storage.providers";
import { R2StorageService } from "./r2-storage.service";

@Module({
  controllers: [AssetController],
  providers: [
    r2S3ClientProvider,
    r2UrlSignerProvider,
    R2StorageService,
    AssetRepository,
    AssetService,
  ],
  exports: [R2StorageService, AssetService],
})
export class AssetsModule {}
