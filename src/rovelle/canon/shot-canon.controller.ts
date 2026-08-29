import { Body, Controller, Delete, Get, Param, Put } from "@nestjs/common";
import { ok } from "../../common/dto/api-response.dto";
import type { PinCanonVersionRequestDto } from "./dto/canon.dto";
import { CanonPinService } from "./canon-pin.service";

@Controller("rovelle/shots/:shotId/canon")
export class ShotCanonController {
  constructor(private readonly canonPinService: CanonPinService) {}

  @Get()
  async getCanon(@Param("shotId") shotId: string) {
    return ok(await this.canonPinService.getEffectiveShotCanon(shotId));
  }

  @Put(":entityId")
  async pinCanon(
    @Param("shotId") shotId: string,
    @Param("entityId") entityId: string,
    @Body() body: PinCanonVersionRequestDto,
  ) {
    return ok(await this.canonPinService.pinShot(shotId, entityId, body));
  }

  @Delete(":entityId")
  async unpinCanon(
    @Param("shotId") shotId: string,
    @Param("entityId") entityId: string,
  ) {
    await this.canonPinService.unpinShot(shotId, entityId);
    return ok({ removed: true });
  }
}
