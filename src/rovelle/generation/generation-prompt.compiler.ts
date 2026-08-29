import { BadRequestException, Injectable } from "@nestjs/common";
import type { RovelleCanonEntityType } from "../../generated/prisma/client";
import type { CanonPinDto } from "../canon/dto/canon.dto";

const MAX_PROMPT_CHARACTERS = 10_000;
const URL_PATTERN = /(?:\b[a-z][a-z\d+.-]*:(?=\S)|\/\/)/i;

export interface PreparedReference {
  assetId: string;
  entityCode: string;
  entityType: RovelleCanonEntityType;
  version: number;
  role: string;
  mediaType: string;
}

export interface PreparedShotGeneration {
  shotId: string;
  episodeId: string;
  direction: string;
  duration: number;
  prompt: string;
  references: PreparedReference[];
}

export interface PromptCompilationInput {
  shotId: string;
  episodeId: string;
  direction: string;
  duration: number;
  canon: readonly CanonPinDto[];
}

@Injectable()
export class GenerationPromptCompiler {
  compile(input: PromptCompilationInput): PreparedShotGeneration {
    const references: PreparedReference[] = [];
    const canonReferences = [...input.canon]
      .sort((left, right) => {
        const leftCode = left.version.entity.code;
        const rightCode = right.version.entity.code;
        return leftCode < rightCode ? -1 : leftCode > rightCode ? 1 : 0;
      })
      .flatMap((pin) =>
        pin.version.assets.map((attachment) => {
          const reference: PreparedReference = {
            assetId: attachment.asset.id,
            entityCode: pin.version.entity.code,
            entityType: pin.version.entity.entityType,
            version: pin.version.version,
            role: attachment.role,
            mediaType: attachment.asset.mediaType,
          };
          references.push(reference);
          return `@Image${references.length} — ${reference.entityCode} V${reference.version} — ${reference.role}\nDefinition: ${stableJson(pin.version.definition)}`;
        }),
      );
    const prompt = [
      "Create one continuous Clovervale animated storybook shot.",
      "",
      "SHOT DIRECTION",
      input.direction,
      "",
      "CANON REFERENCES",
      canonReferences.join("\n\n"),
      "",
      "CONTINUITY RULES",
      "- Preserve canon identity, proportions, colors, clothing, props, and environment design.",
      "- Treat character/environment scale relationships as mandatory.",
      "- Keep the approved Clovervale illustrated storybook rendering language.",
      "- Do not add logos, captions, subtitles, UI, or on-screen text.",
      "- Maintain stable anatomy and design throughout the shot.",
    ].join("\n");

    if (URL_PATTERN.test(prompt)) {
      throw new BadRequestException("prompt must not contain URLs");
    }
    if (prompt.length > MAX_PROMPT_CHARACTERS) {
      throw new BadRequestException("prompt must be at most 10,000 characters");
    }

    return {
      shotId: input.shotId,
      episodeId: input.episodeId,
      direction: input.direction,
      duration: input.duration,
      prompt,
      references,
    };
  }
}

function stableJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new BadRequestException("canon definition must contain JSON values");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
      .join(",")}}`;
  }
  throw new BadRequestException("canon definition must contain JSON values");
}
