import * as assert from "node:assert/strict";
import { test } from "node:test";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import {
  RovelleAssetStatus,
  RovelleAssetType,
  RovelleCanonEntityType,
  RovelleCanonVersionStatus,
  type RovelleAsset,
  type RovelleCanonAsset,
  type RovelleCanonEntity,
  type RovelleCanonVersion,
} from "../../generated/prisma/client";
import type { AssetDto } from "../assets/dto/asset.dto";
import { AssetService } from "../assets/asset.service";
import {
  CanonRepository,
  type CanonEntityWithVersions,
  type CanonVersionWithAssets,
} from "./canon.repository";
import type {
  AttachCanonAssetRequestDto,
  CreateCanonEntityRequestDto,
} from "./dto/canon.dto";
import { CanonService } from "./canon.service";

const ENTITY_ID = "550e8400-e29b-41d4-a716-446655440000";
const VERSION_ID = "123e4567-e89b-42d3-a456-426614174000";
const VERSION_2_ID = "323e4567-e89b-42d3-a456-426614174000";
const ASSET_ID = "223e4567-e89b-42d3-a456-426614174000";

const createdAt = new Date("2026-08-27T00:00:00.000Z");
const updatedAt = new Date("2026-08-27T00:01:00.000Z");
const lockedAt = new Date("2026-08-27T00:02:00.000Z");

const entity: RovelleCanonEntity = {
  id: ENTITY_ID,
  code: "KOKO",
  displayName: "Koko",
  entityType: RovelleCanonEntityType.CHARACTER,
  description: "The lead character",
  createdAt,
  updatedAt,
};

const baseAsset: RovelleAsset = {
  id: ASSET_ID,
  episodeId: null,
  assetType: RovelleAssetType.CHARACTER_REFERENCE,
  status: RovelleAssetStatus.AVAILABLE,
  mediaType: "image/png",
  storageKey: "rovelle/assets/koko.png",
  originalFilename: "koko.png",
  byteSize: 42n,
  etag: "etag-koko",
  createdAt,
  updatedAt,
};

function makeVersion(
  number: number,
  overrides: Partial<RovelleCanonVersion> = {},
): RovelleCanonVersion {
  return {
    id: number === 1 ? VERSION_ID : VERSION_2_ID,
    entityId: ENTITY_ID,
    version: number,
    status: RovelleCanonVersionStatus.DRAFT,
    definition: { appearance: { color: "yellow" } },
    lockedAt: null,
    createdAt,
    updatedAt,
    ...overrides,
  };
}

function makeEntity(
  entityType: RovelleCanonEntityType = RovelleCanonEntityType.CHARACTER,
): RovelleCanonEntity {
  return { ...entity, entityType };
}

function makeAsset(
  assetType: RovelleAssetType = RovelleAssetType.CHARACTER_REFERENCE,
  status: RovelleAssetStatus = RovelleAssetStatus.AVAILABLE,
): RovelleAsset {
  return { ...baseAsset, assetType, status };
}

function makeAssetDto(
  assetType: RovelleAssetType = RovelleAssetType.CHARACTER_REFERENCE,
  status: RovelleAssetStatus = RovelleAssetStatus.AVAILABLE,
): AssetDto {
  return {
    id: ASSET_ID,
    episodeId: null,
    assetType,
    status,
    mediaType: "image/png",
    originalFilename: "koko.png",
    byteSize: "42",
    etag: "etag-koko",
    createdAt: createdAt.toISOString(),
    updatedAt: updatedAt.toISOString(),
  };
}

function makeAttachment(
  asset: RovelleAsset = baseAsset,
  role = "PORTRAIT",
  sortOrder = 0,
): RovelleCanonAsset & { asset: RovelleAsset } {
  return {
    canonVersionId: VERSION_ID,
    assetId: asset.id,
    role,
    sortOrder,
    createdAt,
    asset,
  };
}

