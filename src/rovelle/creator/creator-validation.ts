import { BadRequestException } from "@nestjs/common";
import type {
  CreatorDraftData,
  CreatorStep,
  CreatorTelegramRequest,
  CreatorTelegramRequestDto,
} from "./dto/creator.dto";

const DECIMAL_ID = /^[0-9]+$/;

export function normalizeCreatorTelegramRequest(input: CreatorTelegramRequestDto): CreatorTelegramRequest {
  if (!input || typeof input !== "object") throw new BadRequestException("request must be an object");
  assertDecimalId(input.telegramUserId, "telegramUserId");
  assertDecimalId(input.chatId, "chatId");
  if (input.updateId !== undefined) assertDecimalId(input.updateId, "updateId", 32);
  const hasMessage = typeof input.messageText === "string";
  const hasCallback = typeof input.callbackToken === "string";
  if (hasMessage === hasCallback) throw new BadRequestException("exactly one of messageText or callbackToken is required");
  const updateId = input.updateId === undefined ? {} : { updateId: input.updateId };
  if (hasCallback) {
    const token = input.callbackToken!.slice(3);
    if (!input.callbackToken!.startsWith("rv:") || !token.trim() || /[\r\n]/.test(token)) {
      throw new BadRequestException("callbackToken must start with rv: and contain a token");
    }
    return { telegramUserId: input.telegramUserId, chatId: input.chatId, ...updateId, callbackToken: token };
  }
  return { telegramUserId: input.telegramUserId, chatId: input.chatId, ...updateId, messageText: input.messageText };
}

export type CreatorBriefAdvance =
  | { status: "advanced"; step: CreatorStep; data: CreatorDraftData }
  | { status: "invalid_duration" }
  | { status: "not_applicable" };

/** Pure shared progression for the brief fields used by both creator intake paths. */
export function advanceCreatorBrief(
  step: CreatorStep,
  data: CreatorDraftData,
  text: string,
): CreatorBriefAdvance {
  const next = { ...data };
  switch (step) {
    case "NEW_TITLE":
      if (!text) return { status: "not_applicable" };
      next.title = text;
      return { status: "advanced", step: "NEW_DURATION", data: next };
    case "NEW_DURATION":
      if (!validBriefDuration(text)) return { status: "invalid_duration" };
      next.duration = text;
      return { status: "advanced", step: "NEW_PREMISE", data: next };
    case "NEW_PREMISE":
      if (!text) return { status: "not_applicable" };
      next.premise = text;
      return { status: "advanced", step: "NEW_LEARNING_GOAL", data: next };
    case "NEW_LEARNING_GOAL":
      if (!text) return { status: "not_applicable" };
      next.learningGoal = text;
      return { status: "advanced", step: "NEW_TONE", data: next };
    case "NEW_TONE":
      if (!text) return { status: "not_applicable" };
      next.tone = text;
      return { status: "advanced", step: "NEW_CANON_CODES", data: next };
    case "NEW_CANON_CODES":
      next.canonCodes = text
        ? text.split(",").map((code) => code.trim()).filter(Boolean)
        : [];
      return { status: "advanced", step: "NEW_SHOT_DIRECTIONS", data: next };
    default:
      return { status: "not_applicable" };
  }
}

function validBriefDuration(value: string): boolean {
  if (!/^\d+$/.test(value)) return false;
  const seconds = Number(value);
  return Number.isSafeInteger(seconds) && seconds >= 4 && seconds <= 3600 && seconds % 4 === 0;
}

function assertDecimalId(value: unknown, field: string, maxLength = Number.POSITIVE_INFINITY): asserts value is string {
  if (typeof value !== "string" || value.length > maxLength || !DECIMAL_ID.test(value)) {
    throw new BadRequestException(`${field} must be a decimal string${Number.isFinite(maxLength) ? ` no longer than ${maxLength} digits` : ""}`);
  }
}
