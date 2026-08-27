import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import { ok } from "../../common/dto/api-response.dto";
import type { CreateAssetReservationRequestDto } from "./dto/asset.dto";
import { AssetService } from "./asset.service";

@Controller("rovelle/assets")
export class AssetController {
  constructor(private readonly assetService: AssetService) {}

  @Post("reservations")
  async reserve(@Body() body: CreateAssetReservationRequestDto) {
    return ok(await this.assetService.reserve(body));
  }

  @Get(":id")
  async getAsset(@Param("id") id: string) {
    return ok(await this.assetService.getAsset(id));
  }

  @Post(":id/upload-url")
  async createUploadUrl(@Param("id") id: string) {
    return ok(await this.assetService.createUploadUrl(id));
  }

  @Post(":id/confirm")
  async confirmUpload(@Param("id") id: string) {
    return ok(await this.assetService.confirmUpload(id));
  }

  @Post(":id/read-url")
  async createReadUrl(@Param("id") id: string) {
    return ok(await this.assetService.createReadUrl(id));
  }
}