function makeAggregate(
  options: {
    entityType?: RovelleCanonEntityType;
    version?: number;
    status?: RovelleCanonVersionStatus;
    assets?: Array<RovelleCanonAsset & { asset: RovelleAsset }>;
    lockedAt?: Date | null;
  } = {},
): CanonVersionWithAssets {
  const version = makeVersion(options.version ?? 1, {
    status: options.status ?? RovelleCanonVersionStatus.DRAFT,
    lockedAt: options.lockedAt ?? null,
  });

  return {
    ...version,
    entity: makeEntity(options.entityType),
    assets: options.assets ?? [],
  };
}

type AttachResult =
  | { status: "attached"; version: CanonVersionWithAssets }
  | { status: "not_found" }
  | { status: "invalid_state" }
  | { status: "conflict" };

type DetachResult =
  | { status: "detached"; version: CanonVersionWithAssets }
  | { status: "not_found" }
  | { status: "invalid_state" };

type LockResult =
  | { status: "locked"; version: CanonVersionWithAssets }
  | { status: "not_found" }
  | { status: "invalid_state" }
  | { status: "no_assets" };

class FakeCanonRepository {
  entity: RovelleCanonEntity | null = entity;
  version: CanonVersionWithAssets | null = makeAggregate();
  attachmentAsset = baseAsset;
  nextVersion = 0;
  createEntityRequest?: CreateCanonEntityRequestDto;
  createVersionCalls: Array<{
    entityId: string;
    definition: Record<string, unknown>;
  }> = [];
  updateVersionCalls: Array<{
    id: string;
    definition: Record<string, unknown>;
  }> = [];
  attachAssetCalls: Array<{
    versionId: string;
    request: AttachCanonAssetRequestDto;
  }> = [];
  detachAssetCalls: Array<{ versionId: string; assetId: string }> = [];
  lockVersionCalls: string[] = [];

  async createEntity(
    request: CreateCanonEntityRequestDto,
  ): Promise<RovelleCanonEntity> {
    this.createEntityRequest = request;
    return this.entity ?? entity;
  }

  async listEntities(): Promise<RovelleCanonEntity[]> {
    return this.entity ? [this.entity] : [];
  }

  async findEntity(_id: string): Promise<CanonEntityWithVersions | null> {
    if (!this.entity) return null;
    return { ...this.entity, versions: this.version ? [this.version] : [] };
  }

  async createDraftVersion(
    entityId: string,
    definition: Record<string, unknown>,
  ): Promise<
    | { status: "created"; version: RovelleCanonVersion }
    | { status: "not_found" }
  > {
    this.createVersionCalls.push({ entityId, definition });
    if (!this.entity) return { status: "not_found" };

    this.nextVersion += 1;
    const created = makeVersion(this.nextVersion, {
      definition: definition as unknown as RovelleCanonVersion["definition"],
    });
    this.version = {
      ...created,
      entity: this.entity,
      assets: [],
    };
    return { status: "created", version: created };
  }

  async findVersion(id: string): Promise<CanonVersionWithAssets | null> {
    return this.version?.id === id ? this.version : null;
  }

  async updateDraftDefinition(
    id: string,
    definition: Record<string, unknown>,
  ): Promise<CanonVersionWithAssets | null> {
    this.updateVersionCalls.push({ id, definition });
    if (
      !this.version ||
      this.version.id !== id ||
      this.version.status !== RovelleCanonVersionStatus.DRAFT
    ) {
      return null;
    }

    this.version = {
      ...this.version,
      definition: definition as unknown as RovelleCanonVersion["definition"],
    };
    return this.version;
  }

  async attachAsset(
    versionId: string,
    request: AttachCanonAssetRequestDto,
  ): Promise<AttachResult> {
    this.attachAssetCalls.push({ versionId, request });
    if (!this.version || this.version.id !== versionId) {
      return { status: "not_found" };
    }
    if (this.version.status !== RovelleCanonVersionStatus.DRAFT) {
      return { status: "invalid_state" };
    }
    if (
      this.version.assets.some(
        (attachment) =>
          attachment.assetId === request.assetId ||
          (attachment.role === request.role &&
            attachment.sortOrder === (request.sortOrder ?? 0)),
      )
    ) {
      return { status: "conflict" };
    }

    const attachment = makeAttachment(
      { ...this.attachmentAsset, id: request.assetId },
      request.role,
      request.sortOrder ?? 0,
    );
    this.version = {
      ...this.version,
      assets: [...this.version.assets, attachment],
    };
    return { status: "attached", version: this.version };
  }

