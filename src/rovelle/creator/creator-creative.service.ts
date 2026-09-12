import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
} from "@nestjs/common";
import { randomBytes, randomUUID } from "node:crypto";
import {
  Prisma,
  RovelleCreativeJobStatus,
  type RovelleCreatorSession,
} from "../../generated/prisma/client";
import { CreativeRepository } from "../creative/creative.repository";
import { hashCreativeValue } from "../creative/creative-validation";
import type { CreativeInput } from "../creative/dto/creative.dto";
import {
  CreatorRepository,
  type LockedCreatorCanonVersion,
} from "./creator.repository";
import { advanceCreatorBrief } from "./creator-validation";
import type {
  CreatorDraftData,
  CreatorInlineButton,
  CreatorStep,
  CreatorTelegramReply,
  CreatorTelegramRequest,
} from "./dto/creator.dto";

const ACTION_TTL_MS = 15 * 60 * 1000;
const MODE_ACTION_KIND = "CREATIVE_MODE";
const CODEX_MODE_LABEL = "Draft with Codex — uses AI quota";
const MANUAL_MODE_LABEL = "Write shots myself";

type CreativeMode = "CODEX" | "MANUAL";
type CreativeModeAction = { actionGroup: string; mode: CreativeMode };
type CreativeSession = Pick<RovelleCreatorSession, "id" | "telegramUserId" | "step" | "data">;

@Injectable()
export class CreatorCreativeService {
  constructor(
    private readonly creatorRepository: CreatorRepository,
    private readonly creativeRepository: CreativeRepository,
  ) {}

  async handle(request: CreatorTelegramRequest): Promise<CreatorTelegramReply | null> {
    if (process.env.ROVELLE_CREATIVE_ENABLED !== "true") return null;
    if (!request.updateId) {
      if (!(await this.isCreativePath(request))) return null;
      throw new BadRequestException("updateId is required for creative intake");
    }

    const botId = process.env.ROVELLE_TELEGRAM_BOT_ID;
    if (!botId || !/^[A-Za-z0-9_-]{1,32}$/.test(botId)) {
      if (!(await this.isCreativePath(request))) return null;
      throw new InternalServerErrorException("Creative Telegram bot identity is not configured");
    }

    const requestHash = hashCreativeValue({
      telegramUserId: request.telegramUserId,
      chatId: request.chatId,
      ...(request.callbackToken !== undefined
        ? { callbackToken: request.callbackToken }
        : { messageText: request.messageText }),
    });
    const receipt = await this.creatorRepository.findTelegramReceipt({
      botId,
      updateId: request.updateId,
      requestHash,
    });
    if (receipt) return receipt;
    if (!(await this.isCreativePath(request))) return null;

    return this.creatorRepository.withTelegramReceipt({
      botId,
      updateId: request.updateId,
      telegramUserId: request.telegramUserId,
      chatId: request.chatId,
      requestHash,
    }, async (tx) => {
      const session = await this.creatorRepository.lockSession(tx, request.telegramUserId);
      if (request.callbackToken !== undefined) {
        return this.handleCallback(tx, session, request.callbackToken, request.chatId);
      }
      return this.handleMessage(tx, session, request.messageText ?? "", request.chatId);
    });
  }

  private async isCreativePath(request: CreatorTelegramRequest): Promise<boolean> {
    const session = await this.creatorRepository.findSession(request.telegramUserId);
    const data = asRecord(session?.data);
    if (request.callbackToken !== undefined) {
      if (request.callbackToken === "new") return true;
      if (request.callbackToken === "mywork") return typeof data.creativeJobId === "string";
      const action = await this.creatorRepository.findAction(request.callbackToken, request.telegramUserId);
      return action?.kind.startsWith("CREATIVE_") === true;
    }

    const text = (request.messageText ?? "").trim();
    const command = text.toLowerCase().split(/\s+/, 1)[0];
    if (command === "/new") return true;
    if (command === "/mywork") return typeof data.creativeJobId === "string";
    if (["/start", "/canon", "/audio"].includes(command)) return false;
    return session !== null && isCreativeIntakeStep(session.step);
  }

