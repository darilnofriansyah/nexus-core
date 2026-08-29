import * as assert from "node:assert/strict";
import { after, afterEach, before, describe, test } from "node:test";
import { BadRequestException } from "@nestjs/common";
import { PrismaService } from "../../database/prisma.service";
import {
  RovelleAssetStatus,
  RovelleAssetType,
  RovelleCanonEntityType,
} from "../../generated/prisma/client";
import { AssetRepository } from "../assets/asset.repository";
import { AssetService } from "../assets/asset.service";
import type {
  R2ObjectMetadata,
  R2PresignedRequest,
  R2StorageService,
} from "../assets/r2-storage.service";
import { EpisodeRepository } from "../production/episode.repository";
import { EpisodeService } from "../production/episode.service";
import { CanonPinRepository } from "./canon-pin.repository";
import { CanonPinService } from "./canon-pin.service";
import { CanonRepository } from "./canon.repository";
import { CanonService } from "./canon.service";

const testDatabaseUrl = process.env.ROVELLE_TEST_DATABASE_URL;
const originalDatabaseUrl = process.env.DATABASE_URL;

class FakeR2Storage {
  assertConfigured(): void {}

  async createPutUrl(
    key: string,
    mediaType: string,
  ): Promise<R2PresignedRequest> {
    return {
      method: "PUT",
      url: `https://fake-r2.test/${key}`,
      headers: { "content-type": mediaType },
      expiresAt: "2099-01-01T00:00:00.000Z",
    };
  }

  async headObject(_key: string): Promise<R2ObjectMetadata> {
    return {
      byteSize: 12n,
      etag: "etag-canon-integration",
      contentType: "image/png",
    };
  }
}

