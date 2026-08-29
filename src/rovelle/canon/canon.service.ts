import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  RovelleAssetStatus,
  RovelleAssetType,
  RovelleCanonEntityType,
  RovelleCanonVersionStatus,
} from "../../generated/prisma/client";
import { AssetService } from "../assets/asset.service";
import { toCanonEntityDto, toCanonVersionDto } from "./canon-mapper";
import {
  CanonRepository,
  type CanonVersionWithAssets,
} from "./canon.repository";
import type {
  AttachCanonAssetRequestDto,
  CreateCanonEntityRequestDto,
  CreateCanonVersionRequestDto,
  UpdateCanonVersionRequestDto,
} from "./dto/canon.dto";
import {
  normalizeAttachCanonAssetRequest,
  normalizeCanonVersionRequest,
  normalizeCreateCanonEntityRequest,
} from "./canon-validation";

@Injectable()
export class CanonService {
  constructor(
    private readonly repository: CanonRepository,
    private readonly assetService: AssetService,
  ) {}

  async createEntity(request: CreateCanonEntityRequestDto) {
    const entity = await this.repository.createEntity(
      normalizeCreateCanonEntityRequest(request),
    );

    return toCanonEntityDto(entity);
  }

  async listEntities() {
    return (await this.repository.listEntities()).map(toCanonEntityDto);
  }

  async getEntity(id: string) {
    const entity = await this.repository.findEntity(id);

    if (!entity) throw new NotFoundException("Rovelle canon entity not found");

    return toCanonEntityDto(entity);
  }

  async createVersion(
    entityId: string,
    request: CreateCanonVersionRequestDto,
  ) {
    const normalized = normalizeCanonVersionRequest(request);
    const result = await this.repository.createDraftVersion(
      entityId,
      normalized.definition,
    );

    if (result.status === "not_found") {
      throw new NotFoundException("Rovelle canon entity not found");
    }

    return toCanonVersionDto(
      await this.findVersionOrThrow(result.version.id),
    );
  }

  async getVersion(id: string) {
    return toCanonVersionDto(await this.findVersionOrThrow(id));
  }

  async updateVersion(
    id: string,
    request: UpdateCanonVersionRequestDto,
  ) {
    const normalized = normalizeCanonVersionRequest(request);
    this.requireDraft(await this.findVersionOrThrow(id));

    const version = await this.repository.updateDraftDefinition(
      id,
      normalized.definition,
    );

    if (!version) {
      throw new BadRequestException(
        "Only draft canon versions can be updated",
      );
    }

    return toCanonVersionDto(version);
  }

  async attachAsset(
    versionId: string,
    request: AttachCanonAssetRequestDto,
  ) {
    const normalized = normalizeAttachCanonAssetRequest(request);
    const version = await this.findVersionOrThrow(versionId);
    this.requireDraft(version);

    const asset = await this.assetService.getAsset(normalized.assetId);
    if (asset.status !== RovelleAssetStatus.AVAILABLE) {
      throw new BadRequestException(
        "Only available assets can be attached to canon versions",
      );
    }

    const expectedAssetType = {
      [RovelleCanonEntityType.CHARACTER]:
        RovelleAssetType.CHARACTER_REFERENCE,
      [RovelleCanonEntityType.ENVIRONMENT]:
        RovelleAssetType.ENVIRONMENT_REFERENCE,
      [RovelleCanonEntityType.STYLE]: RovelleAssetType.STYLE_REFERENCE,
    }[version.entity.entityType];

    if (asset.assetType !== expectedAssetType) {
      throw new BadRequestException(
        "Asset type is incompatible with canon entity type",
      );
    }

    const result = await this.repository.attachAsset(versionId, normalized);

    if (result.status === "not_found") {
      throw new NotFoundException("Rovelle canon version not found");
    }
    if (result.status === "invalid_state") {
      throw new BadRequestException("Only draft canon versions can be modified");
    }
    if (result.status === "conflict") {
      throw new BadRequestException("Canon asset is already attached to this version");
    }

    return toCanonVersionDto(result.version);
  }

  async detachAsset(versionId: string, assetId: string) {
    this.requireDraft(await this.findVersionOrThrow(versionId));

    const result = await this.repository.detachAsset(versionId, assetId);

    if (result.status === "not_found") {
      throw new NotFoundException("Rovelle canon version not found");
    }
    if (result.status === "invalid_state") {
      throw new BadRequestException("Only draft canon versions can be modified");
    }

    return toCanonVersionDto(result.version);
  }

  async lockVersion(id: string) {
    const result = await this.repository.lockVersion(id);

    if (result.status === "not_found") {
      throw new NotFoundException("Rovelle canon version not found");
    }
    if (result.status === "invalid_state") {
      throw new BadRequestException("Only draft canon versions can be locked");
    }
    if (result.status === "no_assets") {
      throw new BadRequestException(
        "At least one canon asset is required before locking",
      );
    }

    return toCanonVersionDto(result.version);
  }

  private async findVersionOrThrow(id: string): Promise<CanonVersionWithAssets> {
    const version = await this.repository.findVersion(id);

    if (!version) throw new NotFoundException("Rovelle canon version not found");

    return version;
  }

  private requireDraft(version: CanonVersionWithAssets): void {
    if (version.status !== RovelleCanonVersionStatus.DRAFT) {
      throw new BadRequestException("Only draft canon versions can be modified");
    }
  }
}
