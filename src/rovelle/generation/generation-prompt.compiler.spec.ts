import * as assert from "node:assert/strict";
import { test } from "node:test";
import {
  RovelleAssetStatus,
  RovelleCanonEntityType,
  RovelleCanonVersionStatus,
} from "../../generated/prisma/client";
import type { CanonPinDto } from "../canon/dto/canon.dto";
import { GenerationPromptCompiler } from "./generation-prompt.compiler";

const CREATED_AT = "2026-08-28T00:00:00.000Z";

function pin(
  code: string,
  entityType: RovelleCanonEntityType,
  definition: Record<string, unknown>,
  assets: Array<{ id: string; role: string }>,
): CanonPinDto {
  return {
    source: "EPISODE",
    version: {
      id: `${code}-version`,
      entityId: `${code}-entity`,
      version: 1,
      status: RovelleCanonVersionStatus.LOCKED,
      definition,
      lockedAt: CREATED_AT,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
      entity: {
        id: `${code}-entity`,
        code,
        displayName: code,
        entityType,
        description: null,
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
      },
      assets: assets.map((asset, index) => ({
        role: asset.role,
        sortOrder: index,
        asset: {
          id: asset.id,
          episodeId: null,
          assetType: "CHARACTER_REFERENCE",
          status: RovelleAssetStatus.AVAILABLE,
          mediaType: "image/png",
          originalFilename: null,
          byteSize: "1",
          etag: null,
          createdAt: CREATED_AT,
          updatedAt: CREATED_AT,
        },
      })),
    },
  };
}

const CANON = [
  pin(
    "KOKO",
    RovelleCanonEntityType.CHARACTER,
    { palette: { secondary: "cream", primary: "yellow" }, species: "chick" },
    [
      { id: "koko-main", role: "primary" },
      { id: "koko-detail", role: "detail" },
    ],
  ),
  pin(
    "MEADOW_VILLAGE",
    RovelleCanonEntityType.ENVIRONMENT,
    { buildings: "round", season: "spring" },
    [{ id: "meadow-main", role: "location" }],
  ),
  pin(
    "CLOVERVALE_STORYBOOK_STYLE",
    RovelleCanonEntityType.STYLE,
    { linework: "soft", palette: "pastel" },
    [{ id: "style-main", role: "rendering" }],
  ),
];

test("compiles a byte-identical prompt with the primary asset from each canon type", () => {
  const compiler = new GenerationPromptCompiler();
  const input = {
    shotId: "shot-1",
    episodeId: "episode-1",
    direction: "Koko walks through the meadow.",
    duration: 8,
    canon: CANON,
  };

  const first = compiler.compile(input);
  const second = compiler.compile(input);

  assert.equal(first.prompt, second.prompt);
  assert.deepEqual(
    first.references.map((reference) => [reference.assetId, reference.role]),
    [
      ["style-main", "rendering"],
      ["koko-main", "primary"],
      ["meadow-main", "location"],
    ],
  );
  assert.match(
    first.prompt,
    /@Image1 — CLOVERVALE_STORYBOOK_STYLE V1 — rendering/,
  );
  assert.match(first.prompt, /@Image2 — KOKO V1 — primary/);
  assert.match(first.prompt, /@Image3 — MEADOW_VILLAGE V1 — location/);
  assert.equal(first.prompt.includes("KOKO V1 — detail"), false);
  assert.equal(first.prompt.includes("http://"), false);
  assert.equal(first.prompt.includes("https://"), false);
});

test("sorts JSON keys recursively in canon definitions", () => {
  const prompt = new GenerationPromptCompiler().compile({
    shotId: "shot-1",
    episodeId: "episode-1",
    direction: "Hold on Koko.",
    duration: 8,
    canon: [
      pin(
        "KOKO",
        RovelleCanonEntityType.CHARACTER,
        { z: 3, a: { z: 2, a: 1 } },
        [{ id: "koko-main", role: "primary" }],
      ),
    ],
  }).prompt;

  assert.match(prompt, /Definition: {"a":{"a":1,"z":2},"z":3}/);
});

test("rejects prompts longer than 10,000 characters", () => {
  assert.throws(
    () =>
      new GenerationPromptCompiler().compile({
        shotId: "shot-1",
        episodeId: "episode-1",
        direction: "x".repeat(10_001),
        duration: 8,
        canon: CANON,
      }),
    /10,000 characters/,
  );
});

test("rejects URLs in shot direction", () => {
  assert.throws(
    () =>
      new GenerationPromptCompiler().compile({
        shotId: "shot-1",
        episodeId: "episode-1",
        direction: "Use https://untrusted.example/reference for Koko.",
        duration: 8,
        canon: CANON,
      }),
    /prompt must not contain URLs/,
  );
});

test("rejects URLs in nested canon definitions", () => {
  assert.throws(
    () =>
      new GenerationPromptCompiler().compile({
        shotId: "shot-1",
        episodeId: "episode-1",
        direction: "Hold on Koko.",
        duration: 8,
        canon: [
          pin(
            "KOKO",
            RovelleCanonEntityType.CHARACTER,
            { references: { source: "http://untrusted.example/koko" } },
            [{ id: "koko-main", role: "primary" }],
          ),
        ],
      }),
    /prompt must not contain URLs/,
  );
});

test("rejects non-http URI schemes in shot direction", () => {
  assert.throws(
    () =>
      new GenerationPromptCompiler().compile({
        shotId: "shot-1",
        episodeId: "episode-1",
        direction: "Use FTP://untrusted.example/reference for Koko.",
        duration: 8,
        canon: CANON,
      }),
    /prompt must not contain URLs/,
  );
});

test("rejects protocol-relative URLs in nested canon definitions", () => {
  assert.throws(
    () =>
      new GenerationPromptCompiler().compile({
        shotId: "shot-1",
        episodeId: "episode-1",
        direction: "Hold on Koko.",
        duration: 8,
        canon: [
          pin(
            "KOKO",
            RovelleCanonEntityType.CHARACTER,
            { references: { source: "//untrusted.example/koko" } },
            [{ id: "koko-main", role: "primary" }],
          ),
        ],
      }),
    /prompt must not contain URLs/,
  );
});
