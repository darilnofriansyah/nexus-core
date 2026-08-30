import * as assert from "node:assert/strict";
import { test } from "node:test";
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from "@nestjs/common";
import {
  RovelleAssetStatus,
  RovelleAssetType,
  RovelleRenderJobStatus,
  RovelleRenderProfile,
  RovelleRenderStatus,
} from "../../generated/prisma/client";
import { buildAssetStorageKey } from "../assets/asset-validation";
import { toRenderDto } from "./render-mapper";
import type {
  CreateRenderResult,
  InternalRenderRecord,
  RenderRepository,
  RetryRenderResult,
} from "./render.repository";
import { RenderService } from "./render.service";

const EPISODE_ID = "550e8400-e29b-41d4-a716-446655440000";
const RENDER_ID = "650e8400-e29b-41d4-a716-446655440000";
const OUTPUT_ASSET_ID = "750e8400-e29b-41d4-a716-446655440000";
const REQUEST_ID = "850e8400-e29b-41d4-a716-446655440000";
const AUDIO_ASSET_ID = "950e8400-e29b-41d4-a716-446655440000";
const CAPTION_ASSET_ID = "a50e8400-e29b-41d4-a716-446655440000";

const spec = {
  version: 1,
  profile: "VERTICAL_SHORT_V1",
  output: {
    container: "mp4",
    width: 1080,
    height: 1920,
    frameRate: 30,
    videoCodec: "libx264",
    pixelFormat: "yuv420p",
    audioCodec: "aac",
    audioSampleRate: 48000,
  },
  shots: [],
  audio: { assetId: AUDIO_ASSET_ID, mediaType: "audio/mpeg", byteSize: "1", etag: null },
  captions: null,
};

const render = {
  id: RENDER_ID,
  clientRequestId: REQUEST_ID,
  episodeId: EPISODE_ID,
  attempt: 1,
  profile: RovelleRenderProfile.VERTICAL_SHORT_V1,
  status: RovelleRenderStatus.QUEUED,
  specVersion: 1,
  spec,
  specHash: "a".repeat(64),
  outputAssetId: OUTPUT_ASSET_ID,
  completedAt: null,
  createdAt: new Date("2026-08-29T01:00:00.000Z"),
  updatedAt: new Date("2026-08-29T01:01:00.000Z"),
  outputAsset: {
    id: OUTPUT_ASSET_ID,
    episodeId: EPISODE_ID,
    assetType: RovelleAssetType.RENDER,
    status: RovelleAssetStatus.RESERVED,
    mediaType: "video/mp4",
    storageKey: buildAssetStorageKey(OUTPUT_ASSET_ID),
    originalFilename: null,
    byteSize: null,
    etag: null,
    createdAt: new Date("2026-08-29T01:00:00.000Z"),
    updatedAt: new Date("2026-08-29T01:01:00.000Z"),
  },
  jobs: [
    {
      id: "b50e8400-e29b-41d4-a716-446655440000",
      clientRequestId: REQUEST_ID,
      renderId: RENDER_ID,
      attempt: 1,
      status: RovelleRenderJobStatus.QUEUED,
      availableAt: new Date("2026-08-29T01:00:00.000Z"),
      workerId: null,
      leaseToken: null,
      claimedAt: null,
      heartbeatAt: null,
      leaseExpiresAt: null,
      startedAt: null,
      finishedAt: null,
      errorCode: null,
      errorMessage: null,
      createdAt: new Date("2026-08-29T01:00:00.000Z"),
      updatedAt: new Date("2026-08-29T01:00:00.000Z"),
    },
  ],
} as unknown as InternalRenderRecord;

class StubRenderRepository {
  createResult: CreateRenderResult = { status: "created", render };
  retryResult: RetryRenderResult = { status: "queued", render };
  found: InternalRenderRecord | null = render;
  listed: InternalRenderRecord[] = [render];
  createCalls: Array<Record<string, string | null>> = [];
  retryCalls: Array<Record<string, string>> = [];
  findCalls: string[] = [];
  listCalls: string[] = [];

  async createQueuedRender(input: Record<string, string | null>) {
    this.createCalls.push(input);
    return this.createResult;
  }

  async retryRender(input: { renderId: string; clientRequestId: string }) {
    this.retryCalls.push(input);
    return this.retryResult;
  }

  async findRender(id: string) {
    this.findCalls.push(id);
    return this.found;
  }

  async listEpisodeRenders(episodeId: string) {
    this.listCalls.push(episodeId);
    return this.listed;
  }
}

function createService() {
  const repository = new StubRenderRepository();
  return {
    repository,
    service: new RenderService(repository as unknown as RenderRepository),
  };
}

