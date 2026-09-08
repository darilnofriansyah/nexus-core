import { Injectable, Optional } from "@nestjs/common";
import { randomBytes, randomUUID } from "node:crypto";
import { CanonPinService } from "../canon/canon-pin.service";
import { CanonRepository } from "../canon/canon.repository";
import { GenerationService } from "../generation/generation.service";
import { GenerationPreflightService } from "../generation/generation-preflight.service";
import { generationCanonReadinessError } from "../generation/generation-canon-readiness";
import { EpisodeService } from "../production/episode.service";
import { GenerationReviewService } from "../review/generation-review.service";
import type { Prisma } from "../../generated/prisma/client";
import { CreatorRepository } from "./creator.repository";
import type { CreatorDraftData, CreatorStep, CreatorTelegramReply, CreatorTelegramRequest } from "./dto/creator.dto";

const ALLOWLISTED_USER = "976684739";
const ACTION_TTL_MS = 15 * 60 * 1000;
const BUTTON_RESULT_TEXT = "This action was already accepted. Check /mywork for its status.";
const ACTION_ALREADY_HANDLED_TEXT = "That action was already handled. Check /mywork for its status.";

@Injectable()
export class CreatorService {
  constructor(
    private readonly repository: CreatorRepository,
    @Optional() private readonly episodes?: EpisodeService,
    @Optional() private readonly canonRepository?: CanonRepository,
    @Optional() private readonly canonPins?: CanonPinService,
    @Optional() private readonly generations?: GenerationService,
    @Optional() private readonly reviews?: GenerationReviewService,
    @Optional() private readonly preflight?: GenerationPreflightService,
  ) {}

  async handleTelegram(request: CreatorTelegramRequest): Promise<CreatorTelegramReply> {
    if (request.telegramUserId !== ALLOWLISTED_USER || request.chatId !== ALLOWLISTED_USER) {
      return { text: "This private creator is not available for this Telegram account." };
    }
    if (request.callbackToken !== undefined) return this.handleCallback(request.telegramUserId, request.callbackToken);
    return this.handleMessage(request.telegramUserId, request.messageText ?? "");
  }

  private async handleCallback(telegramUserId: string, token: string): Promise<CreatorTelegramReply> {
    if (token === "new") return this.beginNew(telegramUserId);
    if (token === "mywork") return this.myWork(telegramUserId);
    if (["canon", "audio"].includes(token)) {
      return { text: "That guided step is coming next. Send /new to draft an episode." };
    }
    const pending = await this.repository.findPendingButtonAction(token, telegramUserId);
    if (pending.status === "duplicate") return safeReply(pending.result) ?? { text: "That button was already used." };
    if (pending.status !== "pending") return { text: "That button is expired or no longer available. Send /start to continue." };
    const confirmation = pending.action.kind === "CONFIRM_DRAFT" ? readConfirmation(pending.action.payload) : null;
    if (pending.action.kind === "CONFIRM_DRAFT" && !confirmation) return { text: "This draft needs a whole 4-second target duration and one manual direction for every 4 seconds. Send /new to update it." };
    const canonVersions = confirmation ? await this.findLockedCanon(confirmation.draft) : null;
    if (confirmation && !canonVersions) return { text: "A locked canon version is needed before this draft can be confirmed." };
    const reviewAction = isReviewActionKind(pending.action.kind) ? readReviewAction(pending.action.payload) : null;
    const actionGroupScope = pending.action.kind === "GENERATE_SHOT" ? "generation" : reviewAction ? "review" : null;
    if (isReviewActionKind(pending.action.kind) && (!reviewAction || !(await this.isCurrentReviewAction(telegramUserId, reviewAction)))) {
      return { text: "That review is no longer current. Check /mywork for its status." };
    }
    if (pending.action.kind === "GENERATE_SHOT" && !readActionGroup(pending.action.payload)) {
      return { text: "That generation is no longer current. Check /mywork for its status." };
    }
    if (pending.action.kind === "GENERATE_SHOT" || pending.action.kind === "REGENERATE_SHOT") {
      const action = readShotAction(pending.action.payload);
      if (!action || !(await this.isCanonReady(action.shotId))) return canonNotReadyReply();
    }
    if (pending.action.kind === "GENERATE_SHOT") {
      const action = readShotAction(pending.action.payload);
      if (!action || !this.preflight) return { text: "Shot is not ready to generate. Check its locked canon image references, then try again." };
      try {
        await this.preflight.preflight(action.shotId, "DRAFT");
      } catch {
        return { text: "Shot is not ready to generate. Check its locked character, environment, and style image references, then try again." };
      }
    }

    const requestId = randomUUID();
    const reviewRequestId = randomUUID();
    const result = actionGroupScope
      ? await this.repository.claimActionGroup({
        token,
        telegramUserId,
        result: { text: BUTTON_RESULT_TEXT, requestId, reviewRequestId },
        siblingResult: { text: ACTION_ALREADY_HANDLED_TEXT },
        scope: actionGroupScope,
      })
      : await this.repository.consumeButtonAction({
        token,
        telegramUserId,
        result: { text: BUTTON_RESULT_TEXT, requestId, reviewRequestId },
      });
    if (result.status === "duplicate") return safeReply(result.result) ?? { text: "That button was already used." };
    if (result.status !== "consumed") return { text: "That button is expired or no longer available. Send /start to continue." };
    try {
      if (result.action.kind === "CONFIRM_DRAFT") return this.confirmDraft(telegramUserId, confirmation, canonVersions ?? []);
      if (result.action.kind === "GENERATE_SHOT" || result.action.kind === "REGENERATE_SHOT") {
        return await this.submitGeneration(result.action.kind, result.action.payload, requestId, reviewRequestId);
      }
      if (result.action.kind === "APPROVE_GENERATION") return await this.approveGeneration(result.action.payload, reviewRequestId);
      return { text: "That action is not available yet. Send /start to continue." };
    } catch {
      const reply = postConsumeFailureReply(result.action.kind);
      try {
        await this.repository.updateConsumedButtonResult({ token, telegramUserId, result: { text: reply.text } });
      } catch {
        // The atomic consumed result still prevents a duplicate domain call.
      }
      return reply;
    }
  }