  private async handleCallback(
    tx: Prisma.TransactionClient,
    session: CreativeSession,
    token: string,
    chatId: string,
  ): Promise<CreatorTelegramReply | null> {
    if (token === "new") return this.beginNew(tx, session);
    if (token === "mywork") return this.myWork(tx, session);

    const action = await this.creatorRepository.findActionInTransaction(tx, token);
    if (!action || action.kind !== MODE_ACTION_KIND) return null;
    if (action.telegramUserId !== session.telegramUserId) {
      return { text: "That creative action is not available for this account." };
    }
    const selected = readCreativeModeAction(action.payload);
    if (!selected) return { text: "That creative choice is no longer available. Send /new to continue." };
    const data = asRecord(session.data);
    const currentGroup = data.creativeModeGroup === selected.actionGroup;
    const currentSelection = currentGroup && session.step === "NEW_DRAFT_MODE";
    const saved = storedReply(action.result);
    const currentCodexJob = session.step === "CREATIVE_REVIEW"
      && selected.mode === "CODEX"
      && data.draftMode === "CREATIVE"
      && typeof data.creativeJobId === "string"
      && saved?.creativeJob?.id === data.creativeJobId;
    if (action.consumedAt) {
      if (!currentSelection && !currentCodexJob) {
        return { text: "That creative choice is no longer current. Send /new to continue." };
      }
      return saved ?? { text: "That creative choice was already handled. Check /mywork." };
    }
    if (action.expiresAt <= new Date()) {
      return { text: "That creative choice expired. Send /new to continue." };
    }
    if (!currentSelection) {
      return { text: "That creative choice is no longer current. Send /new to continue." };
    }

    if (selected.mode === "MANUAL") {
      const nextData: Record<string, unknown> = { ...data, draftMode: "MANUAL" };
      delete nextData.creativeModeGroup;
      const reply = { text: promptFor("NEW_SHOT_DIRECTIONS") };
      await this.creatorRepository.saveSession(tx, {
        telegramUserId: session.telegramUserId,
        step: "NEW_SHOT_DIRECTIONS",
        data: nextData as Prisma.JsonObject,
      });
      await this.consumeModeChoice(tx, token, session.telegramUserId, reply);
      return reply;
    }

    const duration = targetDuration(data.duration);
    if (!duration || duration > 120) {
      return {
        text: "Codex drafts support 4 to 120 seconds in whole 4-second increments. Choose “Write shots myself” to keep a longer duration.",
      };
    }

    const brief = readCreativeBrief(data, duration);
    if (!brief) return { text: "The brief is incomplete. Send /new to start again." };

    const canonCodes = selectedCanonCodes(data.canonCodes);
    const canon = await this.creatorRepository.findLockedCanonVersions(tx, canonCodes);
    if (canon.length !== canonCodes.length) {
      return {
        text: "Every selected canon code needs a locked version before Codex can draft. Lock the canon or choose “Write shots myself.”",
      };
    }

    const inputRevision = nextCreativeRevision(data.creativeInputRevision);
    const input: CreativeInput = {
      schemaVersion: 1,
      inputRevision,
      title: brief.title,
      targetDurationSeconds: duration,
      premise: brief.premise,
      learningGoal: brief.learningGoal,
      tone: brief.tone,
      canon,
      previousResult: null,
      feedback: null,
    };
    const job = await this.creativeRepository.createQueued(tx, {
      sessionId: session.id,
      telegramUserId: session.telegramUserId,
      chatId,
      input,
    });
    const nextData: Record<string, unknown> = {
      ...data,
      draftMode: "CREATIVE",
      creativeInputRevision: inputRevision,
      creativeJobId: job.id,
    };
    delete nextData.creativeModeGroup;
    await this.creatorRepository.saveSession(tx, {
      telegramUserId: session.telegramUserId,
      step: "CREATIVE_REVIEW",
      data: nextData as Prisma.JsonObject,
    });
    const reply: CreatorTelegramReply = {
      text: "Creative draft queued. Check /mywork for progress.",
      creativeJob: { id: job.id, action: "DISPATCH" },
    };
    await this.consumeModeChoice(tx, token, session.telegramUserId, reply);
    return reply;
  }

