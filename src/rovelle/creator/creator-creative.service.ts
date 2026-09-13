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
  type RovelleCreatorAction,
  type RovelleCreativeJob,
  type RovelleCreatorSession,
} from "../../generated/prisma/client";
import { CreativeRepository } from "../creative/creative.repository";
import { renderCreativePages } from "../creative/creative-preview";
import { hashCreativeValue, normalizeCreativeInput, normalizeCreativeResult } from "../creative/creative-validation";
import type { CreativeInput } from "../creative/dto/creative.dto";
import {
  CreatorRepository,
  type LockedCreatorCanonVersion,
} from "./creator.repository";
import { CreativeApprovalService } from "../creative/creative-approval.service";
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
const CREATIVE_ACTION_KINDS = ["CREATIVE_PAGE", "CREATIVE_REVISE", "CREATIVE_APPROVE", "CREATIVE_RETRY"] as const;

type CreativeMode = "CODEX" | "MANUAL";
type CreativeModeAction = { actionGroup: string; mode: CreativeMode };
type CreativeSession = Pick<RovelleCreatorSession, "id" | "telegramUserId" | "step" | "data">;

@Injectable()
export class CreatorCreativeService {
  constructor(
    private readonly creatorRepository: CreatorRepository,
    private readonly creativeRepository: CreativeRepository,
    private readonly creativeApprovalService: CreativeApprovalService,
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
    if (!action) return null;
    if (action.telegramUserId !== session.telegramUserId) {
      return { text: "That creative action is not available for this account." };
    }
    if (action.kind !== MODE_ACTION_KIND) {
      return CREATIVE_ACTION_KINDS.includes(action.kind as (typeof CREATIVE_ACTION_KINDS)[number])
        ? this.handleCreativeAction(tx, session, action)
        : null;
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

  private async handleCreativeAction(tx: Prisma.TransactionClient, session: CreativeSession, action: RovelleCreatorAction): Promise<CreatorTelegramReply> {
    const stale = {
      text: "That creative action is no longer current. Check /mywork.",
    };
    const payload = readCreativeReviewPayload(action.payload);
    const data = asRecord(session.data);
    if (
      !payload ||
      action.telegramUserId !== session.telegramUserId ||
      data.creativeJobId !== payload.jobId ||
      storedRevision(data.creativeInputRevision) !== payload.inputRevision
    ) {
      return stale;
    }

    const job = await this.creatorRepository.findCreativeJobInTransaction(tx, {
      id: payload.jobId,
      telegramUserId: session.telegramUserId,
    });
    if (!job || job.supersededAt || job.inputRevision !== payload.inputRevision) return stale;
    const input = normalizeCreativeInput(job.input);
    if (input.inputRevision !== payload.inputRevision || job.inputHash !== payload.inputHash || hashCreativeValue(input) !== payload.inputHash) {
      return stale;
    }
    if (action.consumedAt) return storedReply(action.result) ?? stale;
    if (action.expiresAt <= new Date())
      return {
        text: "That creative action expired. Check /mywork for fresh buttons.",
      };

    if (action.kind === "CREATIVE_RETRY") {
      if (payload.page !== 1 || (job.status !== RovelleCreativeJobStatus.FAILED && job.status !== RovelleCreativeJobStatus.OUTCOME_UNKNOWN)) return stale;
      return this.retryCreativeJob(tx, session, job, input, action.token);
    }
    if (job.status !== RovelleCreativeJobStatus.SUCCEEDED || !job.result) return stale;

    const result = normalizeCreativeResult(job.result, input);
    const pages = renderCreativePages(input, result);
    if (payload.page > pages.length) return stale;
    const progress = readCreativeReviewProgress(data.creativeReviewProgress, job, pages.length);

    if (action.kind === "CREATIVE_PAGE") {
      const maxViewed = Math.max(...progress.viewedPages);
      if (payload.page > maxViewed + 1) return { text: "Open the preview pages in order before continuing." };
      const nextProgress = progressForPage(progress, job, payload.page);
      const reply = await this.pageReply(tx, session, job, pages, payload.page, nextProgress);
      await this.consumeCreativeReply(tx, action, reply);
      await this.saveReviewProgress(tx, session, nextProgress);
      return reply;
    }

    if (action.kind === "CREATIVE_REVISE") {
      if (!progress.viewedPages.includes(payload.page)) return stale;
      const reply = { text: "Send feedback for the next creative revision." };
      await this.consumeCreativeReply(tx, action, reply);
      const nextData = {
        ...data,
        creativeFeedbackFor: {
          jobId: job.id,
          inputRevision: job.inputRevision,
          inputHash: job.inputHash,
        },
      };
      await this.creatorRepository.saveSession(tx, {
        telegramUserId: session.telegramUserId,
        step: "CREATIVE_FEEDBACK",
        data: nextData as Prisma.JsonObject,
      });
      return reply;
    }

    if (action.kind === "CREATIVE_APPROVE") {
      if (payload.page !== pages.length || !allPagesViewed(progress.viewedPages, pages.length)) {
        return { text: "View every preview page before approving the plan." };
      }
      return this.creativeApprovalService.approve(tx, {
        telegramUserId: session.telegramUserId,
        token: action.token,
      });
    }

    return stale;
  }

  private async submitFeedback(tx: Prisma.TransactionClient, session: CreativeSession, feedback: string, _chatId: string): Promise<CreatorTelegramReply> {
    const data = asRecord(session.data);
    const binding = readCreativeFeedbackBinding(data.creativeFeedbackFor);
    const jobId = typeof data.creativeJobId === "string" ? data.creativeJobId : "";
    if (!feedback) return { text: "Send feedback for the next creative revision." };
    if (!binding || binding.jobId !== jobId || storedRevision(data.creativeInputRevision) !== binding.inputRevision) {
      return { text: "That revision is no longer current. Check /mywork." };
    }

    const job = await this.creatorRepository.findCreativeJobInTransaction(tx, {
      id: binding.jobId,
      telegramUserId: session.telegramUserId,
    });
    if (!job || job.supersededAt || job.status !== RovelleCreativeJobStatus.SUCCEEDED || job.inputHash !== binding.inputHash) {
      return { text: "That revision is no longer current. Check /mywork." };
    }
    const previousInput = normalizeCreativeInput(job.input);
    const previousResult = normalizeCreativeResult(job.result, previousInput);
    const input = normalizeCreativeInput({
      ...previousInput,
      inputRevision: nextCreativeRevision(job.inputRevision),
      previousResult,
      feedback,
    });
    const nextJob = await this.creativeRepository.createQueued(tx, {
      sessionId: session.id,
      telegramUserId: session.telegramUserId,
      chatId: job.chatId,
      input,
    });
    await this.creatorRepository.supersedeCreativeJob(tx, job, new Date());
    await this.creatorRepository.invalidateCreativeActions(tx, session.telegramUserId, new Date());

    const nextData: Record<string, unknown> = {
      ...data,
      draftMode: "CREATIVE",
      creativeInputRevision: input.inputRevision,
      creativeJobId: nextJob.id,
    };
    delete nextData.creativeFeedbackFor;
    delete nextData.creativeReviewProgress;
    await this.creatorRepository.saveSession(tx, {
      telegramUserId: session.telegramUserId,
      step: "CREATIVE_REVIEW",
      data: nextData as Prisma.JsonObject,
    });
    return {
      text: "Creative revision queued. Check /mywork for progress.",
      creativeJob: { id: nextJob.id, action: "DISPATCH" },
    };
  }

  private async retryCreativeJob(
    tx: Prisma.TransactionClient,
    session: CreativeSession,
    job: RovelleCreativeJob,
    input: CreativeInput,
    token: string,
  ): Promise<CreatorTelegramReply> {
    const retryInput = normalizeCreativeInput({
      ...input,
      inputRevision: nextCreativeRevision(job.inputRevision),
    });
    const now = new Date();
    if (job.status === RovelleCreativeJobStatus.OUTCOME_UNKNOWN) {
      const resolved = await tx.rovelleCreativeJob.updateMany({
        where: {
          id: job.id,
          status: RovelleCreativeJobStatus.OUTCOME_UNKNOWN,
          supersededAt: null,
        },
        data: {
          status: RovelleCreativeJobStatus.FAILED,
          failureCode: "RETRY_AUTHORIZED_OUTCOME_UNKNOWN",
          leaseExpiresAt: null,
          supersededAt: now,
        },
      });
      if (resolved.count !== 1) throw new ConflictException("Unknown creative outcome changed before retry");
    } else {
      await this.creatorRepository.supersedeCreativeJob(tx, job, now);
    }
    const nextJob = await this.creativeRepository.createQueued(tx, {
      sessionId: session.id,
      telegramUserId: session.telegramUserId,
      chatId: job.chatId,
      input: retryInput,
    });

    const nextData: Record<string, unknown> = {
      ...asRecord(session.data),
      draftMode: "CREATIVE",
      creativeInputRevision: retryInput.inputRevision,
      creativeJobId: nextJob.id,
    };
    delete nextData.creativeFeedbackFor;
    delete nextData.creativeReviewProgress;
    await this.creatorRepository.saveSession(tx, {
      telegramUserId: session.telegramUserId,
      step: "CREATIVE_REVIEW",
      data: nextData as Prisma.JsonObject,
    });

    const reply: CreatorTelegramReply = {
      text: "Creative retry queued. It may use AI quota again. Check /mywork for progress.",
      creativeJob: { id: nextJob.id, action: "DISPATCH" },
    };
    await this.consumeCreativeReply(tx, await this.creatorRepository.findActionInTransaction(tx, token), reply);
    await this.creatorRepository.invalidateCreativeActions(tx, session.telegramUserId, now);
    return reply;
  }

  private async pageReply(
    tx: Prisma.TransactionClient,
    session: CreativeSession,
    job: RovelleCreativeJob,
    pages: string[],
    page: number,
    progress: CreativeReviewProgress,
  ): Promise<CreatorTelegramReply> {
    const specs: Array<{
      kind: CreativeReviewActionKind;
      page: number;
      text: string;
    }> = [];
    if (page > 1) specs.push({ kind: "CREATIVE_PAGE", page: page - 1, text: "Previous" });
    if (page < pages.length) specs.push({ kind: "CREATIVE_PAGE", page: page + 1, text: "Next" });
    specs.push({ kind: "CREATIVE_REVISE", page, text: "Revise" });
    if (page === pages.length && allPagesViewed(progress.viewedPages, pages.length)) {
      specs.push({ kind: "CREATIVE_APPROVE", page, text: "Approve plan" });
    }
    const buttons = await this.creativeActionButtons(tx, session, job, specs);
    return {
      text: pages[page - 1]!,
      inlineKeyboard: buttons.map((button) => [button]),
    };
  }

  private async retryReply(tx: Prisma.TransactionClient, session: CreativeSession, job: RovelleCreativeJob): Promise<CreatorTelegramReply> {
    const copy =
      job.status === RovelleCreativeJobStatus.OUTCOME_UNKNOWN
        ? "The previous run may have used AI quota. Retry may use quota again."
        : "The previous creative run failed. It will not retry automatically.";
    const buttons = await this.creativeActionButtons(tx, session, job, [{ kind: "CREATIVE_RETRY", page: 1, text: "Retry" }]);
    return { text: copy, inlineKeyboard: buttons.map((button) => [button]) };
  }

  private async creativeActionButtons(
    tx: Prisma.TransactionClient,
    session: CreativeSession,
    job: RovelleCreativeJob,
    specs: Array<{
      kind: CreativeReviewActionKind;
      page: number;
      text: string;
    }>,
  ): Promise<CreatorInlineButton[]> {
    const now = new Date();
    const active = await tx.rovelleCreatorAction.findMany({
      where: {
        telegramUserId: session.telegramUserId,
        kind: { in: [...new Set(specs.map((spec) => spec.kind))] },
        consumedAt: null,
        expiresAt: { gt: now },
      },
    });
    const input = normalizeCreativeInput(job.input);
    const buttons: CreatorInlineButton[] = [];
    for (const spec of specs) {
      const existing = active.find((candidate) => {
        if (candidate.kind !== spec.kind) return false;
        const payload = readCreativeReviewPayload(candidate.payload);
        return payload?.jobId === job.id && payload.inputRevision === job.inputRevision && payload.inputHash === job.inputHash && payload.page === spec.page;
      });
      const action =
        existing ??
        (await this.creatorRepository.createActionInTransaction(tx, {
          token: randomBytes(18).toString("base64url"),
          telegramUserId: session.telegramUserId,
          kind: spec.kind,
          payload: creativeReviewPayload(job.id, input.inputRevision, job.inputHash, spec.page) as unknown as Prisma.JsonObject,
          expiresAt: new Date(now.getTime() + ACTION_TTL_MS),
        }));
      if (!existing) active.push(action);
      buttons.push({ text: spec.text, callbackData: `rv:${action.token}` });
    }
    return buttons;
  }

  private async consumeCreativeReply(tx: Prisma.TransactionClient, action: RovelleCreatorAction | null, reply: CreatorTelegramReply): Promise<void> {
    if (!action || !CREATIVE_ACTION_KINDS.includes(action.kind as (typeof CREATIVE_ACTION_KINDS)[number])) {
      throw new ConflictException("Creative action could not be committed");
    }
    const result = await this.creatorRepository.consumeCreativeActionInTransaction(tx, {
      token: action.token,
      telegramUserId: action.telegramUserId,
      kind: action.kind as CreativeReviewActionKind,
      result: reply as unknown as Prisma.JsonObject,
    });
    if (result.status !== "consumed") throw new ConflictException("Creative action could not be committed");
  }

  private async saveReviewProgress(tx: Prisma.TransactionClient, session: CreativeSession, progress: CreativeReviewProgress): Promise<void> {
    const data = {
      ...asRecord(session.data),
      creativeReviewProgress: progress,
    };
    await this.creatorRepository.saveSession(tx, {
      telegramUserId: session.telegramUserId,
      step: "CREATIVE_REVIEW",
      data: data as unknown as Prisma.JsonObject,
    });
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
      return this.submitFeedback(tx, session, text, chatId);
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

  private async myWork(tx: Prisma.TransactionClient, session: CreativeSession): Promise<CreatorTelegramReply | null> {
    const data = asRecord(session.data);
    const jobId = typeof data.creativeJobId === "string" ? data.creativeJobId : null;
    if (!jobId) return null;
    const job = await this.creatorRepository.findCreativeJobInTransaction(tx, {
      id: jobId,
      telegramUserId: session.telegramUserId,
    });
    if (!job)
      return {
        text: "The current creative draft could not be found. Send /new to start again.",
      };
    switch (job.status) {
      case RovelleCreativeJobStatus.QUEUED:
        return { text: "Creative draft queued. Check /mywork again shortly." };
      case RovelleCreativeJobStatus.RUNNING:
        return {
          text: "Creative draft is in progress. Check /mywork again shortly.",
        };
      case RovelleCreativeJobStatus.OUTCOME_UNKNOWN:
        return this.retryReply(tx, session, job);
      case RovelleCreativeJobStatus.SUCCEEDED:
        if (!job.result)
          return {
            text: "The creative result could not be found. Check /mywork again shortly.",
          };
        {
          const input = normalizeCreativeInput(job.input);
          const result = normalizeCreativeResult(job.result, input);
          const pages = renderCreativePages(input, result);
          const progress = readCreativeReviewProgress(asRecord(session.data).creativeReviewProgress, job, pages.length);
          const page = progress.currentPage;
          const nextProgress = progressForPage(progress, job, page);
          const reply = await this.pageReply(tx, session, job, pages, page, nextProgress);
          await this.saveReviewProgress(tx, session, nextProgress);
          return reply;
        }
      case RovelleCreativeJobStatus.FAILED:
        return this.retryReply(tx, session, job);
    }
  }
}

type CreativeReviewActionKind = (typeof CREATIVE_ACTION_KINDS)[number];

interface CreativeReviewPayload {
  jobId: string;
  inputRevision: number;
  inputHash: string;
  page: number;
}

interface CreativeReviewProgress {
  jobId: string;
  inputRevision: number;
  inputHash: string;
  currentPage: number;
  viewedPages: number[];
}

interface CreativeFeedbackBinding extends Omit<CreativeReviewPayload, "page"> {}

function creativeReviewPayload(jobId: string, inputRevision: number, inputHash: string, page: number): CreativeReviewPayload {
  return { jobId, inputRevision, inputHash, page };
}

function readCreativeReviewPayload(value: unknown): CreativeReviewPayload | null {
  const payload = asRecord(value);
  const keys = Reflect.ownKeys(payload);
  if (keys.length !== 4 || keys.some((key) => !["jobId", "inputRevision", "inputHash", "page"].includes(String(key)))) return null;
  if (
    typeof payload.jobId !== "string" ||
    !payload.jobId ||
    typeof payload.inputRevision !== "number" ||
    !Number.isSafeInteger(payload.inputRevision) ||
    payload.inputRevision < 1 ||
    typeof payload.inputHash !== "string" ||
    !/^[0-9a-f]{64}$/.test(payload.inputHash) ||
    typeof payload.page !== "number" ||
    !Number.isSafeInteger(payload.page) ||
    payload.page < 1
  )
    return null;
  return {
    jobId: payload.jobId,
    inputRevision: payload.inputRevision,
    inputHash: payload.inputHash,
    page: payload.page,
  };
}

function readCreativeFeedbackBinding(value: unknown): CreativeFeedbackBinding | null {
  const binding = asRecord(value);
  const keys = Reflect.ownKeys(binding);
  if (keys.length !== 3 || keys.some((key) => !["jobId", "inputRevision", "inputHash"].includes(String(key)))) return null;
  if (
    typeof binding.jobId !== "string" ||
    !binding.jobId ||
    typeof binding.inputRevision !== "number" ||
    !Number.isSafeInteger(binding.inputRevision) ||
    binding.inputRevision < 1 ||
    typeof binding.inputHash !== "string" ||
    !/^[0-9a-f]{64}$/.test(binding.inputHash)
  )
    return null;
  return {
    jobId: binding.jobId,
    inputRevision: binding.inputRevision,
    inputHash: binding.inputHash,
  };
}

function readCreativeReviewProgress(value: unknown, job: RovelleCreativeJob, pageCount: number): CreativeReviewProgress {
  const progress = asRecord(value);
  const pages = progress.viewedPages;
  if (
    progress.jobId !== job.id ||
    progress.inputRevision !== job.inputRevision ||
    progress.inputHash !== job.inputHash ||
    !Array.isArray(pages) ||
    typeof progress.currentPage !== "number" ||
    !Number.isSafeInteger(progress.currentPage) ||
    progress.currentPage < 1 ||
    progress.currentPage > pageCount ||
    !pages.includes(progress.currentPage)
  ) {
    return {
      jobId: job.id,
      inputRevision: job.inputRevision,
      inputHash: job.inputHash,
      currentPage: 1,
      viewedPages: [1],
    };
  }
  const viewedPages = [
    ...new Set(pages.filter((page): page is number => typeof page === "number" && Number.isSafeInteger(page) && page >= 1 && page <= pageCount)),
  ].sort((left, right) => left - right);
  if (!viewedPages.includes(1) || !viewedPages.includes(progress.currentPage)) {
    return {
      jobId: job.id,
      inputRevision: job.inputRevision,
      inputHash: job.inputHash,
      currentPage: 1,
      viewedPages: [1],
    };
  }
  return {
    jobId: job.id,
    inputRevision: job.inputRevision,
    inputHash: job.inputHash,
    currentPage: progress.currentPage,
    viewedPages,
  };
}

function progressForPage(progress: CreativeReviewProgress, job: RovelleCreativeJob, page: number): CreativeReviewProgress {
  return {
    jobId: job.id,
    inputRevision: job.inputRevision,
    inputHash: job.inputHash,
    currentPage: page,
    viewedPages: [...new Set([...progress.viewedPages, page])].sort((left, right) => left - right),
  };
}

function allPagesViewed(viewedPages: number[], pageCount: number): boolean {
  return viewedPages.length === pageCount && viewedPages.every((page, index) => page === index + 1);
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