  async detachAsset(versionId: string, assetId: string): Promise<DetachResult> {
    this.detachAssetCalls.push({ versionId, assetId });
    if (!this.version || this.version.id !== versionId) {
      return { status: "not_found" };
    }
    if (this.version.status !== RovelleCanonVersionStatus.DRAFT) {
      return { status: "invalid_state" };
    }

    this.version = {
      ...this.version,
      assets: this.version.assets.filter(
        (attachment) => attachment.assetId !== assetId,
      ),
    };
    return { status: "detached", version: this.version };
  }

  async lockVersion(versionId: string): Promise<LockResult> {
    this.lockVersionCalls.push(versionId);
    if (!this.version || this.version.id !== versionId) {
      return { status: "not_found" };
    }
    if (this.version.status !== RovelleCanonVersionStatus.DRAFT) {
      return { status: "invalid_state" };
    }
    if (this.version.assets.length === 0) {
      return { status: "no_assets" };
    }

    this.version = {
      ...this.version,
      status: RovelleCanonVersionStatus.LOCKED,
      lockedAt,
    };
    return { status: "locked", version: this.version };
  }
}

class FakeAssetService {
  asset = makeAssetDto();
  getAssetCalls: string[] = [];

  async getAsset(id: string): Promise<AssetDto> {
    this.getAssetCalls.push(id);
    return { ...this.asset, id };
  }
}

function createService(
  options: {
    entityType?: RovelleCanonEntityType;
    assetType?: RovelleAssetType;
    assetStatus?: RovelleAssetStatus;
    version?: CanonVersionWithAssets;
  } = {},
) {
  const repository = new FakeCanonRepository();
  const assetService = new FakeAssetService();
  const entityType = options.entityType ?? RovelleCanonEntityType.CHARACTER;
  const assetType = options.assetType ?? RovelleAssetType.CHARACTER_REFERENCE;

  repository.version =
    options.version ?? makeAggregate({ entityType, assets: [] });
  repository.entity = makeEntity(entityType);
  repository.attachmentAsset = makeAsset(
    assetType,
    RovelleAssetStatus.AVAILABLE,
  );
  assetService.asset = makeAssetDto(
    assetType,
    options.assetStatus ?? RovelleAssetStatus.AVAILABLE,
  );

  return {
    repository,
    assetService,
    service: new CanonService(
      repository as unknown as CanonRepository,
      assetService as unknown as AssetService,
    ),
  };
}

function lockedVersion(
  entityType: RovelleCanonEntityType = RovelleCanonEntityType.CHARACTER,
): CanonVersionWithAssets {
  return makeAggregate({
    entityType,
    status: RovelleCanonVersionStatus.LOCKED,
    lockedAt,
    assets: [makeAttachment()],
  });
}

function attachRequest(
  overrides: Partial<AttachCanonAssetRequestDto> = {},
): AttachCanonAssetRequestDto {
  return {
    assetId: ASSET_ID,
    role: "PORTRAIT",
    sortOrder: 0,
    ...overrides,
  };
}

test("createEntity normalizes input before delegating and maps the entity", async () => {
  const { repository, service } = createService();

  const result = await service.createEntity({
    code: " koko ",
    displayName: " Koko ",
    entityType: RovelleCanonEntityType.CHARACTER,
    description: " The lead character ",
  });

  assert.deepEqual(repository.createEntityRequest, {
    code: "KOKO",
    displayName: "Koko",
    entityType: RovelleCanonEntityType.CHARACTER,
    description: "The lead character",
  });
  assert.equal(result.id, ENTITY_ID);
  assert.equal(result.code, "KOKO");
  assert.equal(result.entityType, RovelleCanonEntityType.CHARACTER);
  assert.equal("versions" in result, false);
});

