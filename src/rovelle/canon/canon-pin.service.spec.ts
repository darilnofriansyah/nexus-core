import * as assert from "node:assert/strict";
import { test } from "node:test";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import {
  RovelleCanonEntityType,
  RovelleCanonVersionStatus,
  RovelleEpisodeStatus,
  RovelleShotStatus,
  type RovelleCanonEntity,
  type RovelleCanonVersion,
  type RovelleEpisode,
  type RovelleShot,
} from "../../generated/prisma/client";
import type { PinCanonVersionRequestDto } from "./dto/canon.dto";
import {
  CanonPinRepository,
  type CanonPinWithVersion,
  type EffectiveShotPins,
  type PinMutationResult,
} from "./canon-pin.repository";
import { CanonPinService } from "./canon-pin.service";

const EPISODE_ID = "550e8400-e29b-41d4-a716-446655440000";
const SHOT_ID = "123e4567-e89b-42d3-a456-426614174000";
const ENTITY_ID = "223e4567-e89b-42d3-a456-426614174000";
const VERSION_ID = "323e4567-e89b-42d3-a456-426614174000";
const OTHER_ENTITY_ID = "423e4567-e89b-42d3-a456-426614174000";
const OTHER_VERSION_ID = "523e4567-e89b-42d3-a456-426614174000";

const createdAt = new Date("2026-08-27T00:00:00.000Z");
const updatedAt = new Date("2026-08-27T00:01:00.000Z");

function makeVersion(
  id: string,
  entityId: string,
  code: string,
  version = 1,
): CanonPinWithVersion["canonVersion"] {
  const entity: RovelleCanonEntity = {
    id: entityId,
    code,
    displayName: code,
    entityType: RovelleCanonEntityType.CHARACTER,
    description: null,
    createdAt,
    updatedAt,
  };

  const canonVersion: RovelleCanonVersion = {
    id,
    entityId,
    version,
    status: RovelleCanonVersionStatus.LOCKED,
    definition: { appearance: { color: "yellow" } },
    lockedAt: createdAt,
    createdAt,
    updatedAt,
  };

  return { ...canonVersion, entity, assets: [] };
}

function makePin(
  canonVersion: CanonPinWithVersion["canonVersion"],
  source: "episode" | "shot" = "episode",
): CanonPinWithVersion {
  return {
    ...(source === "episode"
      ? { episodeId: EPISODE_ID }
      : { shotId: SHOT_ID }),
    canonEntityId: canonVersion.entityId,
    canonVersionId: canonVersion.id,
    createdAt,
    updatedAt,
    canonVersion,
  } as CanonPinWithVersion;
}

const episode: RovelleEpisode = {
  id: EPISODE_ID,
  code: "EP-001",
  title: "Berry Count",
  status: RovelleEpisodeStatus.PREPRODUCTION,
  brief: null,
  targetDurationSeconds: 60,
  createdAt,
  updatedAt,
};

const shot: RovelleShot & { episode: Pick<RovelleEpisode, "status"> } = {
  id: SHOT_ID,
  episodeId: EPISODE_ID,
  sequence: 1,
  name: "Opening",
  direction: "Open on the basket.",
  targetDurationSeconds: 10,
  status: RovelleShotStatus.DRAFT,
  episode: { status: episode.status },
  createdAt,
  updatedAt,
};

const episodeVersion = makeVersion(VERSION_ID, ENTITY_ID, "KOKO");
const otherVersion = makeVersion(OTHER_VERSION_ID, OTHER_ENTITY_ID, "ALPHA");
const episodePin = makePin(episodeVersion);
const shotPin = makePin(episodeVersion, "shot");

function makeEffectiveShot(
  episodePins: CanonPinWithVersion[] = [episodePin],
  shotPins: CanonPinWithVersion[] = [shotPin],
): EffectiveShotPins {
  return { ...shot, episode: { ...episode, canonPins: episodePins }, canonPins: shotPins };
}

class FakeCanonPinRepository {
  pinEpisodeResult: PinMutationResult = { status: "pinned", pin: episodePin };
  pinShotResult: PinMutationResult = { status: "pinned", pin: shotPin };
  unpinEpisodeResult: PinMutationResult = { status: "unpinned" };
  unpinShotResult: PinMutationResult = { status: "unpinned" };
  episodePins: CanonPinWithVersion[] = [episodePin];
  effectiveShot: EffectiveShotPins | null = makeEffectiveShot();

  async pinEpisodeVersion(
    _episodeId: string,
    _canonEntityId: string,
    _canonVersionId: string,
  ): Promise<PinMutationResult> {
    return this.pinEpisodeResult;
  }

  async unpinEpisodeEntity(
    _episodeId: string,
    _canonEntityId: string,
  ): Promise<PinMutationResult> {
    return this.unpinEpisodeResult;
  }

  async listEpisodePins(_episodeId: string): Promise<CanonPinWithVersion[]> {
    return this.episodePins;
  }

  async pinShotVersion(
    _shotId: string,
    _canonEntityId: string,
    _canonVersionId: string,
  ): Promise<PinMutationResult> {
    return this.pinShotResult;
  }

  async unpinShotEntity(
    _shotId: string,
    _canonEntityId: string,
  ): Promise<PinMutationResult> {
    return this.unpinShotResult;
  }

  async getEffectiveShotPins(
    _shotId: string,
  ): Promise<EffectiveShotPins | null> {
    return this.effectiveShot;
  }
}

function createService() {
  const repository = new FakeCanonPinRepository();
  return {
    repository,
    service: new CanonPinService(
      repository as unknown as CanonPinRepository,
    ),
  };
}

