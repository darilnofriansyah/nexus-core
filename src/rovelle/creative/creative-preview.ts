import type { CreativeInput, CreativeResult } from "./dto/creative.dto";

export const CREATIVE_TELEGRAM_TEXT_LIMIT = 3_500;

export function renderCreativePages(input: CreativeInput, result: CreativeResult): string[] {
  const body = [
    `Title: ${input.title}\n`,
    `Synopsis: ${result.synopsis}\n`,
    `Script: ${result.script}\n`,
    ...result.shots.map(
      (shot) =>
        `Shot ${shot.sequence} (${shot.durationSeconds} seconds)\n` +
        `Direction: ${shot.direction}\n` +
        `Narration: ${shot.narration}\n` +
        `Image prompt: ${shot.imagePrompt}`,
    ),
  ].join("");

  let pageCount = 1;
  for (;;) {
    const chunks = splitBody(body, (page) => CREATIVE_TELEGRAM_TEXT_LIMIT - pageLabel(page, pageCount).length);
    if (chunks.length === pageCount) {
      return chunks.map((chunk, index) => `${pageLabel(index + 1, pageCount)}${chunk}`);
    }
    pageCount = chunks.length;
  }
}

function pageLabel(page: number, pageCount: number): string {
  return `Creative draft (page ${page} of ${pageCount})\n`;
}

function splitBody(body: string, capacity: (page: number) => number): string[] {
  const pages: string[] = [];
  let chunk = "";
  let length = 0;

  for (const codePoint of body) {
    const maxLength = capacity(pages.length + 1);
    if (chunk && length + codePoint.length > maxLength) {
      pages.push(chunk);
      chunk = "";
      length = 0;
    }
    chunk += codePoint;
    length += codePoint.length;
  }

  if (chunk) pages.push(chunk);
  return pages;
}