test("listEntities maps every repository entity", async () => {
  const { repository, service } = createService();
  const second = {
    ...entity,
    id: "423e4567-e89b-42d3-a456-426614174000",
    code: "MEADOW_VILLAGE",
    entityType: RovelleCanonEntityType.ENVIRONMENT,
  };
  repository.entity = entity;
  const originalListEntities = repository.listEntities.bind(repository);
  repository.listEntities = async () => [entity, second];

  const result = await service.listEntities();

  const mapped = result as Array<{ id: string; code: string }>;
  assert.deepEqual(
    mapped.map((item) => ({ id: item.id, code: item.code })),
    [
      { id: ENTITY_ID, code: "KOKO" },
      { id: second.id, code: "MEADOW_VILLAGE" },
    ],
  );
  repository.listEntities = originalListEntities;
});

test("getEntity maps an existing entity without exposing its versions", async () => {
  const { service } = createService();

  const result = await service.getEntity(ENTITY_ID);

  assert.equal(result.id, ENTITY_ID);
  assert.equal(result.code, "KOKO");
  assert.equal("versions" in result, false);
});

test("getEntity maps a missing entity to NotFoundException", async () => {
  const { repository, service } = createService();
  repository.entity = null;

  await assert.rejects(() => service.getEntity(ENTITY_ID), NotFoundException);
});

test("createVersion delegates V1 and V2 allocation to the repository", async () => {
  const { repository, service } = createService();

  const first = await service.createVersion(ENTITY_ID, {
    definition: { appearance: { color: "yellow" } },
  });
  const second = await service.createVersion(ENTITY_ID, {
    definition: { appearance: { color: "blue" } },
  });

  assert.deepEqual(repository.createVersionCalls, [
    {
      entityId: ENTITY_ID,
      definition: { appearance: { color: "yellow" } },
    },
    {
      entityId: ENTITY_ID,
      definition: { appearance: { color: "blue" } },
    },
  ]);
  assert.equal(first.version, 1);
  assert.equal(second.version, 2);
  assert.equal(first.status, RovelleCanonVersionStatus.DRAFT);
  assert.equal(second.status, RovelleCanonVersionStatus.DRAFT);
});

test("createVersion maps a missing entity to NotFoundException", async () => {
  const { repository, service } = createService();
  repository.entity = null;

  await assert.rejects(
    () =>
      service.createVersion(ENTITY_ID, {
        definition: { appearance: { color: "yellow" } },
      }),
    NotFoundException,
  );
});

test("getVersion maps a missing version to NotFoundException", async () => {
  const { repository, service } = createService();
  repository.version = null;

  await assert.rejects(() => service.getVersion(VERSION_ID), NotFoundException);
});

test("updateVersion rejects a locked version with BadRequestException", async () => {
  const { repository, service } = createService({ version: lockedVersion() });

  await assert.rejects(
    () =>
      service.updateVersion(VERSION_ID, {
        definition: { appearance: { color: "blue" } },
      }),
    BadRequestException,
  );
  assert.equal(repository.updateVersionCalls.length, 0);
});

test("attachAsset requires a draft version", async () => {
  const { repository, service } = createService({ version: lockedVersion() });

  await assert.rejects(
    () => service.attachAsset(VERSION_ID, attachRequest()),
    BadRequestException,
  );
  assert.equal(repository.attachAssetCalls.length, 0);
});

test("attachAsset requires an AVAILABLE asset", async () => {
  const { repository, assetService, service } = createService({
    assetStatus: RovelleAssetStatus.RESERVED,
  });

  await assert.rejects(
    () => service.attachAsset(VERSION_ID, attachRequest()),
    BadRequestException,
  );
  assert.deepEqual(assetService.getAssetCalls, [ASSET_ID]);
  assert.equal(repository.attachAssetCalls.length, 0);
});

