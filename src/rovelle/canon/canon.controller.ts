import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
} from "@nestjs/common";
import { ok } from "../../common/dto/api-response.dto";
import type {
  AttachCanonAssetRequestDto,
  CreateCanonEntityRequestDto,
  CreateCanonVersionRequestDto,
  UpdateCanonVersionRequestDto,
} from "./dto/canon.dto";
import { CanonService } from "./canon.service";

@Controller("rovelle/canon")
export class CanonController {
  constructor(private readonly canonService: CanonService) {}

  @Post("entities")
  async createEntity(@Body() body: CreateCanonEntityRequestDto) {
    return ok(await this.canonService.createEntity(body));
  }

  @Get("entities")
  async listEntities() {
    return ok(await this.canonService.listEntities());
  }

  @Get("entities/:entityId")
  async getEntity(@Param("entityId") entityId: string) {
    return ok(await this.canonService.getEntity(entityId));
  }

  @Post("entities/:entityId/versions")
  async createVersion(
    @Param("entityId") entityId: string,
    @Body() body: CreateCanonVersionRequestDto,
  ) {
    return ok(await this.canonService.createVersion(entityId, body));
  }

  @Get("versions/:versionId")
  async getVersion(@Param("versionId") versionId: string) {
    return ok(await this.canonService.getVersion(versionId));
  }

  @Put("versions/:versionId")
  async updateVersion(
    @Param("versionId") versionId: string,
    @Body() body: UpdateCanonVersionRequestDto,
  ) {
    return ok(await this.canonService.updateVersion(versionId, body));
  }

  @Post("versions/:versionId/assets")
  async attachAsset(
    @Param("versionId") versionId: string,
    @Body() body: AttachCanonAssetRequestDto,
  ) {
    return ok(await this.canonService.attachAsset(versionId, body));
  }

  @Delete("versions/:versionId/assets/:assetId")
  async detachAsset(
    @Param("versionId") versionId: string,
    @Param("assetId") assetId: string,
  ) {
    await this.canonService.detachAsset(versionId, assetId);
    return ok({ removed: true });
  }

  @Post("versions/:versionId/lock")
  async lockVersion(@Param("versionId") versionId: string) {
    return ok(await this.canonService.lockVersion(versionId));
  }
}
