import { Body, Controller, Get, Header, HttpCode, Param, Post } from "@nestjs/common";
import { SkipCoreApiKey } from "../../common/decorators/skip-core-api-key.decorator";
import { ok } from "../../common/dto/api-response.dto";
import { CreatorUploadService } from "./creator-upload.service";

@Controller("rovelle/creator/uploads")
@SkipCoreApiKey()
export class CreatorUploadController {
  constructor(private readonly uploads: CreatorUploadService) {}

  @Get(":token")
  @Header("Cache-Control", "no-store")
  @Header("Referrer-Policy", "no-referrer")
  @Header("Content-Type", "text/html; charset=utf-8")
  page(@Param("token") token: string) {
    return this.uploads.page(token);
  }

  @Post(":token/prepare")
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  @Header("Referrer-Policy", "no-referrer")
  async prepare(@Param("token") token: string, @Body() body: unknown) {
    return ok(await this.uploads.prepare(token, body));
  }

  @Post(":token/complete")
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  @Header("Referrer-Policy", "no-referrer")
  async complete(@Param("token") token: string) {
    return ok(await this.uploads.complete(token));
  }
}