  private async consumeModeChoice(
    tx: Prisma.TransactionClient,
    token: string,
    telegramUserId: string,
    result: CreatorTelegramReply,
  ): Promise<void> {
    const claim = await this.creatorRepository.consumeCreativeModeActions(tx, {
      token,
      telegramUserId,
      result,
      siblingResult: { text: "That creative choice was already handled. Check /mywork." },
    });
    if (claim.status === "consumed") return;
    throw new ConflictException("Creative choice could not be committed");
  }

  private async handleMessage(
    tx: Prisma.TransactionClient,
    session: CreativeSession,
    rawText: string,
    chatId: string,
  ): Promise<CreatorTelegramReply | null> {
    const text = rawText.trim();
    const command = text.toLowerCase().split(/\s+/, 1)[0];
    if (command === "/new") return this.beginNew(tx, session);
    if (command === "/mywork") return this.myWork(tx, session);
    if (session.step === "NEW_DRAFT_MODE") return this.modeMenu(tx, session);
    if (session.step === "CREATIVE_REVIEW") return this.myWork(tx, session);
    if (session.step === "CREATIVE_FEEDBACK") {
      return { text: "Creative revisions are not available yet. Check /mywork for the saved draft." };
    }
    if (!isSharedBriefStep(session.step)) return null;

    const progression = advanceCreatorBrief(session.step as CreatorStep, asDraftData(session.data), text);
    if (progression.status === "invalid_duration") {
      return { text: durationPrompt() };
    }
    if (progression.status === "not_applicable") {
      return { text: promptFor(session.step as CreatorStep) };
    }

    const nextStep: CreatorStep = session.step === "NEW_CANON_CODES"
      ? "NEW_DRAFT_MODE"
      : progression.step;
    const nextData = progression.data as Record<string, unknown>;
    if (nextStep === "NEW_DRAFT_MODE") {
      nextData.draftMode = undefined;
      nextData.creativeModeGroup = randomUUID();
    }
    const saved = await this.creatorRepository.saveSession(tx, {
      telegramUserId: session.telegramUserId,
      step: nextStep,
      data: nextData as Prisma.JsonObject,
    });
    if (nextStep === "NEW_DRAFT_MODE") return this.modeMenu(tx, saved);
    return { text: promptFor(nextStep) };
  }

  private async beginNew(
    tx: Prisma.TransactionClient,
    session: CreativeSession,
  ): Promise<CreatorTelegramReply> {
    const data = asRecord(session.data);
    const jobs = new Map<string, Awaited<ReturnType<CreatorRepository["findCreativeJobInTransaction"]>>>();
    const pointedId = typeof data.creativeJobId === "string" ? data.creativeJobId : null;
    if (pointedId) {
      const pointed = await this.creatorRepository.findCreativeJobInTransaction(tx, {
        id: pointedId,
        telegramUserId: session.telegramUserId,
      });
      if (pointed) jobs.set(pointed.id, pointed);
    }
    const active = await this.creatorRepository.findActiveCreativeJobInTransaction(tx, session.telegramUserId);
    if (active) jobs.set(active.id, active);

    for (const job of jobs.values()) {
      if (!job) continue;
      if (job.status === RovelleCreativeJobStatus.RUNNING || job.status === RovelleCreativeJobStatus.OUTCOME_UNKNOWN) {
        return {
          text: "A creative run is still in progress or has an unknown outcome. Check /mywork before starting a new brief; another run could use AI quota again.",
        };
      }
    }
    for (const job of jobs.values()) {
      if (job) await this.creatorRepository.supersedeCreativeJob(tx, job, new Date());
    }

    const nextData: CreatorDraftData = {
      shotDirections: [],
      creativeInputRevision: storedRevision(data.creativeInputRevision),
    };
    await this.creatorRepository.invalidateCreativeActions(tx, session.telegramUserId, new Date());
    await this.creatorRepository.saveSession(tx, {
      telegramUserId: session.telegramUserId,
      step: "NEW_TITLE",
      data: nextData as Prisma.JsonObject,
    });
    return { text: promptFor("NEW_TITLE") };
  }

