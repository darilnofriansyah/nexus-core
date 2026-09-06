import * as assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  after,
  afterEach,
  before,
  beforeEach,
  describe,
  test,
} from "node:test";
import {
  BadGatewayException,
  BadRequestException,
  InternalServerErrorException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { PrismaService } from "../../database/prisma.service";
import {
  RovelleAssetStatus,
  RovelleAssetType,
  RovelleCanonEntityType,
  RovelleEpisodeStatus,
  RovelleGenerationProfile,
  RovelleGenerationStatus,
  RovelleShotStatus,
} from "../../generated/prisma/client";
import { AssetRepository } from "../assets/asset.repository";
import { AssetService } from "../assets/asset.service";
import type {
  R2ObjectMetadata,
  R2PresignedRequest,
  R2StorageService,
} from "../assets/r2-storage.service";
import { CanonPinRepository } from "../canon/canon-pin.repository";
import { CanonPinService } from "../canon/canon-pin.service";
import { CanonRepository } from "../canon/canon.repository";
import { CanonService } from "../canon/canon.service";
import { EpisodeRepository } from "../production/episode.repository";
import { EpisodeService } from "../production/episode.service";
import { GenerationPreflightService } from "./generation-preflight.service";
import { GenerationPromptCompiler } from "./generation-prompt.compiler";
import { GenerationRepository } from "./generation.repository";
import { GenerationService } from "./generation.service";
import type { GenerationProviderSubmission } from "./providers/generation-provider";
import { RunwareSubmissionError } from "./providers/runware/runware-submit.client";
import type { RunwareWebhookEvent } from "./webhooks/runware-webhook.dto";
import { RunwareWebhookService } from "./webhooks/runware-webhook.service";

const testDatabaseUrl = process.env.ROVELLE_TEST_DATABASE_URL;
const originalDatabaseUrl = process.env.DATABASE_URL;

class FakeR2Storage {
  private readonly mediaTypes = new Map<string, string>();
  readonly headCalls: string[] = [];
  readonly headObjectResults = new Map<string, R2ObjectMetadata | null>();
  readUrlError: Error | undefined;
  providerPutUrlError: Error | undefined;

  assertConfigured(): void {}

  async createPutUrl(
    key: string,
    mediaType: string,
  ): Promise<R2PresignedRequest> {
    this.mediaTypes.set(key, mediaType);
    return {
      method: "PUT",
      url: "https://signed.invalid/upload",
      headers: { "content-type": mediaType },
      expiresAt: "2099-01-01T00:00:00.000Z",
    };
  }

  async createGetUrl(key: string): Promise<R2PresignedRequest> {
    if (this.readUrlError) throw this.readUrlError;
    const assetId = key.slice(key.lastIndexOf("/") + 1);
    return {
      method: "GET",
      url: `https://signed.invalid/ref-${assetId}`,
      headers: {},
      expiresAt: "2099-01-01T00:00:00.000Z",
    };
  }

  async createProviderPutUrl(_key: string): Promise<R2PresignedRequest> {
    if (this.providerPutUrlError) throw this.providerPutUrlError;
    return {
      method: "PUT",
      url: "https://signed.invalid/output",
      headers: {},
      expiresAt: "2099-01-01T00:00:00.000Z",
    };
  }

  async headObject(key: string): Promise<R2ObjectMetadata | null> {
    this.headCalls.push(key);
    if (this.headObjectResults.has(key)) {
      return this.headObjectResults.get(key) ?? null;
    }
    return {
      byteSize: 1n,
      etag: "fake-etag",
      contentType: this.mediaTypes.get(key) ?? "image/png",
    };
  }
}

class FakeRunwareProvider {
  readonly calls: GenerationProviderSubmission[] = [];
  error: RunwareSubmissionError | undefined;
  acceptedHook:
    | ((request: GenerationProviderSubmission) => Promise<void> | void)
    | undefined;
  private holdUntilCallCount = 0;
  private readonly heldSubmitters: Array<() => void> = [];

  holdSubmissionsUntil(callCount: number): void {
    this.holdUntilCallCount = callCount;
  }

  resetSubmissionGate(): void {
    this.holdUntilCallCount = 0;
    this.heldSubmitters.splice(0).forEach((release) => release());
  }

  async submit(
    request: GenerationProviderSubmission,
  ): Promise<{ providerTaskId: string }> {
    this.calls.push(request);
    if (this.error) throw this.error;
    if (this.holdUntilCallCount > 0) {
      const gate = new Promise<void>((resolve) =>
        this.heldSubmitters.push(resolve),
      );
      if (this.calls.length >= this.holdUntilCallCount) {
        this.resetSubmissionGate();
      }
      await gate;
    }
    if (this.acceptedHook) await this.acceptedHook(request);
    return { providerTaskId: request.taskId };
  }
}

describe(
  "Rovelle generation submission and webhook integration",
  { skip: !testDatabaseUrl },
  () => {
    let prisma!: PrismaService;
    let storage!: FakeR2Storage;
    let episodeService!: EpisodeService;
    let assetService!: AssetService;
    let canonService!: CanonService;
    let canonPinService!: CanonPinService;
    let generationService!: GenerationService;
    let generationRepository!: GenerationRepository;
    let webhookService!: RunwareWebhookService;
    let provider!: FakeRunwareProvider;

    before(async () => {
      process.env.DATABASE_URL = testDatabaseUrl;
      prisma = new PrismaService();
      storage = new FakeR2Storage();
      assetService = new AssetService(
        new AssetRepository(prisma),
        storage as unknown as R2StorageService,
      );
      episodeService = new EpisodeService(new EpisodeRepository(prisma));
      canonService = new CanonService(
        new CanonRepository(prisma),
        assetService,
      );
      canonPinService = new CanonPinService(new CanonPinRepository(prisma));
      provider = new FakeRunwareProvider();
      generationRepository = new GenerationRepository(prisma);
      generationService = new GenerationService(
        new GenerationPreflightService(
          prisma,
          canonPinService,
          new GenerationPromptCompiler(),
          generationRepository,
        ),
        generationRepository,
        assetService,
        storage as unknown as R2StorageService,
        provider,
        "vidu:2@0",
      );
      webhookService = new RunwareWebhookService(
        generationRepository,
        storage as unknown as R2StorageService,
      );
      await cleanRovelleTables();
    });

    beforeEach(() => {
      provider.calls.length = 0;
      provider.error = undefined;
      provider.acceptedHook = undefined;
      provider.resetSubmissionGate();
      storage.readUrlError = undefined;
      storage.providerPutUrlError = undefined;
      storage.headCalls.length = 0;
      storage.headObjectResults.clear();
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

      await prisma.client.rovelleShotGeneration.deleteMany();
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
      mediaType = "image/png",
    ) {
      const reserved = await assetService.reserve({
        assetType,
        mediaType,
        originalFilename: `${assetType.toLowerCase()}.png`,
        episodeId,
      });
      return assetService.confirmUpload(reserved.asset.id);
    }

    async function createFixture(
      options: {
        includeStyle?: boolean;
        duration?: number;
        nonImageEntityType?: RovelleCanonEntityType;
        extraCharacterReferences?: number;
      } = {},
    ) {
      const episode = await episodeService.createEpisode({
        code: `GEN-${randomUUID().replaceAll("-", "").slice(0, 20)}`,
        title: "Generation submission integration",
        targetDurationSeconds: 4,
      });
      await episodeService.updateBrief(episode.id, {
        brief: { premise: "A storybook character crosses the meadow." },
      });
      await episodeService.approveBrief(episode.id);
      await episodeService.startPreproduction(episode.id);
      const withShot = await episodeService.replaceShots(episode.id, {
        shots: [
          {
            sequence: 1,
            direction: "The character crosses the meadow.",
            targetDurationSeconds: options.duration ?? 4,
          },
        ],
      });
      const shot = withShot.shots[0];
      assert.ok(shot);
      await episodeService.markReadyToGenerate(episode.id);

      const canonSpecs = [
        {
          code: "CHARACTER",
          displayName: "Character",
          entityType: RovelleCanonEntityType.CHARACTER,
          assetType: RovelleAssetType.CHARACTER_REFERENCE,
        },
        {
          code: "ENVIRONMENT",
          displayName: "Environment",
          entityType: RovelleCanonEntityType.ENVIRONMENT,
          assetType: RovelleAssetType.ENVIRONMENT_REFERENCE,
        },
        ...(options.includeStyle === false
          ? []
          : [
              {
                code: "STYLE",
                displayName: "Style",
                entityType: RovelleCanonEntityType.STYLE,
                assetType: RovelleAssetType.STYLE_REFERENCE,
              },
            ]),
      ];
      const referenceAssetIds: string[] = [];

      for (const spec of canonSpecs) {
        const mediaType =
          options.nonImageEntityType === spec.entityType
            ? "text/plain"
            : "image/png";
        const entity = await canonService.createEntity({
          code: `${spec.code}_${randomUUID().slice(0, 8)}`,
          displayName: spec.displayName,
          entityType: spec.entityType,
        });
        const version = await canonService.createVersion(entity.id, {
          definition: { visual: `${spec.displayName} definition` },
        });
        const count =
          spec.entityType === RovelleCanonEntityType.CHARACTER
            ? 1 + (options.extraCharacterReferences ?? 0)
            : 1;
        for (let index = 0; index < count; index += 1) {
          const asset = await createAvailableAsset(
            episode.id,
            spec.assetType,
            mediaType,
          );
          referenceAssetIds.push(asset.id);
          await canonService.attachAsset(version.id, {
            assetId: asset.id,
            role: index === 0 ? "PRIMARY" : `EXTRA_${index}`,
            sortOrder: index,
          });
        }
        const locked = await canonService.lockVersion(version.id);
        await canonPinService.pinEpisode(episode.id, entity.id, {
          canonVersionId: locked.id,
        });
      }

      return {
        episodeId: episode.id,
        shotId: shot.id,
        referenceAssetIds,
        provider,
      };
    }

    async function createReadyShot(episodeId: string, sequence: number) {
      return prisma.client.rovelleShot.create({
        data: {
          episodeId,
          sequence,
          direction: "The character reaches the oak.",
          targetDurationSeconds: 4,
          status: RovelleShotStatus.READY_TO_GENERATE,
        },
      });
    }

    async function submitShot(shotId: string) {
      return generationService.submitShot(shotId, {
        requestId: randomUUID(),
        profile: "DRAFT",
      });
    }

    function successEvent(
      taskId: string,
      costUsd = "0.250000",
    ): Extract<RunwareWebhookEvent, { kind: "success" }> {
      return {
        kind: "success",
        taskId,
        providerOutputId: "provider-output-id",
        costUsd,
        videoUrl: null,
      };
    }

    function failureEvent(
      taskId: string,
      costUsd = "0.125000",
    ): Extract<RunwareWebhookEvent, { kind: "failure" }> {
      return {
        kind: "failure",
        taskId,
        code: "PROVIDER_FAILURE",
        message: "Runware could not render the video",
        costUsd,
      };
    }

    function serializeDurable(value: unknown): string {
      return (
        JSON.stringify(value, (_key, current) =>
          typeof current === "bigint" ? current.toString() : current,
        ) ?? ""
      );
    }

    async function snapshotDurableState() {
      return {
        generations: await prisma.client.rovelleShotGeneration.findMany({
          orderBy: { id: "asc" },
        }),
        assets: await prisma.client.rovelleAsset.findMany({
          orderBy: { id: "asc" },
        }),
        shots: await prisma.client.rovelleShot.findMany({
          orderBy: { id: "asc" },
        }),
        episodes: await prisma.client.rovelleEpisode.findMany({
          orderBy: { id: "asc" },
        }),
      };
    }

    test("completes a submitted generation from a success webhook", async () => {
      const fixture = await createFixture();
      const submitted = await submitShot(fixture.shotId);
      const providerVideoUrl = "https://provider.invalid/video.mp4";
      const event = {
        ...successEvent(submitted.providerTaskId),
        videoURL: providerVideoUrl,
      } as Extract<RunwareWebhookEvent, { kind: "success" }> & {
        videoURL: string;
      };
      const reservedOutput = await prisma.client.rovelleAsset.findUniqueOrThrow(
        { where: { id: submitted.outputAssetId } },
      );
      storage.headCalls.length = 0;

      const result = await webhookService.handle(event);
      assert.deepEqual(storage.headCalls, [reservedOutput.storageKey]);

      assert.deepEqual(result, {
        accepted: true,
        disposition: "completed",
        generationId: submitted.id,
      });

      const completed =
        await prisma.client.rovelleShotGeneration.findUniqueOrThrow({
          where: { id: submitted.id },
        });
      assert.equal(completed.status, RovelleGenerationStatus.COMPLETED);
      assert.equal(completed.actualCostUsd?.toFixed(6), "0.250000");

      const output = await prisma.client.rovelleAsset.findUniqueOrThrow({
        where: { id: submitted.outputAssetId },
      });
      assert.equal(output.status, RovelleAssetStatus.AVAILABLE);
      assert.equal(output.byteSize, 1n);
      assert.equal(output.etag, "fake-etag");

      const shot = await prisma.client.rovelleShot.findUniqueOrThrow({
        where: { id: fixture.shotId },
      });
      assert.equal(shot.status, RovelleShotStatus.REVIEW_REQUIRED);
      const episode = await prisma.client.rovelleEpisode.findUniqueOrThrow({
        where: { id: fixture.episodeId },
      });
      assert.equal(episode.status, RovelleEpisodeStatus.REVIEW_REQUIRED);
      const serialized = serializeDurable({
        generation: completed,
        outputAsset: output,
        shot,
        episode,
      });
      assert.equal(serialized.includes(providerVideoUrl), false);
      assert.doesNotMatch(serialized, /videoURL/i);
    });

    test("moves an episode to review only after every shot reaches a terminal state", async () => {
      const fixture = await createFixture();
      const secondShot = await createReadyShot(fixture.episodeId, 2);
      const first = await submitShot(fixture.shotId);
      const second = await submitShot(secondShot.id);
      const firstOutput = await prisma.client.rovelleAsset.findUniqueOrThrow({
        where: { id: first.outputAssetId },
        select: { storageKey: true },
      });
      const secondOutput = await prisma.client.rovelleAsset.findUniqueOrThrow({
        where: { id: second.outputAssetId },
        select: { storageKey: true },
      });
      storage.headCalls.length = 0;

      const firstResult = await webhookService.handle(
        successEvent(first.providerTaskId),
      );
      assert.equal(firstResult.disposition, "completed");
      assert.deepEqual(storage.headCalls, [firstOutput.storageKey]);
      assert.equal(
        (
          await prisma.client.rovelleShot.findUniqueOrThrow({
            where: { id: fixture.shotId },
          })
        ).status,
        RovelleShotStatus.REVIEW_REQUIRED,
      );
      assert.equal(
        (
          await prisma.client.rovelleShot.findUniqueOrThrow({
            where: { id: secondShot.id },
          })
        ).status,
        RovelleShotStatus.GENERATING,
      );
      assert.equal(
        (
          await prisma.client.rovelleEpisode.findUniqueOrThrow({
            where: { id: fixture.episodeId },
          })
        ).status,
        RovelleEpisodeStatus.GENERATING,
      );

      storage.headCalls.length = 0;
      const secondResult = await webhookService.handle(
        successEvent(second.providerTaskId),
      );
      assert.equal(secondResult.disposition, "completed");
      assert.deepEqual(storage.headCalls, [secondOutput.storageKey]);
      assert.deepEqual(
        (
          await prisma.client.rovelleShot.findMany({
            where: { episodeId: fixture.episodeId },
            orderBy: { sequence: "asc" },
            select: { status: true },
          })
        ).map((shot) => shot.status),
        [RovelleShotStatus.REVIEW_REQUIRED, RovelleShotStatus.REVIEW_REQUIRED],
      );
      assert.equal(
        (
          await prisma.client.rovelleEpisode.findUniqueOrThrow({
            where: { id: fixture.episodeId },
          })
        ).status,
        RovelleEpisodeStatus.REVIEW_REQUIRED,
      );
    });

    test("keeps a failed output reserved while aggregating a two-shot episode", async () => {
      const fixture = await createFixture();
      const secondShot = await createReadyShot(fixture.episodeId, 2);
      const first = await submitShot(fixture.shotId);
      const second = await submitShot(secondShot.id);
      const firstOutput = await prisma.client.rovelleAsset.findUniqueOrThrow({
        where: { id: first.outputAssetId },
        select: { storageKey: true },
      });
      storage.headCalls.length = 0;

      await webhookService.handle(successEvent(first.providerTaskId));
      assert.deepEqual(storage.headCalls, [firstOutput.storageKey]);
      storage.headCalls.length = 0;
      const failedResult = await webhookService.handle(
        failureEvent(second.providerTaskId),
      );
      assert.equal(failedResult.disposition, "failed");
      assert.deepEqual(storage.headCalls, []);

      assert.equal(
        (
          await prisma.client.rovelleShot.findUniqueOrThrow({
            where: { id: fixture.shotId },
          })
        ).status,
        RovelleShotStatus.REVIEW_REQUIRED,
      );
      assert.equal(
        (
          await prisma.client.rovelleShot.findUniqueOrThrow({
            where: { id: secondShot.id },
          })
        ).status,
        RovelleShotStatus.FAILED,
      );
      assert.equal(
        (
          await prisma.client.rovelleEpisode.findUniqueOrThrow({
            where: { id: fixture.episodeId },
          })
        ).status,
        RovelleEpisodeStatus.REVIEW_REQUIRED,
      );
      const failedGeneration =
        await prisma.client.rovelleShotGeneration.findUniqueOrThrow({
          where: { id: second.id },
        });
      assert.equal(failedGeneration.status, RovelleGenerationStatus.FAILED);
      assert.equal(failedGeneration.actualCostUsd?.toFixed(6), "0.125000");
      const failedOutput = await prisma.client.rovelleAsset.findUniqueOrThrow({
        where: { id: second.outputAssetId },
      });
      assert.equal(failedOutput.status, RovelleAssetStatus.RESERVED);
    });

    test("treats a duplicate success webhook as a no-op", async () => {
      const fixture = await createFixture();
      const submitted = await submitShot(fixture.shotId);
      const event = successEvent(submitted.providerTaskId);
      const reservedOutput = await prisma.client.rovelleAsset.findUniqueOrThrow(
        {
          where: { id: submitted.outputAssetId },
          select: { storageKey: true },
        },
      );
      storage.headCalls.length = 0;

      await webhookService.handle(event);
      assert.deepEqual(storage.headCalls, [reservedOutput.storageKey]);
      const firstGeneration =
        await prisma.client.rovelleShotGeneration.findUniqueOrThrow({
          where: { id: submitted.id },
        });
      const firstOutput = await prisma.client.rovelleAsset.findUniqueOrThrow({
        where: { id: submitted.outputAssetId },
      });
      const firstShot = await prisma.client.rovelleShot.findUniqueOrThrow({
        where: { id: fixture.shotId },
      });
      const firstEpisode = await prisma.client.rovelleEpisode.findUniqueOrThrow(
        { where: { id: fixture.episodeId } },
      );

      storage.headCalls.length = 0;
      const duplicate = await webhookService.handle(event);
      assert.deepEqual(storage.headCalls, []);
      assert.deepEqual(duplicate, {
        accepted: true,
        disposition: "duplicate",
        generationId: submitted.id,
      });

      const secondGeneration =
        await prisma.client.rovelleShotGeneration.findUniqueOrThrow({
          where: { id: submitted.id },
        });
      const secondOutput = await prisma.client.rovelleAsset.findUniqueOrThrow({
        where: { id: submitted.outputAssetId },
      });
      const secondShot = await prisma.client.rovelleShot.findUniqueOrThrow({
        where: { id: fixture.shotId },
      });
      const secondEpisode =
        await prisma.client.rovelleEpisode.findUniqueOrThrow({
          where: { id: fixture.episodeId },
        });
      assert.equal(secondGeneration.status, firstGeneration.status);
      assert.equal(
        secondGeneration.actualCostUsd?.toFixed(6),
        firstGeneration.actualCostUsd?.toFixed(6),
      );
      assert.equal(
        secondGeneration.updatedAt.toISOString(),
        firstGeneration.updatedAt.toISOString(),
      );
      assert.equal(secondOutput.status, firstOutput.status);
      assert.equal(secondOutput.byteSize, firstOutput.byteSize);
      assert.equal(secondOutput.etag, firstOutput.etag);
      assert.equal(
        secondOutput.updatedAt.toISOString(),
        firstOutput.updatedAt.toISOString(),
      );
      assert.equal(secondShot?.status, firstShot?.status);
      assert.equal(secondEpisode?.status, firstEpisode?.status);
    });

    test("treats a duplicate failure webhook as a no-op", async () => {
      const fixture = await createFixture();
      const submitted = await submitShot(fixture.shotId);
      const event = failureEvent(submitted.providerTaskId);

      await webhookService.handle(event);
      const firstGeneration =
        await prisma.client.rovelleShotGeneration.findUniqueOrThrow({
          where: { id: submitted.id },
        });
      const firstOutput = await prisma.client.rovelleAsset.findUniqueOrThrow({
        where: { id: submitted.outputAssetId },
      });
      const firstShot = await prisma.client.rovelleShot.findUniqueOrThrow({
        where: { id: fixture.shotId },
      });
      const firstEpisode = await prisma.client.rovelleEpisode.findUniqueOrThrow(
        { where: { id: fixture.episodeId } },
      );

      const duplicate = await webhookService.handle(event);
      assert.deepEqual(duplicate, {
        accepted: true,
        disposition: "duplicate",
        generationId: submitted.id,
      });

      const secondGeneration =
        await prisma.client.rovelleShotGeneration.findUniqueOrThrow({
          where: { id: submitted.id },
        });
      const secondOutput = await prisma.client.rovelleAsset.findUniqueOrThrow({
        where: { id: submitted.outputAssetId },
      });
      const secondShot = await prisma.client.rovelleShot.findUniqueOrThrow({
        where: { id: fixture.shotId },
      });
      const secondEpisode =
        await prisma.client.rovelleEpisode.findUniqueOrThrow({
          where: { id: fixture.episodeId },
        });
      assert.equal(secondGeneration.status, firstGeneration.status);
      assert.equal(
        secondGeneration.actualCostUsd?.toFixed(6),
        firstGeneration.actualCostUsd?.toFixed(6),
      );
      assert.equal(secondGeneration.errorCode, firstGeneration.errorCode);
      assert.equal(secondGeneration.errorMessage, firstGeneration.errorMessage);
      assert.equal(
        secondGeneration.updatedAt.toISOString(),
        firstGeneration.updatedAt.toISOString(),
      );
      assert.equal(secondOutput.status, firstOutput.status);
      assert.equal(
        secondOutput.updatedAt.toISOString(),
        firstOutput.updatedAt.toISOString(),
      );
      assert.equal(secondShot?.status, firstShot?.status);
      assert.equal(secondEpisode?.status, firstEpisode?.status);
    });

    test("retries a success webhook when the output is not in R2 yet", async () => {
      const fixture = await createFixture();
      const submitted = await submitShot(fixture.shotId);
      const event = successEvent(submitted.providerTaskId);
      const output = await prisma.client.rovelleAsset.findUniqueOrThrow({
        where: { id: submitted.outputAssetId },
        select: { storageKey: true },
      });
      storage.headCalls.length = 0;
      storage.headObjectResults.set(output.storageKey, null);

      await assert.rejects(
        () => webhookService.handle(event),
        (error: unknown) =>
          error instanceof ServiceUnavailableException &&
          error.getStatus() === 503,
      );
      assert.deepEqual(storage.headCalls, [output.storageKey]);
      const pending =
        await prisma.client.rovelleShotGeneration.findUniqueOrThrow({
          where: { id: submitted.id },
        });
      assert.equal(pending.status, RovelleGenerationStatus.SUBMITTED);
      assert.equal(
        (
          await prisma.client.rovelleShot.findUniqueOrThrow({
            where: { id: fixture.shotId },
          })
        ).status,
        RovelleShotStatus.GENERATING,
      );
      assert.equal(
        (
          await prisma.client.rovelleAsset.findUniqueOrThrow({
            where: { id: submitted.outputAssetId },
          })
        ).status,
        RovelleAssetStatus.RESERVED,
      );

      storage.headCalls.length = 0;
      storage.headObjectResults.set(output.storageKey, {
        byteSize: 2048n,
        etag: "retry-etag",
        contentType: "video/mp4",
      });
      const retried = await webhookService.handle(event);
      assert.deepEqual(storage.headCalls, [output.storageKey]);
      assert.deepEqual(retried, {
        accepted: true,
        disposition: "completed",
        generationId: submitted.id,
      });
      const completed =
        await prisma.client.rovelleShotGeneration.findUniqueOrThrow({
          where: { id: submitted.id },
        });
      assert.equal(completed.status, RovelleGenerationStatus.COMPLETED);
      assert.equal(
        (
          await prisma.client.rovelleAsset.findUniqueOrThrow({
            where: { id: submitted.outputAssetId },
          })
        ).status,
        RovelleAssetStatus.AVAILABLE,
      );
    });

    test("lets a callback complete a CREATED attempt before markSubmitted", async () => {
      const fixture = await createFixture();
      let callbackResult:
        | Awaited<ReturnType<RunwareWebhookService["handle"]>>
        | undefined;
      provider.acceptedHook = async ({ taskId }) => {
        callbackResult = await webhookService.handle(successEvent(taskId));
      };
      storage.headCalls.length = 0;

      const submitted = await submitShot(fixture.shotId);
      const output = await prisma.client.rovelleAsset.findUniqueOrThrow({
        where: { id: submitted.outputAssetId },
        select: { storageKey: true },
      });
      assert.deepEqual(callbackResult, {
        accepted: true,
        disposition: "completed",
        generationId: submitted.id,
      });
      assert.equal(provider.calls.length, 1);
      assert.deepEqual(storage.headCalls, [output.storageKey]);
      assert.equal(submitted.status, RovelleGenerationStatus.COMPLETED);
      assert.equal(
        (
          await prisma.client.rovelleShotGeneration.findUniqueOrThrow({
            where: { id: submitted.id },
          })
        ).status,
        RovelleGenerationStatus.COMPLETED,
      );
      assert.equal(
        (
          await prisma.client.rovelleShot.findUniqueOrThrow({
            where: { id: fixture.shotId },
          })
        ).status,
        RovelleShotStatus.REVIEW_REQUIRED,
      );
      assert.equal(
        (
          await prisma.client.rovelleEpisode.findUniqueOrThrow({
            where: { id: fixture.episodeId },
          })
        ).status,
        RovelleEpisodeStatus.REVIEW_REQUIRED,
      );

      const marked = await generationRepository.markSubmitted(submitted.id);
      assert.equal(marked.status, "already_terminal");
      assert.equal(marked.generation.status, RovelleGenerationStatus.COMPLETED);
      assert.equal(provider.calls.length, 1);
    });

    test("returns unknown_task for a valid callback with no matching task", async () => {
      await createFixture();
      const before = await snapshotDurableState();

      const result = await webhookService.handle(successEvent(randomUUID()));
      const after = await snapshotDurableState();

      assert.deepEqual(result, {
        accepted: true,
        disposition: "unknown_task",
      });
      assert.deepEqual(after, before);
      assert.equal(provider.calls.length, 0);
    });

    test("submits a sanitized DRAFT generation and allows a second shot while GENERATING", async () => {
      const fixture = await createFixture();
      const provider = fixture.provider;
      const request = { requestId: randomUUID(), profile: "DRAFT" as const };

      const first = await generationService.submitShot(fixture.shotId, request);
      const row = await prisma.client.rovelleShotGeneration.findUnique({
        where: { id: first.id },
      });
      assert.ok(row);
      assert.equal(row.attempt, 1);
      assert.equal(row.status, RovelleGenerationStatus.SUBMITTED);
      assert.equal(row.profile, RovelleGenerationProfile.DRAFT);
      assert.equal(row.estimatedCostUsd.toFixed(6), "0.220000");

      const sanitized = row.request as {
        profile: string;
        width: number;
        height: number;
        duration: number;
        referenceAssetIds: string[];
      };
      assert.equal(sanitized.profile, "DRAFT");
      assert.equal(sanitized.width, 1280);
      assert.equal(sanitized.height, 720);
      assert.equal(sanitized.duration, 4);
      assert.deepEqual(
        new Set(sanitized.referenceAssetIds),
        new Set(fixture.referenceAssetIds),
      );
      const serializedRequest = JSON.stringify(row.request);
      assert.doesNotMatch(serializedRequest, /https?:\/\//i);
      assert.equal(serializedRequest.includes("uploadUrl"), false);

      assert.equal(provider.calls.length, 1);
      assert.equal(provider.calls[0]?.taskId, row.providerTaskId);
      assert.deepEqual(
        provider.calls[0]?.referenceImageUrls,
        fixture.referenceAssetIds.map(
          (assetId) => `https://signed.invalid/ref-${assetId}`,
        ),
      );
      assert.equal(provider.calls[0]?.width, 1280);
      assert.equal(provider.calls[0]?.height, 720);
      assert.equal(provider.calls[0]?.duration, 4);
      assert.equal(
        provider.calls[0]?.uploadUrl,
        "https://signed.invalid/output",
      );

      const outputAsset = await prisma.client.rovelleAsset.findUnique({
        where: { id: row.outputAssetId },
      });
      assert.ok(outputAsset);
      assert.equal(outputAsset.status, RovelleAssetStatus.RESERVED);
      assert.equal(outputAsset.assetType, RovelleAssetType.GENERATION);
      assert.equal(outputAsset.mediaType, "video/mp4");

      const firstShot = await prisma.client.rovelleShot.findUnique({
        where: { id: fixture.shotId },
      });
      const generatingEpisode = await prisma.client.rovelleEpisode.findUnique({
        where: { id: fixture.episodeId },
      });
      assert.equal(firstShot?.status, RovelleShotStatus.GENERATING);
      assert.equal(generatingEpisode?.status, RovelleEpisodeStatus.GENERATING);

      const sameRequest = await generationService.submitShot(
        fixture.shotId,
        request,
      );
      assert.equal(sameRequest.id, first.id);
      assert.equal(sameRequest.attempt, first.attempt);
      assert.equal(provider.calls.length, 1);
      assert.equal(
        await prisma.client.rovelleShotGeneration.count({
          where: { shotId: fixture.shotId },
        }),
        1,
      );
      assert.equal(
        await prisma.client.rovelleAsset.count({
          where: {
            episodeId: fixture.episodeId,
            assetType: RovelleAssetType.GENERATION,
          },
        }),
        1,
      );

      const secondShot = await prisma.client.rovelleShot.create({
        data: {
          episodeId: fixture.episodeId,
          sequence: 2,
          direction: "The character reaches the oak.",
          targetDurationSeconds: 4,
          status: RovelleShotStatus.READY_TO_GENERATE,
        },
      });
      const second = await generationService.submitShot(secondShot.id, {
        requestId: randomUUID(),
        profile: "DRAFT",
      });
      assert.equal(second.status, RovelleGenerationStatus.SUBMITTED);
      assert.equal(provider.calls.length, 2);
      assert.equal(
        (
          await prisma.client.rovelleShot.findUnique({
            where: { id: secondShot.id },
          })
        )?.status,
        RovelleShotStatus.GENERATING,
      );
      assert.equal(
        (
          await prisma.client.rovelleEpisode.findUnique({
            where: { id: fixture.episodeId },
          })
        )?.status,
        RovelleEpisodeStatus.GENERATING,
      );
    });

    test("persists a normalized provider failure without advancing episode or shot", async () => {
      const fixture = await createFixture();
      const provider = fixture.provider;
      provider.error = new RunwareSubmissionError(
        "QUOTA",
        "quota reached at https://provider.invalid/account",
        false,
      );
      const request = { requestId: randomUUID(), profile: "DRAFT" as const };

      await assert.rejects(
        () => generationService.submitShot(fixture.shotId, request),
        (error: unknown) => error instanceof BadGatewayException,
      );

      const failed = await prisma.client.rovelleShotGeneration.findFirst({
        where: { shotId: fixture.shotId },
      });
      assert.ok(failed);
      assert.equal(failed.attempt, 1);
      assert.equal(failed.status, RovelleGenerationStatus.SUBMISSION_FAILED);
      assert.equal(failed.errorCode, "QUOTA");
      assert.equal(failed.errorMessage, "quota reached at [redacted-url]");
      assert.equal(provider.calls.length, 1);
      assert.equal(
        (
          await prisma.client.rovelleShot.findUnique({
            where: { id: fixture.shotId },
          })
        )?.status,
        RovelleShotStatus.READY_TO_GENERATE,
      );
      assert.equal(
        (
          await prisma.client.rovelleEpisode.findUnique({
            where: { id: fixture.episodeId },
          })
        )?.status,
        RovelleEpisodeStatus.READY_TO_GENERATE,
      );
      assert.equal(
        await prisma.client.rovelleAsset.count({
          where: {
            episodeId: fixture.episodeId,
            assetType: RovelleAssetType.GENERATION,
            status: RovelleAssetStatus.RESERVED,
          },
        }),
        1,
      );
      const outputAsset = await prisma.client.rovelleAsset.findUnique({
        where: { id: failed.outputAssetId },
      });
      assert.equal(outputAsset?.status, RovelleAssetStatus.RESERVED);

      const retry = await generationService.submitShot(fixture.shotId, request);
      assert.equal(retry.id, failed.id);
      assert.equal(retry.status, RovelleGenerationStatus.SUBMISSION_FAILED);
      assert.equal(provider.calls.length, 1);
      assert.equal(
        await prisma.client.rovelleShotGeneration.count({
          where: { shotId: fixture.shotId },
        }),
        1,
      );
    });

    test("marks a reserved attempt failed when a reference URL cannot be created", async () => {
      const fixture = await createFixture();
      const request = { requestId: randomUUID(), profile: "DRAFT" as const };
      storage.readUrlError = new Error(
        "R2 read URL unavailable https://secret.invalid",
      );

      await assert.rejects(
        () => generationService.submitShot(fixture.shotId, request),
        (error: unknown) => {
          if (!(error instanceof InternalServerErrorException)) return false;
          const body = error.getResponse() as Record<string, unknown>;
          assert.equal(
            body.message,
            "Generation temporary URL preparation failed",
          );
          assert.match(String(body.generationId), /^[0-9a-f]{8}-/i);
          return true;
        },
      );

      const failed = await prisma.client.rovelleShotGeneration.findFirstOrThrow(
        {
          where: { shotId: fixture.shotId },
        },
      );
      assert.equal(failed.status, RovelleGenerationStatus.SUBMISSION_FAILED);
      assert.equal(failed.errorCode, "NETWORK");
      assert.equal(
        failed.errorMessage,
        "Generation temporary URL creation failed",
      );
      assert.equal(fixture.provider.calls.length, 0);

      const replay = await generationService.submitShot(
        fixture.shotId,
        request,
      );
      assert.equal(replay.id, failed.id);
      assert.equal(replay.status, RovelleGenerationStatus.SUBMISSION_FAILED);
      assert.equal(fixture.provider.calls.length, 0);
    });

    test("marks a reserved attempt failed when its provider output URL cannot be created", async () => {
      const fixture = await createFixture();
      const request = { requestId: randomUUID(), profile: "DRAFT" as const };
      storage.providerPutUrlError = new Error(
        "R2 output URL unavailable https://secret.invalid",
      );

      await assert.rejects(
        () => generationService.submitShot(fixture.shotId, request),
        InternalServerErrorException,
      );

      const failed = await prisma.client.rovelleShotGeneration.findFirstOrThrow(
        {
          where: { shotId: fixture.shotId },
        },
      );
      assert.equal(failed.status, RovelleGenerationStatus.SUBMISSION_FAILED);
      assert.equal(failed.errorCode, "NETWORK");
      assert.equal(
        failed.errorMessage,
        "Generation temporary URL creation failed",
      );
      assert.equal(fixture.provider.calls.length, 0);

      const replay = await generationService.submitShot(
        fixture.shotId,
        request,
      );
      assert.equal(replay.id, failed.id);
      assert.equal(replay.status, RovelleGenerationStatus.SUBMISSION_FAILED);
      assert.equal(fixture.provider.calls.length, 0);
    });

    test("submits concurrent ready shots without leaving a created attempt", async () => {
      const fixture = await createFixture();
      const secondShot = await prisma.client.rovelleShot.create({
        data: {
          episodeId: fixture.episodeId,
          sequence: 2,
          direction: "The character reaches the oak.",
          targetDurationSeconds: 4,
          status: RovelleShotStatus.READY_TO_GENERATE,
        },
      });
      fixture.provider.holdSubmissionsUntil(2);

      const [first, second] = await Promise.all([
        generationService.submitShot(fixture.shotId, {
          requestId: randomUUID(),
          profile: "DRAFT",
        }),
        generationService.submitShot(secondShot.id, {
          requestId: randomUUID(),
          profile: "DRAFT",
        }),
      ]);

      assert.deepEqual(
        (
          await prisma.client.rovelleShotGeneration.findMany({
            where: { id: { in: [first.id, second.id] } },
            select: { status: true },
          })
        ).map((generation) => generation.status),
        [RovelleGenerationStatus.SUBMITTED, RovelleGenerationStatus.SUBMITTED],
      );
      assert.equal(
        await prisma.client.rovelleShotGeneration.count({
          where: {
            id: { in: [first.id, second.id] },
            status: RovelleGenerationStatus.CREATED,
          },
        }),
        0,
      );
      assert.equal(fixture.provider.calls.length, 2);
      assert.equal(
        (
          await prisma.client.rovelleEpisode.findUnique({
            where: { id: fixture.episodeId },
          })
        )?.status,
        RovelleEpisodeStatus.GENERATING,
      );
    });

    test("does not call the provider when STYLE canon is missing", async () => {
      const fixture = await createFixture({ includeStyle: false });

      await assert.rejects(
        () =>
          generationService.submitShot(fixture.shotId, {
            requestId: randomUUID(),
            profile: "DRAFT",
          }),
        (error: unknown) =>
          error instanceof BadRequestException &&
          String(error.message).includes("CHARACTER, ENVIRONMENT, and STYLE"),
      );
      assert.equal(fixture.provider.calls.length, 0);
      assert.equal(await prisma.client.rovelleShotGeneration.count(), 0);
    });

    test("does not call the provider for a non-image reference", async () => {
      const fixture = await createFixture({
        nonImageEntityType: RovelleCanonEntityType.STYLE,
      });

      await assert.rejects(
        () =>
          generationService.submitShot(fixture.shotId, {
            requestId: randomUUID(),
            profile: "DRAFT",
          }),
        (error: unknown) =>
          error instanceof BadRequestException &&
          String(error.message).includes("image/*"),
      );
      assert.equal(fixture.provider.calls.length, 0);
      assert.equal(await prisma.client.rovelleShotGeneration.count(), 0);
    });

    test("does not call the provider for a duration below four seconds", async () => {
      const fixture = await createFixture({ duration: 3 });

      await assert.rejects(
        () =>
          generationService.submitShot(fixture.shotId, {
            requestId: randomUUID(),
            profile: "DRAFT",
          }),
        (error: unknown) =>
          error instanceof BadRequestException &&
          String(error.message).includes(
            "duration must be an integer from 4 to 30",
          ),
      );
      assert.equal(fixture.provider.calls.length, 0);
      assert.equal(await prisma.client.rovelleShotGeneration.count(), 0);
    });

    test("does not call the provider for more than thirty references", async () => {
      const fixture = await createFixture({ extraCharacterReferences: 28 });

      await assert.rejects(
        () =>
          generationService.submitShot(fixture.shotId, {
            requestId: randomUUID(),
            profile: "DRAFT",
          }),
        (error: unknown) =>
          error instanceof BadRequestException &&
          String(error.message).includes("at most 30 references"),
      );
      assert.equal(fixture.provider.calls.length, 0);
      assert.equal(await prisma.client.rovelleShotGeneration.count(), 0);
    });
  },
);
