import * as assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { Test } from "@nestjs/testing";
import { CreativeController } from "./creative/creative.controller";
import { CreativeRepository } from "./creative/creative.repository";
import { RovelleModule } from "./rovelle.module";

const originalFlag = process.env.ROVELLE_CREATIVE_ENABLED;

afterEach(() => {
  if (originalFlag === undefined) delete process.env.ROVELLE_CREATIVE_ENABLED;
  else process.env.ROVELLE_CREATIVE_ENABLED = originalFlag;
});

test("boots the Rovelle creative boundary without circular module imports", async () => {
  process.env.ROVELLE_CREATIVE_ENABLED = "false";
  const module = await Test.createTestingModule({
    imports: [RovelleModule],
  }).compile();
  assert.ok(module.get(CreativeRepository));
  assert.ok(module.get(CreativeController));
  await module.close();
});
