import { Body, Controller, Post } from "@nestjs/common";
import { ok } from "../../common/dto/api-response.dto";
import { CreatorService } from "./creator.service";
import { normalizeCreatorTelegramRequest } from "./creator-validation";
import type { CreatorTelegramRequestDto } from "./dto/creator.dto";

@Controller("rovelle/creator")
export class CreatorController {
  constructor(private readonly creatorService: CreatorService) {}

  @Post("telegram")
  async handleTelegram(@Body() body: CreatorTelegramRequestDto) {
    return ok(await this.creatorService.handleTelegram(normalizeCreatorTelegramRequest(body)));
  }
}