test("creates a normalized render request with an internally generated output key", async () => {
  const { repository, service } = createService();

  const result = await service.createRender(EPISODE_ID, {
    requestId: `  ${REQUEST_ID} `,
    audioAssetId: ` ${AUDIO_ASSET_ID} `,
    captionAssetId: ` ${CAPTION_ASSET_ID} `,
  });

  assert.deepEqual(result, toRenderDto(render));
  assert.equal(repository.createCalls.length, 1);
  const input = repository.createCalls[0]!;
  assert.equal(input.clientRequestId, REQUEST_ID);
  assert.equal(input.episodeId, EPISODE_ID);
  assert.equal(input.audioAssetId, AUDIO_ASSET_ID);
  assert.equal(input.captionAssetId, CAPTION_ASSET_ID);
  assert.match(input.outputAssetId!, /^[0-9a-f-]{36}$/);
  assert.equal(input.outputStorageKey, buildAssetStorageKey(input.outputAssetId!));
  assert.equal("leaseToken" in result.jobs[0]!, false);
  assert.equal("storageKey" in result.outputAsset, false);
});

test("maps an existing create result to the same public render DTO", async () => {
  const { repository, service } = createService();
  repository.createResult = { status: "existing", render };

  assert.deepEqual(
    await service.createRender(EPISODE_ID, {
      requestId: REQUEST_ID,
      audioAssetId: AUDIO_ASSET_ID,
    }),
    toRenderDto(render),
  );
  assert.equal(repository.createCalls.length, 1);
});

test("maps create repository outcomes to the required HTTP exceptions", async () => {
  const cases: Array<[CreateRenderResult["status"], typeof BadRequestException | typeof NotFoundException, string]> = [
    ["episode_not_found", NotFoundException, ""],
    ["invalid_episode_state", BadRequestException, "Episode must be generation-approved before rendering"],
    ["no_shots", BadRequestException, "Episode must contain at least one approved shot"],
    ["shot_not_approved", BadRequestException, "Every shot must have an approved generation before rendering"],
    ["approved_generation_invalid", BadRequestException, "An approved shot generation is not renderable"],
    ["audio_invalid", BadRequestException, "Audio master is not valid for this episode"],
    ["caption_invalid", BadRequestException, "Caption asset is not valid for this episode"],
  ];

  for (const [status, exception, message] of cases) {
    const { repository, service } = createService();
    repository.createResult = status === "shot_not_approved" || status === "approved_generation_invalid"
      ? { status, shotId: "internal-shot-id" }
      : { status } as CreateRenderResult;

    await assert.rejects(
      () => service.createRender(EPISODE_ID, { requestId: REQUEST_ID, audioAssetId: AUDIO_ASSET_ID }),
      (error: unknown) => error instanceof exception && (!message || (error as Error).message === message),
    );
  }
});

test("gets and lists mapped renders while preserving repository list order", async () => {
  const { repository, service } = createService();
  const second = { ...render, id: "c50e8400-e29b-41d4-a716-446655440000" } as InternalRenderRecord;
  repository.listed = [second, render];

  assert.deepEqual(await service.getRender(RENDER_ID), toRenderDto(render));
  assert.deepEqual(await service.listEpisodeRenders(EPISODE_ID), [toRenderDto(second), toRenderDto(render)]);
  assert.deepEqual(repository.findCalls, [RENDER_ID]);
  assert.deepEqual(repository.listCalls, [EPISODE_ID]);
});

test("throws not found when reading a missing render", async () => {
  const { repository, service } = createService();
  repository.found = null;

  await assert.rejects(() => service.getRender(RENDER_ID), NotFoundException);
});

test("retries with a normalized request and maps repository outcomes", async () => {
  const { repository, service } = createService();
  const result = await service.retryRender(RENDER_ID, { requestId: ` ${REQUEST_ID} ` });

  assert.deepEqual(result, toRenderDto(render));
  assert.deepEqual(repository.retryCalls, [{ renderId: RENDER_ID, clientRequestId: REQUEST_ID }]);

  const cases: Array<[RetryRenderResult["status"], typeof BadRequestException | typeof NotFoundException | typeof ConflictException, string]> = [
    ["not_found", NotFoundException, ""],
    ["request_conflict", ConflictException, "Render retry request ID was already used for another render"],
    ["invalid_render_state", BadRequestException, "Only failed renders can be retried"],
    ["invalid_episode_state", BadRequestException, "Episode is not in a renderable retry state"],
    ["output_not_retryable", BadRequestException, "Render output reservation cannot be retried"],
    ["active_job_exists", ConflictException, "Render already has an active job"],
  ];

  for (const [status, exception, message] of cases) {
    const next = createService();
    next.repository.retryResult = { status } as RetryRenderResult;
    await assert.rejects(
      () => next.service.retryRender(RENDER_ID, { requestId: REQUEST_ID }),
      (error: unknown) => error instanceof exception && (!message || (error as Error).message === message),
    );
  }
});
