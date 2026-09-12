import * as assert from "node:assert/strict";
import { test } from "node:test";
import { creativeInput, creativeResult } from "./creative.fixture";
import { renderCreativePages } from "./creative-preview";

const TELEGRAM_TEXT_LIMIT = 3_500;
const PAGE_LABEL = /^Creative draft \(page \d+ of \d+\)\n/;

test("renders every storyboard field across bounded pages without splitting code points", () => {
  const synopsis = "A complete synopsis.";
  const pageCapacity = TELEGRAM_TEXT_LIMIT - "Creative draft (page 1 of 4)\n".length;
  const scriptPrefix = `Title: ${creativeInput.title}\nSynopsis: ${synopsis}\nScript: `;
  const firstEmojiOffset = pageCapacity - scriptPrefix.length - 1;
  const secondEmojiOffset = 2 * pageCapacity - scriptPrefix.length - 1;
  const script = `${"x".repeat(firstEmojiOffset)}🧵${"y".repeat(secondEmojiOffset - firstEmojiOffset - 2)}🧶${"z".repeat(12_000 - secondEmojiOffset - 2)}`;
  assert.equal(script.length, 12_000);
  const result = {
    ...creativeResult,
    synopsis,
    script,
    shots: [
      {
        ...creativeResult.shots[0]!,
        direction: "A complete direction.",
        narration: "A complete narration.",
        imagePrompt: "A complete image prompt.",
      },
    ],
  };

  const pages = renderCreativePages(creativeInput, result);
  assert.ok(pages.length > 1);
  assert.ok(pages.every((page) => page.length <= TELEGRAM_TEXT_LIMIT));
  assert.ok(pages.every((page) => PAGE_LABEL.test(page)));

  const bodies = pages.map((page) => page.replace(PAGE_LABEL, ""));
  const joined = bodies.join("");
  assert.ok(joined.includes(result.synopsis));
  assert.ok(joined.includes(result.script));
  assert.ok(joined.includes(result.shots[0]!.direction));
  assert.ok(joined.includes(result.shots[0]!.narration));
  assert.ok(joined.includes(result.shots[0]!.imagePrompt));
  const boundaries: number[] = [];
  let bodyLength = 0;
  for (const body of bodies) {
    bodyLength += body.length;
    boundaries.push(bodyLength);
    assert.equal(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(body), false);
  }
  for (const emoji of ["🧵", "🧶"]) {
    const emojiOffset = joined.indexOf(emoji);
    assert.ok(boundaries.some((boundary) => Math.abs(boundary - emojiOffset) <= 1));
  }

  for (const emoji of ["🧵", "🧶"]) {
    assert.equal(Array.from(joined).filter((point) => point === emoji).length, 1);
  }
  assert.equal(
    joined,
    [
      `Title: ${creativeInput.title}\n`,
      `Synopsis: ${result.synopsis}\n`,
      `Script: ${result.script}\n`,
      `Shot 1 (4 seconds)\nDirection: ${result.shots[0]!.direction}\n`,
      `Narration: ${result.shots[0]!.narration}\n`,
      `Image prompt: ${result.shots[0]!.imagePrompt}`,
    ].join(""),
  );
});

test("keeps a one-page storyboard under the Telegram limit", () => {
  const pages = renderCreativePages(creativeInput, creativeResult);

  assert.equal(pages.length, 1);
  assert.ok(pages[0]!.length <= TELEGRAM_TEXT_LIMIT);
  assert.match(pages[0]!, /Synopsis: Two friends learn to take turns\./);
});
