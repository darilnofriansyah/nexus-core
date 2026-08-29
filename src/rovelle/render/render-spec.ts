import { createHash } from "node:crypto";
import { BadRequestException } from "@nestjs/common";

export interface RenderAssetSnapshot {
  assetId: string;
  mediaType: string;
  byteSize: string;
  etag: string | null;
}

export interface RenderShotSnapshot {
  sequence: number;
  shotId: string;
  generationId: string;
  targetDurationSeconds: number;
  video: RenderAssetSnapshot;
}

export interface RenderSpecV1 {
  version: 1;
  profile: "VERTICAL_SHORT_V1";
  output: {
    container: "mp4";
    width: 1080;
    height: 1920;
    frameRate: 30;
    videoCodec: "libx264";
    pixelFormat: "yuv420p";
    audioCodec: "aac";
    audioSampleRate: 48000;
  };
  shots: RenderShotSnapshot[];
  audio: RenderAssetSnapshot;
  captions:
    | (RenderAssetSnapshot & {
        format: "WEBVTT" | "SRT";
      })
    | null;
}

export interface BuildRenderSpecV1Input {
  shots: readonly RenderShotSnapshot[];
  audio: RenderAssetSnapshot;
  captions?: RenderAssetSnapshot | null;
}

const RENDER_OUTPUT: RenderSpecV1["output"] = Object.freeze({
  container: "mp4",
  width: 1080,
  height: 1920,
  frameRate: 30,
  videoCodec: "libx264",
  pixelFormat: "yuv420p",
  audioCodec: "aac",
  audioSampleRate: 48000,
});

function snapshotAsset(asset: RenderAssetSnapshot): RenderAssetSnapshot {
  return {
    assetId: asset.assetId,
    mediaType: asset.mediaType,
    byteSize: asset.byteSize,
    etag: asset.etag,
  };
}

function captionFormat(mediaType: string): "WEBVTT" | "SRT" {
  switch (mediaType.trim().toLowerCase()) {
    case "text/vtt":
      return "WEBVTT";
    case "application/x-subrip":
      return "SRT";
    default:
      throw new BadRequestException("caption mediaType must be text/vtt or application/x-subrip");
  }
}

function snapshotCaption(
  caption: RenderAssetSnapshot | null | undefined,
): (RenderAssetSnapshot & { format: "WEBVTT" | "SRT" }) | null {
  if (caption === null || caption === undefined) return null;

  return {
    ...snapshotAsset(caption),
    format: captionFormat(caption.mediaType),
  };
}

export function buildRenderSpecV1(input: BuildRenderSpecV1Input): RenderSpecV1 {
  return {
    version: 1,
    profile: "VERTICAL_SHORT_V1",
    output: RENDER_OUTPUT,
    shots: [...input.shots]
      .sort((left, right) => left.sequence - right.sequence)
      .map((shot) => ({
        sequence: shot.sequence,
        shotId: shot.shotId,
        generationId: shot.generationId,
        targetDurationSeconds: shot.targetDurationSeconds,
        video: snapshotAsset(shot.video),
      })),
    audio: snapshotAsset(input.audio),
    captions: snapshotCaption(input.captions),
  };
}

export function stableRenderSpecJson(spec: RenderSpecV1): string {
  return stableJson(spec);
}

export function hashRenderSpec(spec: RenderSpecV1): string {
  return createHash("sha256")
    .update(stableRenderSpecJson(spec), "utf8")
    .digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }

  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
      .join(",")}}`;
  }

  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new TypeError("render spec must contain JSON values");
  }

  return serialized;
}
