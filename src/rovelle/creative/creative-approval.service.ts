import { ConflictException, Injectable } from "@nestjs/common";
import { randomBytes } from "node:crypto";
import {
  Prisma,
  RovelleCreativeJobStatus,
  type RovelleCreativeJob,
} from "../../generated/prisma/client";
import { renderCreativePages } from "./creative-preview";
import {
  hashCreativeValue,
  normalizeCreativeInput,
  normalizeCreativeResult,
} from "./creative-validation";
import type { CreatorTelegramReply } from "../creator/dto/creator.dto";
import { CanonPinService } from "../canon/canon-pin.service";
import { EpisodeService } from "../production/episode.service";
import { CreatorRepository } from "../creator/creator.repository";

const STALE_REPLY = {
  text: "That creative action is no longer current. Check /mywork.",
};
const PREVIEW_REQUIRED_REPLY = {
  text: "View every preview page before approving the plan.",
};

interface ApprovalPayload {
  jobId: string;
  inputRevision: number;
  inputHash: string;
  page: number;
}

@Injectable()
export class CreativeApprovalService {
  constructor(
    private readonly creatorRepository: CreatorRepository,
    private readonly episodes: EpisodeService,
    private readonly canonPins: CanonPinService,
  ) {}

  async approve(
    tx: Prisma.TransactionClient,
    input: { telegramUserId: string; token: string },
  ): Promise<CreatorTelegramReply> {
    const session = await this.creatorRepository.lockSession(tx, input.telegramUserId);
    const sessionData = asRecord(session.data);
    const jobId = typeof sessionData.creativeJobId === "string"
      ? sessionData.creativeJobId
      : "";
    if (!jobId) return STALE_REPLY;

    const job = await this.creatorRepository.lockCreativeJob(tx, {
      id: jobId,
      telegramUserId: input.telegramUserId,
    });
    const action = await this.creatorRepository.lockActionInTransaction(tx, input.token);
    const payload = readApprovalPayload(action?.payload);
    if (
      !job ||
      !action ||
      action.kind !== "CREATIVE_APPROVE" ||
      action.telegramUserId !== input.telegramUserId ||
      !payload ||
      payload.jobId !== job.id ||
      payload.inputRevision !== job.inputRevision ||
      payload.inputHash !== job.inputHash ||
      job.creatorSessionId !== session.id ||
      sessionData.creativeInputRevision !== job.inputRevision
    ) {
      return STALE_REPLY;
    }

    if (job.episodeId && job.approvedAt) {
      const saved = readSavedPlan(sessionData.creativeSavedPlan, job) ?? storedReply(action.result);
      return saved ?? STALE_REPLY;
    }
    if (action.consumedAt) return storedReply(action.result) ?? STALE_REPLY;
    if (action.expiresAt <= new Date()) {
      return { text: "That creative action expired. Check /mywork for fresh buttons." };
    }
    if (
      session.step !== "CREATIVE_REVIEW" ||
      job.status !== RovelleCreativeJobStatus.SUCCEEDED ||
      job.supersededAt ||
      job.episodeId ||
      job.approvedAt ||
      !job.result ||
      job.task !== "STORYBOARD"
    ) {
      return STALE_REPLY;
    }

    const creativeInput = normalizeCreativeInput(job.input);
    if (
      creativeInput.inputRevision !== job.inputRevision ||
      hashCreativeValue(creativeInput) !== job.inputHash
    ) {
      return STALE_REPLY;
    }
    const result = normalizeCreativeResult(job.result, creativeInput);
    const pageCount = renderCreativePages(creativeInput, result).length;
    if (
      payload.page !== pageCount ||
      !hasCompletePreview(sessionData.creativeReviewProgress, job, pageCount)
    ) {
      return PREVIEW_REQUIRED_REPLY;
    }

    const episode = await this.episodes.createEpisode({
      code: `RV${randomBytes(15).toString("hex").toUpperCase()}`,
      title: creativeInput.title,
      targetDurationSeconds: creativeInput.targetDurationSeconds,
    }, tx);
    await this.episodes.updateBrief(episode.id, {
      brief: {
        title: creativeInput.title,
        targetDurationSeconds: creativeInput.targetDurationSeconds,
        premise: creativeInput.premise,
        learningGoal: creativeInput.learningGoal,
        tone: creativeInput.tone,
        canonCodes: creativeInput.canon.map((canon) => canon.code),
        synopsis: result.synopsis,
        script: result.script,
        storyboard: result,
        creativeJobId: job.id,
        creativeInputRevision: job.inputRevision,
      },
    }, tx);
    await this.episodes.approveBrief(episode.id, tx);
    await this.episodes.startPreproduction(episode.id, tx);
    await this.episodes.replaceShots(episode.id, {
      shots: result.shots.map((shot) => ({
        sequence: shot.sequence,
        name: `Shot ${shot.sequence}`,
        direction: shot.direction,
        targetDurationSeconds: 4,
      })),
    }, tx);
    for (const canon of creativeInput.canon) {
      await this.canonPins.pinEpisode(
        episode.id,
        canon.entityId,
        { canonVersionId: canon.versionId },
        tx,
      );
    }

    const now = new Date();
    const reply: CreatorTelegramReply = {
      text: `Plan saved as “${creativeInput.title}” (${episode.code}). Episode is in PREPRODUCTION; no generation has started.`,
    };
    const approved = await this.creatorRepository.approveCreativeJobInTransaction(tx, {
      id: job.id,
      telegramUserId: input.telegramUserId,
      inputRevision: job.inputRevision,
      inputHash: job.inputHash,
      episodeId: episode.id,
      approvedAt: now,
    });
    if (!approved) throw new ConflictException("Creative job changed before approval");

    const consumed = await this.creatorRepository.consumeCreativeActionInTransaction(tx, {
      token: action.token,
      telegramUserId: input.telegramUserId,
      kind: "CREATIVE_APPROVE",
      result: reply as unknown as Prisma.JsonObject,
    });
    if (consumed.status !== "consumed") {
      throw new ConflictException("Creative approval action could not be committed");
    }
    await this.creatorRepository.invalidateCreativeActions(tx, input.telegramUserId, now);
    await this.creatorRepository.saveSession(tx, {
      telegramUserId: input.telegramUserId,
      step: "IDLE",
      data: {
        ...sessionData,
        episodeId: episode.id,
        creativeJobId: job.id,
        creativeSavedPlan: {
          jobId: job.id,
          inputRevision: job.inputRevision,
          inputHash: job.inputHash,
          reply,
        },
      } as unknown as Prisma.JsonValue,
    });
    return reply;
  }
}