for (const [entityType, expectedAssetType] of [
  [RovelleCanonEntityType.CHARACTER, RovelleAssetType.CHARACTER_REFERENCE],
  [RovelleCanonEntityType.ENVIRONMENT, RovelleAssetType.ENVIRONMENT_REFERENCE],
  [RovelleCanonEntityType.STYLE, RovelleAssetType.STYLE_REFERENCE],
] as const) {
  test(`${entityType} accepts only its compatible reference asset`, async () => {
    const matching = createService({
      entityType,
      assetType: expectedAssetType,
    });

    await matching.service.attachAsset(VERSION_ID, attachRequest());
    assert.equal(matching.repository.attachAssetCalls.length, 1);

    const wrongType =
      expectedAssetType === RovelleAssetType.CHARACTER_REFERENCE
        ? RovelleAssetType.ENVIRONMENT_REFERENCE
        : RovelleAssetType.CHARACTER_REFERENCE;
    const mismatched = createService({ entityType, assetType: wrongType });

    await assert.rejects(
      () => mismatched.service.attachAsset(VERSION_ID, attachRequest()),
      /Asset type is incompatible with canon entity type/,
    );
    assert.equal(mismatched.repository.attachAssetCalls.length, 0);
  });
}

test("attachAsset maps a duplicate attachment conflict to BadRequestException", async () => {
  const { repository, service } = createService();
  await service.attachAsset(VERSION_ID, attachRequest());

  await assert.rejects(
    () => service.attachAsset(VERSION_ID, attachRequest()),
    BadRequestException,
  );
  assert.equal(repository.attachAssetCalls.length, 2);
});

test("detachAsset allows draft versions and rejects locked versions", async () => {
  const draft = createService({
    version: makeAggregate({ assets: [makeAttachment()] }),
  });
  const detached = await draft.service.detachAsset(VERSION_ID, ASSET_ID);
  assert.equal(detached.assets.length, 0);

  const locked = createService({ version: lockedVersion() });
  await assert.rejects(
    () => locked.service.detachAsset(VERSION_ID, ASSET_ID),
    BadRequestException,
  );
  assert.equal(locked.repository.detachAssetCalls.length, 0);
});

test("lockVersion maps a missing version to NotFoundException", async () => {
  const { repository, service } = createService();
  repository.version = null;

  await assert.rejects(
    () => service.lockVersion(VERSION_ID),
    NotFoundException,
  );
});

test("lockVersion requires a draft version", async () => {
  const { service } = createService({ version: lockedVersion() });

  await assert.rejects(
    () => service.lockVersion(VERSION_ID),
    /Only draft canon versions can be locked/,
  );
});

test("lockVersion requires at least one attached asset", async () => {
  const { service } = createService({ version: makeAggregate({ assets: [] }) });

  await assert.rejects(
    () => service.lockVersion(VERSION_ID),
    /At least one canon asset is required before locking/,
  );
});

test("lockVersion returns the locked version with lockedAt", async () => {
  const { repository, service } = createService({
    version: makeAggregate({ assets: [makeAttachment()] }),
  });

  const result = await service.lockVersion(VERSION_ID);

  assert.equal(result.status, RovelleCanonVersionStatus.LOCKED);
  assert.equal(result.lockedAt, lockedAt.toISOString());
  assert.equal(repository.version?.status, RovelleCanonVersionStatus.LOCKED);
  assert.deepEqual(repository.lockVersionCalls, [VERSION_ID]);
});

test("locked versions reject update, attach, and detach operations", async () => {
  const { repository, service } = createService({ version: lockedVersion() });

  await assert.rejects(
    () =>
      service.updateVersion(VERSION_ID, {
        definition: { appearance: { color: "blue" } },
      }),
    BadRequestException,
  );
  await assert.rejects(
    () => service.attachAsset(VERSION_ID, attachRequest()),
    BadRequestException,
  );
  await assert.rejects(
    () => service.detachAsset(VERSION_ID, ASSET_ID),
    BadRequestException,
  );

  assert.equal(repository.updateVersionCalls.length, 0);
  assert.equal(repository.attachAssetCalls.length, 0);
  assert.equal(repository.detachAssetCalls.length, 0);
});