  private async handleMessage(telegramUserId: string, rawText: string): Promise<CreatorTelegramReply> {
    const text = rawText.trim();
    const command = text.toLowerCase().split(/\s+/, 1)[0];
    if (command === "/start") return this.startReply();
    if (command === "/new") return this.beginNew(telegramUserId);
    if (command === "/mywork") return this.myWork(telegramUserId);
    if (["/canon", "/audio"].includes(command)) return { text: "That guided step is coming next. Send /new to draft an episode." };

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
      case "NEW_DURATION": {
        if (!shotCountForDuration(text)) return { text: durationPrompt() };
        next.duration = text;
        nextStep = "NEW_PREMISE";
        break;
      }
      case "NEW_PREMISE": next.premise = text; nextStep = "NEW_LEARNING_GOAL"; break;
      case "NEW_LEARNING_GOAL": next.learningGoal = text; nextStep = "NEW_TONE"; break;
      case "NEW_TONE": next.tone = text; nextStep = "NEW_CANON_CODES"; break;
      case "NEW_CANON_CODES": next.canonCodes = text ? text.split(",").map((code) => code.trim()).filter(Boolean) : []; nextStep = "NEW_SHOT_DIRECTIONS"; break;
      case "NEW_SHOT_DIRECTIONS": {
        const directions = (next.shotDirections ?? []).map((direction) => direction.trim()).filter(Boolean);
        const required = shotCountForDuration(next.duration);
        if (!required) return { text: durationPrompt() };
        if (text.toLowerCase() === "done") {
          if (directions.length !== required) return { text: directionCountPrompt(required, directions.length) };
          nextStep = "DRAFT_READY";
          break;
        }
        if (directions.length >= required) return { text: directionCountPrompt(required, directions.length) };
        directions.push(text);
        next.shotDirections = directions;
        await this.repository.upsertSession({ telegramUserId, step, data: next });
        return { text: `Shot direction ${directions.length} saved. Send another direction or done.` };
      }
      default: return { text: "Send /new to draft an episode." };
    }

