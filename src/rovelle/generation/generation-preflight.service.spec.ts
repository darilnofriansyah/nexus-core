import * as assert from "node:assert/strict";
import { test } from "node:test";
import {
  RovelleAssetStatus,
  RovelleCanonEntityType,
  RovelleCanonVersionStatus,
  RovelleEpisodeStatus,
  RovelleShotStatus,
} from "../../generated/prisma/client";
import { PrismaService } from "../../database/prisma.service";
import { CanonPinService } from "../canon/canon-pin.service";
import type { CanonPinDto } from "../canon/dto/canon.dto";
import { GenerationPromptCompiler } from "./generation-prompt.compiler";
import { GenerationPreflightService } from "./generation-preflight.service";

const SHOT_ID = "123e4567-e89b-42d3-a456-426614174000";
const EPISODE_ID = "223e4567-e89b-42d3-a456-426614174000";
const CREATED_AT = "2026-08-28T00:00:00.000Z";

function pin(
  code: string,
  entityType: RovelleCanonEntityType,
  options: {
    status?: RovelleCanonVersionStatus;
    assets?: Array<{ id: string; status?: RovelleAssetStatus; mediaType?: string }>;
  } = {},
): CanonPinDto {
  const assets = options.assets ?? [{ id: `${code}-asset` }];
  return {
    source: "EPISODE",
    version: {
      id: `${code}-version`,
      entityId: `${code}-entity`,
      version: 1,
      status: options.status ?? RovelleCanonVersionStatus.LOCKED,
      definition: { code },
      lockedAt: CREATED_AT,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
      entity: {
        id: `${code}-entity`,
        code,
        displayName: code,
        entityType,
        description: null,
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
      },
      assets: assets.map((asset, index) => ({
        role: `reference-${index + 1}`,
        sortOrder: index,
        asset: {
          id: asset.id,
          episodeId: null,
          assetType: "CHARACTER_REFERENCE",
          status: asset.status ?? RovelleAssetStatus.AVAILABLE,
          mediaType: asset.mediaType ?? "image/png",
          originalFilename: null,
          byteSize: "1",
          etag: null,
          createdAt: CREATED_AT,
          updatedAt: CREATED_AT,
        },
      })),
    },
  };
}

function validCanon(): CanonPinDto[] {
  return [
    pin("KOKO", RovelleCanonEntityType.CHARACTER),
    pin("MEADOW_VILLAGE", RovelleCanonEntityType.ENVIRONMENT),
    pin("CLOVERVALE_STORYBOOK_STYLE", RovelleCanonEntityType.STYLE),
  ];
}

class FakePrismaService {
  calls = 0;

  constructor(
    readonly shot: {
      id: string;
      episodeId: string;
      direction: string;
      targetDurationSeconds: number | null;
      status: RovelleShotStatus;
      episode: { id: string; status: RovelleEpisodeStatus };
    } | null,
  ) {}

  readonly client = {
    rovelleShot: {
      findUnique: async () => {
        this.calls += 1;
        return this.shot;
      },
    },
  };
}

class FakeCanonPinService {
  calls: string[] = [];

  constructor(readonly pins: CanonPinDto[]) {}

  async getEffectiveShotCanon(shotId: string): Promise<CanonPinDto[]> {
    this.calls.push(shotId);
    return this.pins;
  }
}

function createPreflight(
  options: {
    episodeStatus?: RovelleEpisodeStatus;
    shotStatus?: RovelleShotStatus;
    duration?: number | null;
    pins?: CanonPinDto[];
  } = {},
) {
  const prisma = new FakePrismaService({
    id: SHOT_ID,
    episodeId: EPISODE_ID,
    direction: "Koko finds a clover.",
    targetDurationSeconds: options.duration ?? 8,
    status: options.shotStatus ?? RovelleShotStatus.READY_TO_GENERATE,
    episode: {
      id: EPISODE_ID,
      status: options.episodeStatus ?? RovelleEpisodeStatus.READY_TO_GENERATE,
    },
  });
  const canon = new FakeCanonPinService(options.pins ?? validCanon());
  const service = new GenerationPreflightService(
    prisma as unknown as PrismaService,
    canon as unknown as CanonPinService,
    new GenerationPromptCompiler(),
  );

  return { service, prisma, canon };
}

