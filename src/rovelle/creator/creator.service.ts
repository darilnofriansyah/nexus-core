import { Injectable } from "@nestjs/common";
import { randomBytes } from "node:crypto";
import type { CreatorRepository } from "./creator.repository";
import type { CreatorDraftData, CreatorStep, CreatorTelegramReply, CreatorTelegramRequest } from "./dto/creator.dto";

const ALLOWLISTED_USER = "976684739";
const ACTION_TTL_MS = 15 * 60 * 1000;

@Injectable()
export class CreatorService {
  constructor(private readonly repository: CreatorRepository) {}

  async handleTelegram(request: CreatorTelegramRequest): Promise<CreatorTelegramReply> {
    if (request.telegramUserId !== ALLOWLISTED_USER || request.chatId !== ALLOWLISTED_USER) {
      return { text: "This private creator is not available for this Telegram account." };
    }
    if (request.callbackToken !== undefined) return this.handleCallback(request.telegramUserId, request.callbackToken);
    return this.handleMessage(request.telegramUserId, request.messageText ?? "");
  }

  private async handleCallback(telegramUserId: string, token: string): Promise<CreatorTelegramReply> {
    if (token === "new") return this.beginNew(telegramUserId);
    if (["canon", "mywork", "audio"].includes(token)) {
      return { text: "That guided step is coming next. Send /new to draft an episode." };
    }
    const safeResult = { text: "Draft ready. Confirmation processing comes next." };
    const result = await this.repository.consumeButtonAction({ token, telegramUserId, result: safeResult });
    if (result.status === "consumed") {
      return result.action.kind === "CONFIRM_DRAFT"
        ? safeResult
        : { text: "That action is not available yet. Send /start to continue." };
    }
    if (result.status === "duplicate") return safeReply(result.result) ?? { text: "That button was already used." };
    return { text: "That button is expired or no longer available. Send /start to continue." };
  }

  private async handleMessage(telegramUserId: string, rawText: string): Promise<CreatorTelegramReply> {
    const text = rawText.trim();
    const command = text.toLowerCase().split(/\s+/, 1)[0];
    if (command === "/start") return this.startReply();
    if (command === "/new") return this.beginNew(telegramUserId);
    if (["/canon", "/mywork", "/audio"].includes(command)) return { text: "That guided step is coming next. Send /new to draft an episode." };

    const session = await this.repository.findSession(telegramUserId);
    if (!session) return { text: "Send /start to begin." };
    return this.advanceDraft(telegramUserId, session.step as CreatorStep, (session.data ?? {}) as CreatorDraftData, text);
  }

  private startReply(): CreatorTelegramReply {
    return {
      text: "Rovelle creator ready. Choose an action:",
      inlineKeyboard: [[{ text: "New episode", callbackData: "rv:new" }], [{ text: "Canon", callbackData: "rv:canon" }], [{ text: "My work", callbackData: "rv:mywork" }]],
    };
  }

  private async beginNew(telegramUserId: string): Promise<CreatorTelegramReply> {
    await this.repository.upsertSession({ telegramUserId, step: "NEW_TITLE", data: { shotDirections: [] } });
    return { text: "What is the episode title?" };
  }

  private async advanceDraft(telegramUserId: string, step: CreatorStep, data: CreatorDraftData, text: string): Promise<CreatorTelegramReply> {
    if (step === "DRAFT_READY") return { text: "Draft ready. Use Confirm draft when you are ready." };
    if (step === "IDLE") return { text: "Send /new to draft an episode." };
    if (!text) return { text: promptFor(step) };

    const next = { ...data };
    let nextStep: CreatorStep;
    switch (step) {
      case "NEW_TITLE": next.title = text; nextStep = "NEW_DURATION"; break;
      case "NEW_DURATION": next.duration = text; nextStep = "NEW_PREMISE"; break;
      case "NEW_PREMISE": next.premise = text; nextStep = "NEW_LEARNING_GOAL"; break;
      case "NEW_LEARNING_GOAL": next.learningGoal = text; nextStep = "NEW_TONE"; break;
      case "NEW_TONE": next.tone = text; nextStep = "NEW_CANON_CODES"; break;
      case "NEW_CANON_CODES": next.canonCodes = text ? text.split(",").map((code) => code.trim()).filter(Boolean) : []; nextStep = "NEW_SHOT_DIRECTIONS"; break;
      case "NEW_SHOT_DIRECTIONS": {
        const directions = (next.shotDirections ?? []).map((direction) => direction.trim()).filter(Boolean);
        if (text.toLowerCase() === "done") {
          if (directions.length === 0) return { text: "Add at least one shot direction, then send done." };
          nextStep = "DRAFT_READY";
          break;
        }
        directions.push(text);
        next.shotDirections = directions;
        await this.repository.upsertSession({ telegramUserId, step, data: next });
        return { text: `Shot direction ${directions.length} saved. Send another direction or done.` };
      }
      default: return { text: "Send /new to draft an episode." };
    }

    await this.repository.upsertSession({ telegramUserId, step: nextStep, data: next });
    if (nextStep === "DRAFT_READY") return this.readyReply(telegramUserId);
    return { text: promptFor(nextStep) };
  }

  private async readyReply(telegramUserId: string): Promise<CreatorTelegramReply> {
    const action = await this.repository.createAction({
      token: randomBytes(18).toString("base64url"),
      telegramUserId,
      kind: "CONFIRM_DRAFT",
      payload: { purpose: "confirm draft" },
      expiresAt: new Date(Date.now() + ACTION_TTL_MS),
    });
    return { text: "Draft ready. Confirm it to create the episode plan. This does not spend credits.", inlineKeyboard: [[{ text: "Confirm draft", callbackData: `rv:${action.token}` }]] };
  }
}

function safeReply(value: unknown): CreatorTelegramReply | null {
  if (!value || typeof value !== "object" || Array.isArray(value) || !("text" in value) || typeof value.text !== "string") return null;
  return { text: value.text };
}

function promptFor(step: CreatorStep): string {
  return {
    NEW_TITLE: "What is the episode title?",
    NEW_DURATION: "What target duration should it have?",
    NEW_PREMISE: "What is the premise?",
    NEW_LEARNING_GOAL: "What should viewers learn?",
    NEW_TONE: "What tone should it use?",
    NEW_CANON_CODES: "Which canon codes should it use? Enter comma separated codes, or leave blank.",
    NEW_SHOT_DIRECTIONS: "Send one manual shot direction per message. Send done when finished.",
    DRAFT_READY: "Draft ready. Use Confirm draft when you are ready.",
    IDLE: "Send /new to draft an episode.",
  }[step];
}
