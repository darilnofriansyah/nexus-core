import * as assert from "node:assert/strict";
import { after, afterEach, before, describe, test } from "node:test";
import { BadRequestException } from "@nestjs/common";
import { PrismaService } from "../../database/prisma.service";
import {
  RovelleEpisodeStatus,
  RovelleShotStatus,
} from "../../generated/prisma/client";
import { EpisodeRepository } from "./episode.repository";
import { EpisodeService } from "./episode.service";
import { assertEpisodeTransition } from "./episode-status";

const testDatabaseUrl = process.env.ROVELLE_TEST_DATABASE_URL;
const originalDatabaseUrl = process.env.DATABASE_URL;

describe(
  "Rovelle production episode aggregate",
  { skip: !testDatabaseUrl },
  () => {
    let prisma!: PrismaService;
    let service!: EpisodeService;

    before(async () => {
      process.env.DATABASE_URL = testDatabaseUrl;
      prisma = new PrismaService();
      service = new EpisodeService(new EpisodeRepository(prisma));
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
      if (!prisma) {
        return;
      }

      await prisma.client.rovelleShot.deleteMany();
      await prisma.client.rovelleEpisode.deleteMany();
    }

    async function createApprovedEpisode(code: string) {
      const episode = await service.createEpisode({
        code,
        title: "Berry Count",
        targetDurationSeconds: 60,
      });

      await service.updateBrief(episode.id, {
        brief: { premise: "Count berries in a single basket." },
      });
      await service.approveBrief(episode.id);

      return episode;
    }

    async function createPreproductionEpisode(code: string) {
      const episode = await createApprovedEpisode(code);

      return service.startPreproduction(episode.id);
    }

    test("persists the full episode lifecycle and reads an ordered ready aggregate", async () => {
      const created = await service.createEpisode({
        code: "EP-001",
        title: "Berry Count",
        targetDurationSeconds: 60,
      });

      assert.equal(created.status, RovelleEpisodeStatus.DRAFT);

      const briefUpdated = await service.updateBrief(created.id, {
        brief: { premise: "Count berries in a single basket." },
      });
      assert.deepEqual(briefUpdated.brief, {
        premise: "Count berries in a single basket.",
      });

      const approved = await service.approveBrief(created.id);
      assert.equal(approved.status, RovelleEpisodeStatus.BRIEF_APPROVED);

      const preproduction = await service.startPreproduction(created.id);
      assert.equal(preproduction.status, RovelleEpisodeStatus.PREPRODUCTION);

      const replaced = await service.replaceShots(created.id, {
        shots: [
          {
            sequence: 2,
            name: "Close",
            direction: "Close on the basket.",
            targetDurationSeconds: 20,
          },
          {
            sequence: 1,
            name: "Opening",
            direction: "Open on the basket.",
            targetDurationSeconds: 15,
          },
        ],
      });
      assert.deepEqual(
        replaced.shots.map((shot) => shot.sequence),
        [1, 2],
      );

      const ready = await service.markReadyToGenerate(created.id);

      assert.equal(ready.status, RovelleEpisodeStatus.READY_TO_GENERATE);
      assert.equal(ready.shots.length, 2);
      assert.deepEqual(
        ready.shots.map((shot) => shot.sequence),
        [1, 2],
      );
      assert.deepEqual(
        ready.shots.map((shot) => shot.status),
        [
          RovelleShotStatus.READY_TO_GENERATE,
          RovelleShotStatus.READY_TO_GENERATE,
        ],
      );

      const aggregate = await service.getEpisode(created.id);
      assert.equal(aggregate.status, RovelleEpisodeStatus.READY_TO_GENERATE);
      assert.equal(aggregate.shots.length, 2);
      assert.deepEqual(
        aggregate.shots.map((shot) => shot.sequence),
        [1, 2],
      );
      assert.ok(
        aggregate.shots.every(
          (shot) => shot.status === RovelleShotStatus.READY_TO_GENERATE,
        ),
      );
    });

    test("rejects duplicate episode codes", async () => {
      await service.createEpisode({ code: "EP-001", title: "Berry Count" });

      await assert.rejects(
        () => service.createEpisode({ code: "EP-001", title: "Another Count" }),
        /Unique constraint failed/,
      );
    });

    test("rejects duplicate shot sequences", async () => {
      const episode = await createPreproductionEpisode("EP-002");

      await assert.rejects(
        () =>
          service.replaceShots(episode.id, {
            shots: [
              { sequence: 1, direction: "Opening" },
              { sequence: 1, direction: "Closing" },
            ],
          }),
        /sequence must be unique/,
      );
    });

    test("rejects marking a preproduction episode ready with zero shots", async () => {
      const episode = await createPreproductionEpisode("EP-003");

      await assert.rejects(
        () => service.markReadyToGenerate(episode.id),
        /At least one shot is required/,
      );
    });

    test("rejects replacing shots while an episode is draft", async () => {
      const episode = await service.createEpisode({
        code: "EP-004",
        title: "Berry Count",
      });

      await assert.rejects(
        () =>
          service.replaceShots(episode.id, {
            shots: [{ sequence: 1, direction: "Opening" }],
          }),
        /PREPRODUCTION/,
      );
    });

    test("rejects brief edits after approval", async () => {
      const episode = await createApprovedEpisode("EP-005");

      await assert.rejects(
        () =>
          service.updateBrief(episode.id, {
            brief: { premise: "Changed after approval." },
          }),
        /DRAFT/,
      );
    });

    test("rejects the READY_TO_GENERATE to GENERATING transition", () => {
      assert.throws(
        () =>
          assertEpisodeTransition(
            RovelleEpisodeStatus.READY_TO_GENERATE,
            RovelleEpisodeStatus.GENERATING,
          ),
        BadRequestException,
      );
    });
  },
);
