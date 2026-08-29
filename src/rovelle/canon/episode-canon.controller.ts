import { Body, Controller, Delete, Get, Param, Put } from "@nestjs/common";
import { ok } from "../../common/dto/api-response.dto";
import type { PinCanonVersionRequestDto } from "./dto/canon.dto";
import { CanonPinService } from "./canon-pin.service";

@Controller("rovelle/episodes/:episodeId/canon")
export class EpisodeCanonController {
  constructor(private readonly canonPinService: CanonPinService) {}

  @Get()
  async getCanon(@Param("episodeId") episodeId: string) {
    return ok(await this.canonPinService.listEpisodePins(episodeId));
  }

  @Put(":entityId")
  async pinCanon(
    @Param("episodeId") episodeId: string,
    @Param("entityId") entityId: string,
    @Body() body: PinCanonVersionRequestDto,
  ) {
    return ok(
      await this.canonPinService.pinEpisode(episodeId, entityId, body),
    );
  }

  @Delete(":entityId")
  async unpinCanon(
    @Param("episodeId") episodeId: string,
    @Param("entityId") entityId: string,
  ) {
    await this.canonPinService.unpinEpisode(episodeId, entityId);
    return ok({ removed: true });
  }
}
