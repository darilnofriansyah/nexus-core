import * as assert from "node:assert/strict";
import { test } from "node:test";
import { HEADERS_METADATA } from "@nestjs/common/constants";
import { SKIP_CORE_API_KEY } from "../../common/decorators/skip-core-api-key.decorator";
import { CreatorUploadController } from "./creator-upload.controller";
import { CreatorUploadService } from "./creator-upload.service";

test("serves the public mobile page with no-store and no-referrer headers", async () => {
  const service = {
    page: async () => "<input type=\"file\">",
    prepare: async () => ({ upload: { url: "https://r2.example" } }),
    complete: async () => ({ text: "Done" }),
  };
  const controller = new CreatorUploadController(service as unknown as CreatorUploadService);
  assert.match(await controller.page("opaque-token"), /input/);
  assert.deepEqual(await controller.complete("opaque-token"), { ok: true, data: { text: "Done" } });
  assert.equal(Reflect.getMetadata(SKIP_CORE_API_KEY, CreatorUploadController), true);
  for (const method of ["page", "prepare", "complete"] as const) {
    const headers = Reflect.getMetadata(HEADERS_METADATA, CreatorUploadController.prototype[method]);
    assert.ok(headers.some((header: { name: string; value: string }) => header.name === "Referrer-Policy" && header.value === "no-referrer"));
    assert.ok(headers.some((header: { name: string; value: string }) => header.name === "Cache-Control" && header.value === "no-store"));
  }
});
