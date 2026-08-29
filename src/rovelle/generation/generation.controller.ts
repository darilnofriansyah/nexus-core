import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import { ok } from "../../common/dto/api-response.dto";
import type { SubmitShotGenerationRequestDto } from "./dto/generation.dto";
import { GenerationService } from "./generation.service";

@Controller("rovelle")
export class GenerationController {
  constructor(private readonly generationService: GenerationService) {}

  @Post("shots/:shotId/generations")
  async submitShot(
    @Param("shotId") shotId: string,
    @Body() body: SubmitShotGenerationRequestDto,
  ) {
    return ok(await this.generationService.submitShot(shotId, body));
  }

  @Get("shots/:shotId/generations")
  async listShotGenerations(@Param("shotId") shotId: string) {
    return ok(await this.generationService.listShotGenerations(shotId));
  }

  @Get("generations/:generationId")
  async getGeneration(@Param("generationId") generationId: string) {
    return ok(await this.generationService.getGeneration(generationId));
  }
}