    await this.repository.upsertSession({ telegramUserId, step: nextStep, data: next });
    if (nextStep === "DRAFT_READY") return this.readyReply(telegramUserId, next);
    return { text: promptFor(nextStep) };
  }

  private async readyReply(telegramUserId: string, draft: CreatorDraftData): Promise<CreatorTelegramReply> {
    const required = shotCountForDuration(draft.duration);
    const directions = draft.shotDirections?.filter((direction) => direction.trim()) ?? [];
    if (!required || directions.length !== required) return { text: required ? directionCountPrompt(required, directions.length) : durationPrompt() };
    const action = await this.repository.createAction({
      token: randomBytes(18).toString("base64url"),
      telegramUserId,
      kind: "CONFIRM_DRAFT",
      payload: { draft: { ...draft } } as Prisma.JsonObject,
      expiresAt: new Date(Date.now() + ACTION_TTL_MS),
    });
    return { text: "Draft ready. Confirm it to create the episode plan. This does not spend credits.", inlineKeyboard: [[{ text: "Confirm draft", callbackData: `rv:${action.token}` }]] };
  }

  private async confirmDraft(
    telegramUserId: string,
    confirmation: ConfirmationAction | null,
    canonVersions: Array<{ entityId: string; versionId: string }>,
  ): Promise<CreatorTelegramReply> {
    if (!confirmation) return { text: "Draft ready. Confirmation processing comes next." };
    const { draft } = confirmation;
    if (!this.episodes || !this.canonRepository || !this.canonPins) throw new Error("Creator domain services are unavailable");
    let episodeId = confirmation.episodeId;
    let stage = confirmation.stage;
    try {
      if (!episodeId) {
        const episode = await this.episodes.createEpisode({
          code: `RV${randomBytes(15).toString("hex")}`,
          title: draft.title,
          targetDurationSeconds: positiveInteger(draft.duration),
        });
        episodeId = episode.id;
        stage = "CREATED";
        await this.persistConfirmation(telegramUserId, draft, episodeId, stage);
      }
      if (stage === "CREATED") {
        await this.episodes.updateBrief(episodeId, { brief: { premise: draft.premise, learningGoal: draft.learningGoal, tone: draft.tone, canonCodes: draft.canonCodes ?? [] } });
        stage = "BRIEF_UPDATED";
        await this.persistConfirmation(telegramUserId, draft, episodeId, stage);
      }
      if (stage === "BRIEF_UPDATED") {
        await this.episodes.approveBrief(episodeId);
        stage = "BRIEF_APPROVED";
        await this.persistConfirmation(telegramUserId, draft, episodeId, stage);
      }
      if (stage === "BRIEF_APPROVED") {
        await this.episodes.startPreproduction(episodeId);
        stage = "PREPRODUCTION";
        await this.persistConfirmation(telegramUserId, draft, episodeId, stage);
      }
      if (stage === "PREPRODUCTION") {
        await this.episodes.replaceShots(episodeId, { shots: draft.shotDirections.map((direction, index) => ({ sequence: index + 1, direction, targetDurationSeconds: draftShotDuration() })) });
        stage = "SHOTS_REPLACED";
        await this.persistConfirmation(telegramUserId, draft, episodeId, stage);
      }
      if (stage === "SHOTS_REPLACED") {
        for (const canon of canonVersions) {
          await this.canonPins.pinEpisode(episodeId, canon.entityId, { canonVersionId: canon.versionId });
        }
        stage = "CANON_PINNED";
        await this.persistConfirmation(telegramUserId, draft, episodeId, stage);
      }
      if (stage === "CANON_PINNED") {
        await this.episodes.markReadyToGenerate(episodeId);
        stage = "READY";
        await this.persistConfirmation(telegramUserId, draft, episodeId, stage);
      }
      const ready = await this.episodes.getEpisode(episodeId);
      const nextShot = ready.shots.find((shot) => shot.status === "READY_TO_GENERATE");
      if (!nextShot || !this.preflight) return { text: "Generation setup needs valid locked character, environment, and style images before it can continue." };
      await this.preflight.preflight(nextShot.id, "DRAFT");
      await this.repository.upsertSession({ telegramUserId, step: "IDLE", data: { ...draft, episodeId } });
      return this.generateNextShot(telegramUserId, ready.id, ready.shots);
    } catch {
      if (!episodeId) return this.retryConfirmation(telegramUserId, draft);
      await this.persistConfirmation(telegramUserId, draft, episodeId, stage);
      return this.retryConfirmation(telegramUserId, draft, episodeId, stage);
    }
  }

  private async submitGeneration(kind: string, payload: unknown, requestId: string, reviewRequestId: string): Promise<CreatorTelegramReply> {
    const action = readShotAction(payload);
    if (!action || !this.generations) return { text: "That generation action is no longer available. Send /mywork to continue." };
    if (kind === "REGENERATE_SHOT") {
      if (!action.generationId || !this.reviews) return { text: "That regenerate action is no longer available. Send /mywork to continue." };
      await this.reviews.submitHumanReview(action.generationId, { requestId: reviewRequestId, decision: "REGENERATE" });
    }
    await this.generations.submitShot(action.shotId, { requestId, profile: "DRAFT" });
    return { text: `Shot ${action.sequence} generation started. Check /mywork when it is ready for review.` };
  }

  private async approveGeneration(payload: unknown, requestId: string): Promise<CreatorTelegramReply> {
    const action = readGenerationAction(payload);
    if (!action || !this.reviews) return { text: "That review action is no longer available. Send /mywork to continue." };
    await this.reviews.submitHumanReview(action.generationId, { requestId, decision: "APPROVE" });
    return { text: `Shot ${action.sequence} approved. Send /mywork for the next step.` };
  }

  private async findLockedCanon(draft: ConfirmedDraft): Promise<Array<{ entityId: string; versionId: string }> | null> {
    if (!this.canonRepository) throw new Error("Creator domain services are unavailable");
    const canonVersions: Array<{ entityId: string; versionId: string }> = [];
    for (const code of [...new Set((draft.canonCodes ?? []).map((value) => value.trim().toUpperCase()).filter(Boolean))]) {
      const entity = await this.canonRepository.findEntityByCode(code);
      const version = entity?.versions.find((candidate) => candidate.status === "LOCKED");
      if (!entity || !version) return null;
      canonVersions.push({ entityId: entity.id, versionId: version.id });
    }
    return canonVersions;
  }

  private persistConfirmation(telegramUserId: string, draft: ConfirmedDraft, episodeId: string, stage: ConfirmationStage) {
    return this.repository.upsertSession({ telegramUserId, step: "DRAFT_READY", data: { ...draft, episodeId, confirmationStage: stage } });
  }

  private async retryConfirmation(telegramUserId: string, draft: ConfirmedDraft, episodeId?: string, stage: ConfirmationStage = "NEW"): Promise<CreatorTelegramReply> {
    const action = await this.createAction(telegramUserId, "CONFIRM_DRAFT", { draft, stage, ...(episodeId ? { episodeId } : {}) });
    return { text: "Confirmation needs another try. Your draft was kept.", inlineKeyboard: [[{ text: "Retry confirmation", callbackData: `rv:${action.token}` }]] };
  }

  private async myWork(telegramUserId: string): Promise<CreatorTelegramReply> {
    const session = await this.repository.findSession(telegramUserId);
    const confirmation = readPersistedConfirmation(session?.data);
    if (confirmation) {
      return this.retryConfirmation(telegramUserId, confirmation.draft, confirmation.episodeId, confirmation.stage);
    }
    const episodeId = readEpisodeId(session?.data);
    if (!episodeId || !this.episodes || !this.generations) return { text: "No confirmed episode yet. Send /new to draft one." };
    const episode = await this.episodes.getEpisode(episodeId);
    const reviewing = episode.shots.find((shot) => shot.status === "REVIEW_REQUIRED");
    if (reviewing) {
      if (!(await this.isCanonReady(reviewing.id))) return canonNotReadyReply();
      const generation = [...(await this.generations.listShotGenerations(reviewing.id))].reverse().find((attempt) => attempt.status === "COMPLETED");
      if (!generation) return { text: `Shot ${reviewing.sequence} is still being prepared for review.` };
      const actionGroup = `review:${telegramUserId}:${episode.id}:${reviewing.id}:${generation.id}`;
      const reviewPayload = { shotId: reviewing.id, generationId: generation.id, sequence: reviewing.sequence, actionGroup };
      const approve = await this.createAction(telegramUserId, "APPROVE_GENERATION", reviewPayload);
      const regenerate = await this.createAction(telegramUserId, "REGENERATE_SHOT", reviewPayload);
      return { text: `Shot ${reviewing.sequence} is ready for review.`, inlineKeyboard: [[{ text: "Approve shot", callbackData: `rv:${approve.token}` }], [{ text: "Regenerate shot · est. $0.22", callbackData: `rv:${regenerate.token}` }]] };
    }
    const generating = episode.shots.find((shot) => shot.status === "GENERATING");
    if (generating) return { text: `Shot ${generating.sequence} generation is in progress. Check /mywork again soon.` };
    return this.generateNextShot(telegramUserId, episode.id, episode.shots);
  }

  private async generateNextShot(telegramUserId: string, episodeId: string, shots: Array<{ id: string; sequence: number; status: string }>): Promise<CreatorTelegramReply> {
    const shot = shots.find((candidate) => candidate.status === "READY_TO_GENERATE");
    if (!shot) return { text: "All shots are approved. Add audio with /audio to prepare the render." };
    if (!(await this.isCanonReady(shot.id))) return canonNotReadyReply();
    const action = await this.createAction(telegramUserId, "GENERATE_SHOT", {
      shotId: shot.id,
      sequence: shot.sequence,
      actionGroup: `generation:${telegramUserId}:${episodeId}:${shot.id}`,
    });
    return { text: `Shot ${shot.sequence} is ready. Generate shot ${shot.sequence} · est. $0.22`, inlineKeyboard: [[{ text: `Generate shot ${shot.sequence} · est. $0.22`, callbackData: `rv:${action.token}` }]] };
  }

  private createAction(telegramUserId: string, kind: string, payload: Record<string, unknown>) {
    return this.repository.createAction({
      token: randomBytes(18).toString("base64url"),
      telegramUserId,
      kind,
      payload: payload as Prisma.JsonObject,
      expiresAt: new Date(Date.now() + ACTION_TTL_MS),
    });
  }

  private async isCanonReady(shotId: string): Promise<boolean> {
    if (!this.canonPins) return false;
    try {
      return !generationCanonReadinessError(await this.canonPins.getEffectiveShotCanon(shotId));
    } catch {
      return false;
    }
  }

  private async isCurrentReviewAction(telegramUserId: string, action: ReviewAction): Promise<boolean> {
    if (!this.episodes || !this.generations) return false;
    const session = await this.repository.findSession(telegramUserId);
    const episodeId = readEpisodeId(session?.data);
    if (!episodeId) return false;
    const episode = await this.episodes.getEpisode(episodeId);
    const shot = episode.shots.find((candidate) => candidate.id === action.shotId);
    if (!shot || shot.status !== "REVIEW_REQUIRED" || shot.sequence !== action.sequence) return false;
    const currentGeneration = [...(await this.generations.listShotGenerations(shot.id))].reverse().find((candidate) => candidate.status === "COMPLETED");
    return currentGeneration?.id === action.generationId;
  }
}

