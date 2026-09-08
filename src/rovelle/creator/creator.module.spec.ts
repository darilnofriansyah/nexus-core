import * as assert from "node:assert/strict";
import { test } from "node:test";
import { Test } from "@nestjs/testing";
import { CreatorService } from "./creator.service";
import { CreatorModule } from "./creator.module";

test("wires the creator domain services", async () => {
  const module = await Test.createTestingModule({ imports: [CreatorModule] }).compile();
  assert.ok(module.get(CreatorService));
  await module.close();
});