  private async modeMenu(
    tx: Prisma.TransactionClient,
    session: CreativeSession,
  ): Promise<CreatorTelegramReply> {
    let data = asRecord(session.data);
    let actionGroup = typeof data.creativeModeGroup === "string" ? data.creativeModeGroup : "";
    if (!actionGroup) {
      actionGroup = randomUUID();
      data = { ...data, creativeModeGroup: actionGroup };
      await this.creatorRepository.saveSession(tx, {
        telegramUserId: session.telegramUserId,
        step: "NEW_DRAFT_MODE",
        data: data as Prisma.JsonObject,
      });
    }
    let actions = await this.creatorRepository.findCreativeModeActionsInTransaction(tx, {
      telegramUserId: session.telegramUserId,
      actionGroup,
    });
    const existingModes = new Set(actions.map((action) => readCreativeModeAction(action.payload)?.mode).filter(Boolean));
    for (const mode of ["CODEX", "MANUAL"] as const) {
      if (existingModes.has(mode)) continue;
      const action = await this.creatorRepository.createActionInTransaction(tx, {
        token: randomBytes(18).toString("base64url"),
        telegramUserId: session.telegramUserId,
        kind: MODE_ACTION_KIND,
        payload: { actionGroup, mode },
        expiresAt: new Date(Date.now() + ACTION_TTL_MS),
      });
      actions.push(action);
    }
    const buttons: CreatorInlineButton[] = actions.flatMap((action) => {
      const mode = readCreativeModeAction(action.payload)?.mode;
      if (!mode) return [];
      return [{
        text: mode === "CODEX" ? CODEX_MODE_LABEL : MANUAL_MODE_LABEL,
        callbackData: `rv:${action.token}`,
      }];
    });
    buttons.sort((left, right) => modeSort(left.text) - modeSort(right.text));
    return {
      text: "Codex drafts support 4 to 120 seconds in whole 4-second increments. Choose how to draft the episode:",
      inlineKeyboard: buttons.map((button) => [button]),
    };
  }

  private async myWork(
    tx: Prisma.TransactionClient,
    session: CreativeSession,
  ): Promise<CreatorTelegramReply | null> {
    const data = asRecord(session.data);
    const jobId = typeof data.creativeJobId === "string" ? data.creativeJobId : null;
    if (!jobId) return null;
    const job = await this.creatorRepository.findCreativeJobInTransaction(tx, {
      id: jobId,
      telegramUserId: session.telegramUserId,
    });
    if (!job) return { text: "The current creative draft could not be found. Send /new to start again." };
    switch (job.status) {
      case RovelleCreativeJobStatus.QUEUED:
        return { text: "Creative draft queued. Check /mywork again shortly." };
      case RovelleCreativeJobStatus.RUNNING:
        return { text: "Creative draft is in progress. Check /mywork again shortly." };
      case RovelleCreativeJobStatus.OUTCOME_UNKNOWN:
        return { text: "The previous draft run may have used AI quota. Check back before starting another run." };
      case RovelleCreativeJobStatus.SUCCEEDED:
        return { text: "Creative draft saved. Preview and approval are the next step." };
      case RovelleCreativeJobStatus.FAILED:
        return { text: "Creative draft failed. It was not retried automatically; send /new when you are ready to try a new brief." };
    }
  }
}