function safeReply(value: unknown): CreatorTelegramReply | null {
  if (!value || typeof value !== "object" || Array.isArray(value) || !("text" in value) || typeof value.text !== "string") return null;
  return { text: value.text };
}

function canonNotReadyReply(): CreatorTelegramReply {
  return { text: "Canon references are not ready yet. Check locked character, environment, and style images, then try again." };
}

function postConsumeFailureReply(kind: string): CreatorTelegramReply {
  return { text: kind === "APPROVE_GENERATION" ? "This review could not be completed. Check /mywork before trying again." : "This generation action could not be completed. Check /mywork before trying again." };
}

type ConfirmedDraft = Required<Pick<CreatorDraftData, "title" | "duration" | "premise" | "learningGoal" | "tone" | "shotDirections">> & Pick<CreatorDraftData, "canonCodes">;
type ConfirmationStage = "NEW" | "CREATED" | "BRIEF_UPDATED" | "BRIEF_APPROVED" | "PREPRODUCTION" | "SHOTS_REPLACED" | "CANON_PINNED" | "READY";
type ConfirmationAction = { draft: ConfirmedDraft; episodeId?: string; stage: ConfirmationStage };
type ReviewAction = { shotId: string; generationId: string; sequence: number; actionGroup: string };

function readDraft(payload: unknown): ConfirmedDraft | null {
  if (!isRecord(payload) || !isRecord(payload.draft)) return null;
  const draft = payload.draft;
  if (!["title", "duration", "premise", "learningGoal", "tone"].every((key) => typeof draft[key] === "string" && draft[key].trim())) return null;
  if (!Array.isArray(draft.shotDirections) || !draft.shotDirections.every((direction) => typeof direction === "string" && direction.trim())) return null;
  if (shotCountForDuration(draft.duration as string) !== draft.shotDirections.length) return null;
  return {
    title: draft.title as string,
    duration: draft.duration as string,
    premise: draft.premise as string,
    learningGoal: draft.learningGoal as string,
    tone: draft.tone as string,
    canonCodes: Array.isArray(draft.canonCodes) ? draft.canonCodes.filter((code): code is string => typeof code === "string") : [],
    shotDirections: draft.shotDirections as string[],
  };
}