function readApprovalPayload(value: unknown): ApprovalPayload | null {
  const payload = asRecord(value);
  const keys = Reflect.ownKeys(payload);
  if (
    keys.length !== 4 ||
    keys.some((key) => !["jobId", "inputRevision", "inputHash", "page"].includes(String(key))) ||
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
  ) {
    return null;
  }
  return {
    jobId: payload.jobId,
    inputRevision: payload.inputRevision,
    inputHash: payload.inputHash,
    page: payload.page,
  };
}

function hasCompletePreview(value: unknown, job: RovelleCreativeJob, pageCount: number): boolean {
  const progress = asRecord(value);
  const viewedPages = progress.viewedPages;
  return (
    progress.jobId === job.id &&
    progress.inputRevision === job.inputRevision &&
    progress.inputHash === job.inputHash &&
    Array.isArray(viewedPages) &&
    typeof progress.currentPage === "number" &&
    Number.isSafeInteger(progress.currentPage) &&
    progress.currentPage >= 1 &&
    progress.currentPage <= pageCount &&
    viewedPages.includes(progress.currentPage) &&
    viewedPages.length === pageCount &&
    viewedPages.every((page, index) => page === index + 1)
  );
}

function readSavedPlan(value: unknown, job: RovelleCreativeJob): CreatorTelegramReply | null {
  const saved = asRecord(value);
  if (
    saved.jobId !== job.id ||
    saved.inputRevision !== job.inputRevision ||
    saved.inputHash !== job.inputHash
  ) {
    return null;
  }
  return storedReply(saved.reply);
}

function storedReply(value: unknown): CreatorTelegramReply | null {
  if (!value || typeof value !== "object" || Array.isArray(value) || !("text" in value) || typeof value.text !== "string") {
    return null;
  }
  return value as CreatorTelegramReply;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
