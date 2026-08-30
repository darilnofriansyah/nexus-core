import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import { ok } from "../../common/dto/api-response.dto";
import type {
  CreateRenderRequestDto,
  RetryRenderRequestDto,
} from "./dto/render.dto";
import { RenderService } from "./render.service";

@Controller("rovelle")
export class RenderController {
  constructor(private readonly renderService: RenderService) {}

  @Post("episodes/:episodeId/renders")
  async createRender(
    @Param("episodeId") episodeId: string,
    @Body() body: CreateRenderRequestDto,
  ) {
    return ok(await this.renderService.createRender(episodeId, body));
  }

  @Get("episodes/:episodeId/renders")
  async listEpisodeRenders(@Param("episodeId") episodeId: string) {
    return ok(await this.renderService.listEpisodeRenders(episodeId));
  }

  @Get("renders/:renderId")
  async getRender(@Param("renderId") renderId: string) {
    return ok(await this.renderService.getRender(renderId));
  }

  @Post("renders/:renderId/retry")
  async retryRender(
    @Param("renderId") renderId: string,
    @Body() body: RetryRenderRequestDto,
  ) {
    return ok(await this.renderService.retryRender(renderId, body));
  }
}