test("preflight returns only prepared metadata and a prompt without mutating state", async () => {
  const { service, prisma, canon } = createPreflight();

  const prepared = await service.preflight(SHOT_ID);

  assert.deepEqual(Object.keys(prepared).sort(), [
    "direction",
    "duration",
    "episodeId",
    "prompt",
    "references",
    "shotId",
  ]);
  assert.deepEqual(
    prepared.references.map((reference) => reference.assetId),
    ["CLOVERVALE_STORYBOOK_STYLE-asset", "KOKO-asset", "MEADOW_VILLAGE-asset"],
  );
  assert.equal(prepared.prompt.includes("https://"), false);
  assert.equal(prisma.calls, 1);
  assert.deepEqual(canon.calls, [SHOT_ID]);
});

test("preflight rejects an episode outside generation states", async () => {
  await assert.rejects(
    () => createPreflight({ episodeStatus: RovelleEpisodeStatus.DRAFT }).service.preflight(SHOT_ID),
    /episode must be READY_TO_GENERATE or GENERATING/,
  );
});

test("preflight rejects a shot outside READY_TO_GENERATE", async () => {
  await assert.rejects(
    () => createPreflight({ shotStatus: RovelleShotStatus.DRAFT }).service.preflight(SHOT_ID),
    /shot must be READY_TO_GENERATE/,
  );
});

test("preflight rejects durations below four seconds", async () => {
  await assert.rejects(
    () => createPreflight({ duration: 3 }).service.preflight(SHOT_ID),
    /duration must be an integer from 4 to 30/,
  );
});

test("preflight rejects durations above thirty seconds", async () => {
  await assert.rejects(
    () => createPreflight({ duration: 31 }).service.preflight(SHOT_ID),
    /duration must be an integer from 4 to 30/,
  );
});

test("preflight rejects non-integer durations", async () => {
  await assert.rejects(
    () => createPreflight({ duration: 4.5 }).service.preflight(SHOT_ID),
    /duration must be an integer from 4 to 30/,
  );
});

test("preflight requires character, environment, and style canon", async () => {
  await assert.rejects(
    () => createPreflight({ pins: validCanon().slice(0, 2) }).service.preflight(SHOT_ID),
    /CHARACTER, ENVIRONMENT, and STYLE/,
  );
});

test("preflight rejects unlocked canon versions", async () => {
  const pins = validCanon();
  pins[0] = pin("KOKO", RovelleCanonEntityType.CHARACTER, {
    status: RovelleCanonVersionStatus.DRAFT,
  });

  await assert.rejects(
    () => createPreflight({ pins }).service.preflight(SHOT_ID),
    /canon versions must be LOCKED/,
  );
});

test("preflight requires an attached asset for every effective canon version", async () => {
  const pins = validCanon();
  pins[0] = pin("KOKO", RovelleCanonEntityType.CHARACTER, { assets: [] });

  await assert.rejects(
    () => createPreflight({ pins }).service.preflight(SHOT_ID),
    /canon versions require at least one attached asset/,
  );
});

test("preflight rejects unavailable selected assets", async () => {
  const pins = validCanon();
  pins[0] = pin("KOKO", RovelleCanonEntityType.CHARACTER, {
    assets: [{ id: "koko-asset", status: RovelleAssetStatus.RESERVED }],
  });

  await assert.rejects(
    () => createPreflight({ pins }).service.preflight(SHOT_ID),
    /selected assets must be AVAILABLE/,
  );
});

test("preflight rejects selected non-image assets", async () => {
  const pins = validCanon();
  pins[0] = pin("KOKO", RovelleCanonEntityType.CHARACTER, {
    assets: [{ id: "koko-asset", mediaType: "video/mp4" }],
  });

  await assert.rejects(
    () => createPreflight({ pins }).service.preflight(SHOT_ID),
    /selected assets must use image\/\* media types/,
  );
});

test("preflight rejects more than thirty references", async () => {
  const pins = validCanon();
  pins[0] = pin("KOKO", RovelleCanonEntityType.CHARACTER, {
    assets: Array.from({ length: 31 }, (_, index) => ({ id: `koko-${index}` })),
  });

  await assert.rejects(
    () => createPreflight({ pins }).service.preflight(SHOT_ID),
    /at most 30 references/,
  );
});