function pinRequest(
  canonVersionId = VERSION_ID,
): PinCanonVersionRequestDto {
  return { canonVersionId };
}

test("rejects an invalid canon version pin request before repository access", async () => {
  const { repository, service } = createService();

  await assert.rejects(
    () =>
      service.pinEpisode(
        EPISODE_ID,
        ENTITY_ID,
        { canonVersionId: "not-a-uuid" } as PinCanonVersionRequestDto,
      ),
    BadRequestException,
  );
  assert.equal(repository.pinEpisodeResult.status, "pinned");
});

test("maps pin mutation outcomes to the required exceptions", async () => {
  const cases: Array<{
    status: PinMutationResult["status"];
    error: typeof NotFoundException | typeof BadRequestException;
    message?: string;
  }> = [
    { status: "not_found", error: NotFoundException },
    {
      status: "episode_locked",
      error: BadRequestException,
      message: "Canon pins cannot be changed after generation begins",
    },
    {
      status: "version_not_locked",
      error: BadRequestException,
      message: "Canon pins require a locked canon version",
    },
    {
      status: "entity_mismatch",
      error: BadRequestException,
      message: "Canon version does not belong to the requested entity",
    },
  ];

  for (const testCase of cases) {
    const { repository, service } = createService();
    repository.pinEpisodeResult =
      testCase.status === "not_found"
        ? { status: "not_found" }
        : testCase.status === "episode_locked"
          ? { status: "episode_locked" }
          : testCase.status === "version_not_locked"
            ? { status: "version_not_locked" }
            : { status: "entity_mismatch" };

    await assert.rejects(
      () => service.pinEpisode(EPISODE_ID, ENTITY_ID, pinRequest()),
      (error: unknown) => {
        assert.ok(error instanceof testCase.error);
        if (testCase.message) assert.equal((error as Error).message, testCase.message);
        return true;
      },
    );
  }
});

test("maps a successful episode pin to source EPISODE", async () => {
  const { service } = createService();

  assert.deepEqual(
    await service.pinEpisode(EPISODE_ID, ENTITY_ID, pinRequest()),
    { source: "EPISODE", version: serviceVersion(episodeVersion) },
  );
});

test("lists episode pins with source EPISODE", async () => {
  const { service } = createService();

  assert.deepEqual(await service.listEpisodePins(EPISODE_ID), [
    { source: "EPISODE", version: serviceVersion(episodeVersion) },
  ]);
});

test("maps a successful shot pin to source SHOT", async () => {
  const { service } = createService();

  assert.deepEqual(await service.pinShot(SHOT_ID, ENTITY_ID, pinRequest()), {
    source: "SHOT",
    version: serviceVersion(episodeVersion),
  });
});

test("maps missing owners from unpin mutations to NotFoundException", async () => {
  const { repository, service } = createService();
  repository.unpinEpisodeResult = { status: "not_found" };
  await assert.rejects(
    () => service.unpinEpisode(EPISODE_ID, ENTITY_ID),
    NotFoundException,
  );
});

test("resolves episode-only entities and labels them EPISODE", async () => {
  const { repository, service } = createService();
  repository.effectiveShot = makeEffectiveShot([episodePin], []);

  assert.deepEqual(await service.getEffectiveShotCanon(SHOT_ID), [
    { source: "EPISODE", version: serviceVersion(episodeVersion) },
  ]);
});

test("shot pins replace episode pins for the same entity", async () => {
  const { repository, service } = createService();
  const shotVersion = makeVersion(OTHER_VERSION_ID, ENTITY_ID, "KOKO", 2);
  repository.effectiveShot = makeEffectiveShot(
    [episodePin],
    [makePin(shotVersion, "shot")],
  );

  assert.deepEqual(await service.getEffectiveShotCanon(SHOT_ID), [
    { source: "SHOT", version: serviceVersion(shotVersion) },
  ]);
});

test("sorts effective canon by entity code and emits no duplicate entities", async () => {
  const { repository, service } = createService();
  const alphaPin = makePin(otherVersion);
  repository.effectiveShot = makeEffectiveShot(
    [episodePin, alphaPin],
    [makePin(makeVersion(OTHER_VERSION_ID, ENTITY_ID, "KOKO", 2), "shot")],
  );

  const result: Array<{
    source: string;
    version: { entity: { id: string; code: string } };
  }> = await service.getEffectiveShotCanon(SHOT_ID);
  assert.deepEqual(result.map((pin) => [pin.source, pin.version.entity.code]), [
    ["EPISODE", "ALPHA"],
    ["SHOT", "KOKO"],
  ]);
  assert.equal(new Set(result.map((pin) => pin.version.entity.id)).size, result.length);
});

test("maps a missing shot from effective resolution to NotFoundException", async () => {
  const { repository, service } = createService();
  repository.effectiveShot = null;

  await assert.rejects(() => service.getEffectiveShotCanon(SHOT_ID), NotFoundException);
});

function serviceVersion(version: CanonPinWithVersion["canonVersion"]) {
  return {
    id: version.id,
    entityId: version.entityId,
    version: version.version,
    status: version.status,
    definition: version.definition,
    lockedAt: version.lockedAt?.toISOString() ?? null,
    createdAt: version.createdAt.toISOString(),
    updatedAt: version.updatedAt.toISOString(),
    entity: {
      id: version.entity.id,
      code: version.entity.code,
      displayName: version.entity.displayName,
      entityType: version.entity.entityType,
      description: version.entity.description,
      createdAt: version.entity.createdAt.toISOString(),
      updatedAt: version.entity.updatedAt.toISOString(),
    },
    assets: [],
  };
}
