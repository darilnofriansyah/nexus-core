import "reflect-metadata";
import * as assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { Test } from "@nestjs/testing";
import { Reflector } from "@nestjs/core";
import { ApiKeyGuard } from "../../common/guards/api-key.guard";
import { AssetService } from "../assets/asset.service";
import { FinalReviewController } from "./final-review.controller";
import { FinalReviewQueueService } from "./final-review-queue.service";
import { FinalReviewService } from "./final-review.service";

const API_KEY = "local-smoke-key";
const EPISODE_ID = "550e8400-e29b-41d4-a716-446655440000";
const RENDER_ID = "650e8400-e29b-41d4-a716-446655440000";

class EmptyReviewService {}

class EmptyQueueService {
  async listQueue(): Promise<unknown[]> {
    return [
      {
        episode: {
          id: EPISODE_ID,
          code: "SMOKE-001",
          title: "Final review smoke episode",
          status: "FINAL_REVIEW",
        },
        render: { id: RENDER_ID },
        reviews: [],
        preview: {
          method: "GET",
          url: "https://signed.invalid/final-review-preview",
          headers: {},
          expiresAt: "2099-01-01T00:00:00.000Z",
        },
      },
    ];
  }

  async getApprovedFinalMaster(): Promise<unknown> {
    return {};
  }
}

const originalCoreApiKey = process.env.CORE_API_KEY;

afterEach(() => {
  if (originalCoreApiKey === undefined) delete process.env.CORE_API_KEY;
  else process.env.CORE_API_KEY = originalCoreApiKey;
});

test("smokes the authenticated final-review queue over loopback HTTP", async () => {
  process.env.CORE_API_KEY = API_KEY;
  const moduleRef = await Test.createTestingModule({
    controllers: [FinalReviewController],
    providers: [
      { provide: FinalReviewService, useClass: EmptyReviewService },
      { provide: FinalReviewQueueService, useClass: EmptyQueueService },
      { provide: AssetService, useValue: {} },
    ],
  }).compile();
  const app = moduleRef.createNestApplication();
  app.setGlobalPrefix("api");
  app.useLogger(false);
  app.useGlobalGuards(new ApiKeyGuard(new Reflector()));
  await app.init();
  await app.listen(0, "127.0.0.1");

  try {
    const address = app.getHttpServer().address();
    assert.ok(address && typeof address !== "string");
    const endpoint = `http://127.0.0.1:${address.port}/api/rovelle/final-reviews/queue`;
    const unauthorized = await fetch(endpoint);
    assert.equal(unauthorized.status, 401);

    const result = await fetch(endpoint, {
      headers: { "x-core-api-key": API_KEY },
    });
    const body = (await result.json()) as { ok: boolean; data: unknown[] };

    assert.equal(result.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.data.length, 1);
    const candidate = body.data[0] as {
      episode: { id: string; status: string };
      render: { id: string };
      preview: { method: string; url: string; expiresAt: string };
    };
    assert.deepEqual(candidate.episode, {
      id: EPISODE_ID,
      code: "SMOKE-001",
      title: "Final review smoke episode",
      status: "FINAL_REVIEW",
    });
    assert.equal(candidate.render.id, RENDER_ID);
    assert.equal(candidate.preview.method, "GET");
    assert.equal(candidate.preview.url, "https://signed.invalid/final-review-preview");
    assert.equal(candidate.preview.expiresAt, "2099-01-01T00:00:00.000Z");
    assert.doesNotMatch(JSON.stringify(body), /storageKey|leaseToken/);
  } finally {
    await app.close();
  }
});
