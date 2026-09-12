import * as assert from "node:assert/strict";
import { test } from "node:test";
import { hashCreativeValue } from "./creative-validation";
import { creativeInput } from "./creative.fixture";

test("creative input hashes are stable for the persisted fixture", () => {
  const first = hashCreativeValue(creativeInput);
  const second = hashCreativeValue({
    ...creativeInput,
    canon: [...creativeInput.canon],
  });

  assert.equal(first, second);
  assert.match(first, /^[0-9a-f]{64}$/);
});
