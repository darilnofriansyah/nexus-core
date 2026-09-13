import * as assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { Test } from "@nestjs/testing";
import { CreativeApprovalService } from "../creative/creative-approval.service";
import { CreativeModule } from "../creative/creative.module";
import { CreativeRepository } from "../creative/creative.repository";
import { CreatorService } from "./creator.service";
import { CreatorModule } from "./creator.module";

const ENV_KEYS = [
  "ROVELLE_CREATIVE_ENABLED",
  "ROVELLE_TELEGRAM_BOT_ID",
  "ROVELLE_CREATIVE_WORKER_KEY",
] as const;
const originalEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = originalEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test("wires creator services through the creative feature module", async () => {
  process.env.ROVELLE_CREATIVE_ENABLED = "false";
  const module = await Test.createTestingModule({
    imports: [CreatorModule],
  }).compile();
  assert.ok(module.get(CreatorService));
  assert.ok(module.get(CreativeRepository));
  assert.ok(module.get(CreativeApprovalService));
  await module.close();
});

test("enabled creative startup requires bot identity and worker key", async () => {
  process.env.ROVELLE_CREATIVE_ENABLED = "true";
  delete process.env.ROVELLE_TELEGRAM_BOT_ID;
  delete process.env.ROVELLE_CREATIVE_WORKER_KEY;
  await assert.rejects(
    () => Test.createTestingModule({ imports: [CreativeModule] }).compile(),
    /ROVELLE_TELEGRAM_BOT_ID/,
  );

  process.env.ROVELLE_TELEGRAM_BOT_ID = "test-bot";
  await assert.rejects(
    () => Test.createTestingModule({ imports: [CreativeModule] }).compile(),
    /ROVELLE_CREATIVE_WORKER_KEY/,
  );
});