function isCreativeIntakeStep(step: string): boolean {
  return isSharedBriefStep(step) || step === "NEW_DRAFT_MODE" || step === "CREATIVE_REVIEW" || step === "CREATIVE_FEEDBACK";
}

function isSharedBriefStep(step: string): boolean {
  return ["NEW_TITLE", "NEW_DURATION", "NEW_PREMISE", "NEW_LEARNING_GOAL", "NEW_TONE", "NEW_CANON_CODES"].includes(step);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asDraftData(value: unknown): CreatorDraftData {
  return asRecord(value) as CreatorDraftData;
}

function readCreativeModeAction(value: unknown): CreativeModeAction | null {
  const payload = asRecord(value);
  if (typeof payload.actionGroup !== "string" || !payload.actionGroup) return null;
  if (payload.mode !== "CODEX" && payload.mode !== "MANUAL") return null;
  return { actionGroup: payload.actionGroup, mode: payload.mode };
}

function storedReply(value: unknown): CreatorTelegramReply | null {
  if (!value || typeof value !== "object" || Array.isArray(value) || !("text" in value) || typeof value.text !== "string") {
    return null;
  }
  return value as CreatorTelegramReply;
}

function selectedCanonCodes(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((code): code is string => typeof code === "string")
    .map((code) => code.trim().toUpperCase()).filter(Boolean))];
}

function readCreativeBrief(data: Record<string, unknown>, duration: number): Omit<CreativeInput, "schemaVersion" | "inputRevision" | "targetDurationSeconds" | "canon" | "previousResult" | "feedback"> | null {
  const title = nonEmptyText(data.title);
  const premise = nonEmptyText(data.premise);
  const learningGoal = nonEmptyText(data.learningGoal);
  const tone = nonEmptyText(data.tone);
  if (!title || !premise || !learningGoal || !tone || duration <= 0) return null;
  return { title, premise, learningGoal, tone };
}

function nonEmptyText(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  return value.trim();
}

function targetDuration(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d+$/.test(value.trim())) return null;
  const seconds = Number(value.trim());
  return Number.isSafeInteger(seconds) && seconds >= 4 && seconds <= 3600 && seconds % 4 === 0
    ? seconds
    : null;
}

function nextCreativeRevision(value: unknown): number {
  return storedRevision(value) + 1;
}

function storedRevision(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function durationPrompt(): string {
  return "Use a target duration from 4 to 3600 seconds in whole 4-second increments: 4, 8, 12, and so on.";
}

function promptFor(step: CreatorStep): string {
  return {
    NEW_TITLE: "What is the episode title?",
    NEW_DURATION: "What target duration should it have?",
    NEW_PREMISE: "What is the premise?",
    NEW_LEARNING_GOAL: "What should viewers learn?",
    NEW_TONE: "What tone should it use?",
    NEW_CANON_CODES: "Which canon codes should it use? Enter comma separated codes, or leave blank.",
    NEW_DRAFT_MODE: "Choose Draft with Codex or write the shots yourself.",
    NEW_SHOT_DIRECTIONS: "Send one manual shot direction per message. Send done when finished.",
    CREATIVE_REVIEW: "Your creative draft is being prepared. Check /mywork for progress.",
    CREATIVE_FEEDBACK: "Send feedback for the next creative revision.",
    CANON_SETUP: "Send canon details as CODE | CHARACTER, ENVIRONMENT, or STYLE | display name.",
    DRAFT_READY: "Draft ready. Use Confirm draft when you are ready.",
    IDLE: "Send /start to begin.",
  }[step];
}

function modeSort(text: string): number {
  return text === CODEX_MODE_LABEL ? 0 : 1;
}
