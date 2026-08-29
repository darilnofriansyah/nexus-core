import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from "@nestjs/common";
import { SkipCoreApiKey } from "../../../common/decorators/skip-core-api-key.decorator";
import { ok } from "../../../common/dto/api-response.dto";
import { parseRunwareWebhook } from "./runware-webhook.parser";
import { RunwareWebhookGuard } from "./runware-webhook.guard";
import { RunwareWebhookService } from "./runware-webhook.service";

@Controller("rovelle/webhooks")
@SkipCoreApiKey()
@UseGuards(RunwareWebhookGuard)
export class RunwareWebhookController {
  constructor(private readonly service: RunwareWebhookService) {}

  @Post("runware")
  @HttpCode(HttpStatus.OK)
  async handle(@Body() body: unknown) {
    const event = parseRunwareWebhook(body);
    return ok(await this.service.handle(event));
  }
}
