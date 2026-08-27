import { Body, Controller, Get, Param, Post, Put } from "@nestjs/common";
import { ok } from "../../common/dto/api-response.dto";
import {
  CreateEpisodeRequestDto,
  ReplaceEpisodeShotsRequestDto,
  UpdateEpisodeBriefRequestDto,
} from "./dto/episode.dto";
import { EpisodeService } from "./episode.service";

@Controller("rovelle/episodes")
export class EpisodeController {
  constructor(private readonly episodeService: EpisodeService) {}

  @Post()
  async createEpisode(@Body() body: CreateEpisodeRequestDto) {
    return ok(await this.episodeService.createEpisode(body));
  }

  @Get(":id")
  async getEpisode(@Param("id") id: string) {
    return ok(await this.episodeService.getEpisode(id));
  }

  @Put(":id/brief")
  async updateBrief(
    @Param("id") id: string,
    @Body() body: UpdateEpisodeBriefRequestDto,
  ) {
    return ok(await this.episodeService.updateBrief(id, body));
  }

  @Post(":id/approve-brief")
  async approveBrief(@Param("id") id: string) {
    return ok(await this.episodeService.approveBrief(id));
  }

  @Post(":id/start-preproduction")
  async startPreproduction(@Param("id") id: string) {
    return ok(await this.episodeService.startPreproduction(id));
  }

  @Put(":id/shots")
  async replaceShots(
    @Param("id") id: string,
    @Body() body: ReplaceEpisodeShotsRequestDto,
  ) {
    return ok(await this.episodeService.replaceShots(id, body));
  }

  @Post(":id/mark-ready")
  async markReadyToGenerate(@Param("id") id: string) {
    return ok(await this.episodeService.markReadyToGenerate(id));
  }
}