function readConfirmation(payload: unknown): ConfirmationAction | null {
  const draft = readDraft(payload);
  if (!draft || !isRecord(payload)) return null;
  const episodeId = typeof payload.episodeId === "string" ? payload.episodeId : undefined;
  const stage = isConfirmationStage(payload.stage) ? payload.stage : "NEW";
  return { draft, episodeId, stage };
}

function readPersistedConfirmation(value: unknown): ConfirmationAction | null {
  if (!isRecord(value) || !isConfirmationStage(value.confirmationStage)) return null;
  const draft = readDraft({ draft: value });
  const episodeId = readEpisodeId(value);
  return draft && episodeId ? { draft, episodeId, stage: value.confirmationStage } : null;
}

function readShotAction(payload: unknown): { shotId: string; sequence: number; generationId?: string } | null {
  return isRecord(payload) && typeof payload.shotId === "string" && typeof payload.sequence === "number" && Number.isInteger(payload.sequence) && payload.sequence > 0
    ? { shotId: payload.shotId, sequence: payload.sequence as number, generationId: typeof payload.generationId === "string" ? payload.generationId : undefined }
    : null;
}

function readGenerationAction(payload: unknown): { generationId: string; sequence: number } | null {
  return isRecord(payload) && typeof payload.generationId === "string" && typeof payload.sequence === "number" && Number.isInteger(payload.sequence) && payload.sequence > 0
    ? { generationId: payload.generationId, sequence: payload.sequence as number }
    : null;
}

