import { BadRequestException } from "@nestjs/common";
import type { CreatorTelegramRequest, CreatorTelegramRequestDto } from "./dto/creator.dto";

const DECIMAL_ID = /^[0-9]+$/;

export function normalizeCreatorTelegramRequest(input: CreatorTelegramRequestDto): CreatorTelegramRequest {
  if (!input || typeof input !== "object") throw new BadRequestException("request must be an object");
  assertDecimalId(input.telegramUserId, "telegramUserId");
  assertDecimalId(input.chatId, "chatId");
  const hasMessage = typeof input.messageText === "string";
  const hasCallback = typeof input.callbackToken === "string";
  if (hasMessage === hasCallback) throw new BadRequestException("exactly one of messageText or callbackToken is required");
  if (hasCallback) {
    const token = input.callbackToken!.slice(3);
    if (!input.callbackToken!.startsWith("rv:") || !token.trim() || /[\r\n]/.test(token)) {
      throw new BadRequestException("callbackToken must start with rv: and contain a token");
    }
    return { telegramUserId: input.telegramUserId, chatId: input.chatId, callbackToken: token };
  }
  return { telegramUserId: input.telegramUserId, chatId: input.chatId, messageText: input.messageText };
}

function assertDecimalId(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !DECIMAL_ID.test(value)) throw new BadRequestException(`${field} must be a decimal string`);
}
