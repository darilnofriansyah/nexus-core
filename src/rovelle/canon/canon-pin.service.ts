import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { toCanonVersionDto } from "./canon-mapper";
import {
  CanonPinRepository,
  type CanonPinWithVersion,
  type PinMutationResult,
} from "./canon-pin.repository";
import type { CanonPinDto, PinCanonVersionRequestDto } from "./dto/canon.dto";
import { normalizePinCanonVersionRequest } from "./canon-validation";

@Injectable()
export class CanonPinService {
  constructor(private readonly repository: CanonPinRepository) {}

  async pinEpisode(
    episodeId: string,
    canonEntityId: string,
    request: PinCanonVersionRequestDto,
  ): Promise<CanonPinDto> {
    const canonVersionId = normalizePinCanonVersionRequest(request).canonVersionId;
    const result = await this.repository.pinEpisodeVersion(
      episodeId,
      canonEntityId,
      canonVersionId,
    );
    if (result.status !== "pinned") {
      this.mapMutationFailure(result);
      throw new Error("Unreachable pin mutation result");
    }

    const pin = (await this.repository.listEpisodePins(episodeId)).find(
      (candidate) =>
        candidate.canonEntityId === canonEntityId &&
        candidate.canonVersionId === result.pin.canonVersionId,
    );
    if (!pin) throw new NotFoundException("Rovelle canon pin target not found");
    return this.toPinDto(pin, "EPISODE");
  }

  async unpinEpisode(episodeId: string, canonEntityId: string): Promise<void> {
    const result = await this.repository.unpinEpisodeEntity(
      episodeId,
      canonEntityId,
    );
    this.mapMutationFailure(result);
  }

  async listEpisodePins(episodeId: string): Promise<CanonPinDto[]> {
    return (await this.repository.listEpisodePins(episodeId)).map((pin) =>
      this.toPinDto(pin, "EPISODE"),
    );
  }

  async pinShot(
    shotId: string,
    canonEntityId: string,
    request: PinCanonVersionRequestDto,
  ): Promise<CanonPinDto> {
    const canonVersionId = normalizePinCanonVersionRequest(request).canonVersionId;
    const result = await this.repository.pinShotVersion(
      shotId,
      canonEntityId,
      canonVersionId,
    );
    if (result.status !== "pinned") {
      this.mapMutationFailure(result);
      throw new Error("Unreachable pin mutation result");
    }

    const effective = await this.repository.getEffectiveShotPins(shotId);
    if (!effective) throw new NotFoundException("Rovelle shot not found");
    const pin = effective.canonPins.find(
      (candidate) =>
        candidate.canonEntityId === canonEntityId &&
        candidate.canonVersionId === result.pin.canonVersionId,
    );
    if (!pin) throw new NotFoundException("Rovelle canon pin target not found");
    return this.toPinDto(pin, "SHOT");
  }

  async unpinShot(shotId: string, canonEntityId: string): Promise<void> {
    const result = await this.repository.unpinShotEntity(shotId, canonEntityId);
    this.mapMutationFailure(result);
  }

  async getEffectiveShotCanon(shotId: string): Promise<CanonPinDto[]> {
    const pins = await this.repository.getEffectiveShotPins(shotId);
    if (!pins) throw new NotFoundException("Rovelle shot not found");

    const effective = new Map<string, CanonPinDto>();
    for (const pin of pins.episode.canonPins) {
      effective.set(pin.canonEntityId, this.toPinDto(pin, "EPISODE"));
    }
    for (const pin of pins.canonPins) {
      effective.set(pin.canonEntityId, this.toPinDto(pin, "SHOT"));
    }

    return [...effective.values()].sort((left, right) =>
      left.version.entity.code < right.version.entity.code
        ? -1
        : left.version.entity.code > right.version.entity.code
          ? 1
          : 0,
    );
  }

  private toPinDto(
    pin: CanonPinWithVersion,
    source: CanonPinDto["source"],
  ): CanonPinDto {
    return { source, version: toCanonVersionDto(pin.canonVersion) };
  }

  private mapMutationFailure(result: PinMutationResult): void {
    if (result.status === "unpinned") return;
    if (result.status === "pinned") return;
    if (result.status === "not_found") {
      throw new NotFoundException("Rovelle canon pin target not found");
    }
    if (result.status === "episode_locked") {
      throw new BadRequestException(
        "Canon pins cannot be changed after generation begins",
      );
    }
    if (result.status === "version_not_locked") {
      throw new BadRequestException("Canon pins require a locked canon version");
    }
    throw new BadRequestException(
      "Canon version does not belong to the requested entity",
    );
  }
}
