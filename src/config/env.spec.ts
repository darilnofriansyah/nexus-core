import * as assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { readEnv, validateRovelleCreativeEnv } from "./env";

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

test("creative mode defaults off and leaves legacy startup configuration optional", () => {
  for (const key of ENV_KEYS) delete process.env[key];

  const env = readEnv();
  assert.equal(env.rovelleCreativeEnabled, false);
  assert.equal(env.rovelleCreativeBodyLimitBytes, 512 * 1024);
  assert.doesNotThrow(() => validateRovelleCreativeEnv(env));
});

test("enabled creative mode requires stable bot identity and a strong worker key", () => {
  process.env.ROVELLE_CREATIVE_ENABLED = "true";
  delete process.env.ROVELLE_TELEGRAM_BOT_ID;
  delete process.env.ROVELLE_CREATIVE_WORKER_KEY;
  assert.throws(
    () => validateRovelleCreativeEnv(readEnv()),
    /ROVELLE_TELEGRAM_BOT_ID/,
  );

  process.env.ROVELLE_TELEGRAM_BOT_ID = "test-bot";
  assert.throws(
    () => validateRovelleCreativeEnv(readEnv()),
    /ROVELLE_CREATIVE_WORKER_KEY/,
  );

  process.env.ROVELLE_CREATIVE_WORKER_KEY = "short";
  assert.throws(
    () => validateRovelleCreativeEnv(readEnv()),
    /ROVELLE_CREATIVE_WORKER_KEY/,
  );

  process.env.ROVELLE_CREATIVE_WORKER_KEY =
    "worker-secret-0123456789-0123456789";
  assert.doesNotThrow(() => validateRovelleCreativeEnv(readEnv()));

  process.env.ROVELLE_TELEGRAM_BOT_ID = " test-bot ";
  assert.throws(
    () => validateRovelleCreativeEnv(readEnv()),
    /ROVELLE_TELEGRAM_BOT_ID/,
  );
});

test("rejects invalid creative feature flag values", () => {
  process.env.ROVELLE_CREATIVE_ENABLED = "yes";
  assert.throws(() => readEnv(), /ROVELLE_CREATIVE_ENABLED/);
});