function readReviewAction(payload: unknown): ReviewAction | null {
  return isRecord(payload) && typeof payload.shotId === "string" && typeof payload.generationId === "string" && typeof payload.actionGroup === "string" && payload.actionGroup.length > 0 && typeof payload.sequence === "number" && Number.isInteger(payload.sequence) && payload.sequence > 0
    ? { shotId: payload.shotId, generationId: payload.generationId, sequence: payload.sequence, actionGroup: payload.actionGroup }
    : null;
}

function readActionGroup(payload: unknown): string | null {
  return isRecord(payload) && typeof payload.actionGroup === "string" && payload.actionGroup.length > 0 ? payload.actionGroup : null;
}

function isReviewActionKind(kind: string): boolean {
  return kind === "APPROVE_GENERATION" || kind === "REGENERATE_SHOT";
}

function readEpisodeId(value: unknown): string | null {
  return isRecord(value) && typeof value.episodeId === "string" ? value.episodeId : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function positiveInteger(value: string): number | undefined {
  return /^\d+$/.test(value.trim()) && Number(value) > 0 ? Number(value) : undefined;
}

function shotCountForDuration(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const seconds = positiveInteger(value);
  return seconds && seconds <= 3600 && seconds % 4 === 0 ? seconds / 4 : null;
}

function durationPrompt(): string {
  return "Use a target duration from 4 to 3600 seconds in whole 4-second increments: 4, 8, 12, and so on.";
}

function directionCountPrompt(required: number, actual: number): string {
  return `This target needs ${required} manual shot directions (4 seconds each). You have ${actual}.`;
}

function isConfirmationStage(value: unknown): value is ConfirmationStage {
  return typeof value === "string" && ["NEW", "CREATED", "BRIEF_UPDATED", "BRIEF_APPROVED", "PREPRODUCTION", "SHOTS_REPLACED", "CANON_PINNED", "READY"].includes(value);
}

function draftShotDuration(): number {
  return 4;
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