describe(
  "Rovelle canon registry integration",
  { skip: !testDatabaseUrl },
  () => {
    let prisma!: PrismaService;
    let episodeService!: EpisodeService;
    let assetService!: AssetService;
    let canonService!: CanonService;
    let canonPinService!: CanonPinService;

    before(async () => {
      process.env.DATABASE_URL = testDatabaseUrl;
      prisma = new PrismaService();
      episodeService = new EpisodeService(new EpisodeRepository(prisma));
      assetService = new AssetService(
        new AssetRepository(prisma),
        new FakeR2Storage() as unknown as R2StorageService,
      );
      canonService = new CanonService(
        new CanonRepository(prisma),
        assetService,
      );
      canonPinService = new CanonPinService(new CanonPinRepository(prisma));
      await cleanRovelleTables();
    });

    afterEach(cleanRovelleTables);

    after(async () => {
      await prisma?.onModuleDestroy();

      if (originalDatabaseUrl === undefined) {
        delete process.env.DATABASE_URL;
      } else {
        process.env.DATABASE_URL = originalDatabaseUrl;
      }
    });

    async function cleanRovelleTables(): Promise<void> {
      if (!prisma) return;

      await prisma.client.rovelleShotCanonPin.deleteMany();
      await prisma.client.rovelleEpisodeCanonPin.deleteMany();
      await prisma.client.rovelleCanonAsset.deleteMany();
      await prisma.client.rovelleCanonVersion.deleteMany();
      await prisma.client.rovelleCanonEntity.deleteMany();
      await prisma.client.rovelleAsset.deleteMany();
      await prisma.client.rovelleShot.deleteMany();
      await prisma.client.rovelleEpisode.deleteMany();
    }

    async function createAvailableAsset(
      episodeId: string,
      assetType: RovelleAssetType,
      originalFilename: string,
    ) {
      const reserved = await assetService.reserve({
        assetType,
        mediaType: "image/png",
        originalFilename,
        episodeId,
      });

      return assetService.confirmUpload(reserved.asset.id);
    }

    function canonKeys(
      pins: Array<{
        source: string;
        version: { version: number; entity: { code: string } };
      }>,
    ): string[] {
      return pins
        .map(
          (pin) =>
            `${pin.version.entity.code}:v${pin.version.version}:${pin.source}`,
        )
        .sort();
    }

    test("keeps locked canon immutable and resolves episode and shot pins", async () => {
      const episode = await episodeService.createEpisode({
        code: "CANON-001",
        title: "Koko visits Meadow Village",
        targetDurationSeconds: 60,
      });
      await episodeService.updateBrief(episode.id, {
        brief: { premise: "Koko visits Meadow Village." },
      });
      await episodeService.approveBrief(episode.id);
      await episodeService.startPreproduction(episode.id);
      const withShots = await episodeService.replaceShots(episode.id, {
        shots: [
          { sequence: 1, direction: "Koko enters the village." },
          { sequence: 2, direction: "Koko waves at the village." },
        ],
      });
      const shot1 = withShots.shots.find((shot) => shot.sequence === 1)!;
      const shot2 = withShots.shots.find((shot) => shot.sequence === 2)!;

      const kokoTurnaround = await createAvailableAsset(
        episode.id,
        RovelleAssetType.CHARACTER_REFERENCE,
        "koko-turnaround.png",
      );
      const kokoTransparent = await createAvailableAsset(
        episode.id,
        RovelleAssetType.CHARACTER_REFERENCE,
        "koko-transparent.png",
      );
      const meadowReference = await createAvailableAsset(
        episode.id,
        RovelleAssetType.ENVIRONMENT_REFERENCE,
        "meadow-village.png",
      );
      assert.equal(kokoTurnaround.status, RovelleAssetStatus.AVAILABLE);
      assert.equal(kokoTransparent.status, RovelleAssetStatus.AVAILABLE);
      assert.equal(meadowReference.status, RovelleAssetStatus.AVAILABLE);

      const koko = await canonService.createEntity({
        code: "KOKO",
        displayName: "Koko",
        entityType: RovelleCanonEntityType.CHARACTER,
      });
      const kokoV1 = await canonService.createVersion(koko.id, {
        definition: { appearance: "yellow monkey", outfit: "blue scarf" },
      });
      await canonService.attachAsset(kokoV1.id, {
        assetId: kokoTurnaround.id,
        role: "TURNAROUND",
      });
      await canonService.attachAsset(kokoV1.id, {
        assetId: kokoTransparent.id,
        role: "TRANSPARENT",
      });
      const lockedKokoV1 = await canonService.lockVersion(kokoV1.id);
      assert.equal(lockedKokoV1.status, "LOCKED");
      assert.equal(lockedKokoV1.assets.length, 2);

      await assert.rejects(
        () =>
          canonService.updateVersion(kokoV1.id, {
            definition: { appearance: "changed" },
          }),
        BadRequestException,
      );
      await assert.rejects(
        () =>
          canonService.attachAsset(kokoV1.id, {
            assetId: kokoTurnaround.id,
            role: "EXTRA",
          }),
        BadRequestException,
      );
      await assert.rejects(
        () => canonService.detachAsset(kokoV1.id, kokoTurnaround.id),
        BadRequestException,
      );

      const meadow = await canonService.createEntity({
        code: "MEADOW_VILLAGE",
        displayName: "Meadow Village",
        entityType: RovelleCanonEntityType.ENVIRONMENT,
      });
      const meadowV1 = await canonService.createVersion(meadow.id, {
        definition: { palette: "spring green", landmark: "old oak" },
      });
      await canonService.attachAsset(meadowV1.id, {
        assetId: meadowReference.id,
        role: "ESTABLISHING",
      });
      const lockedMeadowV1 = await canonService.lockVersion(meadowV1.id);
      assert.equal(lockedMeadowV1.status, "LOCKED");

      await canonPinService.pinEpisode(episode.id, koko.id, {
        canonVersionId: kokoV1.id,
      });
      await canonPinService.pinEpisode(episode.id, meadow.id, {
        canonVersionId: meadowV1.id,
      });
      assert.deepEqual(
        canonKeys(await canonPinService.listEpisodePins(episode.id)),
        ["KOKO:v1:EPISODE", "MEADOW_VILLAGE:v1:EPISODE"],
      );

      const kokoV2 = await canonService.createVersion(koko.id, {
        definition: { appearance: "yellow monkey", outfit: "red scarf" },
      });
      await assert.rejects(
        () =>
          canonPinService.pinEpisode(episode.id, koko.id, {
            canonVersionId: kokoV2.id,
          }),
        BadRequestException,
      );
      assert.deepEqual(
        canonKeys(await canonPinService.listEpisodePins(episode.id)),
        ["KOKO:v1:EPISODE", "MEADOW_VILLAGE:v1:EPISODE"],
      );

      await canonService.attachAsset(kokoV2.id, {
        assetId: kokoTransparent.id,
        role: "TRANSPARENT",
      });
      const lockedKokoV2 = await canonService.lockVersion(kokoV2.id);
      assert.equal(lockedKokoV2.status, "LOCKED");
      await canonPinService.pinShot(shot2.id, koko.id, {
        canonVersionId: kokoV2.id,
      });

      const fkEpisode = await episodeService.createEpisode({
        code: "CANON-FK",
        title: "Composite foreign key check",
      });
      await assert.rejects(
        () =>
          prisma.client.rovelleEpisodeCanonPin.create({
            data: {
              episodeId: fkEpisode.id,
              canonEntityId: koko.id,
              canonVersionId: meadowV1.id,
            },
          }),
        (error: unknown) =>
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "P2003",
      );

      assert.deepEqual(
        canonKeys(await canonPinService.getEffectiveShotCanon(shot1.id)),
        ["KOKO:v1:EPISODE", "MEADOW_VILLAGE:v1:EPISODE"],
      );
      assert.deepEqual(
        canonKeys(await canonPinService.getEffectiveShotCanon(shot2.id)),
        ["KOKO:v2:SHOT", "MEADOW_VILLAGE:v1:EPISODE"],
      );
    });
  },
);
