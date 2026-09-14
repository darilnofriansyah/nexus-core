import { ConflictException, Injectable } from "@nestjs/common";
import {
  Prisma,
  RovelleCanonVersionStatus,
  RovelleCreativeJobStatus,
  type RovelleCreatorAction,
  type RovelleCreatorSession,
  type RovelleCreativeJob,
} from "../../generated/prisma/client";
import { PrismaService } from "../../database/prisma.service";
import type { CreatorTelegramReply } from "./dto/creator.dto";

type JsonResult = Prisma.JsonValue;
type SafeActionResult = Prisma.JsonObject;

const ACTION_GROUP_KINDS = {
  generation: ["GENERATE_SHOT"],
  review: ["APPROVE_GENERATION", "REGENERATE_SHOT"],
  render: ["QUEUE_RENDER"],
  canonLock: ["LOCK_CANON"],
} as const;

type ActionGroupScope = keyof typeof ACTION_GROUP_KINDS;
type CreativeReviewActionKind = "CREATIVE_PAGE" | "CREATIVE_REVISE" | "CREATIVE_APPROVE" | "CREATIVE_RETRY";

export interface CreatorTelegramReceiptKey {
  botId: string;
  updateId: string;
  telegramUserId: string;
  chatId: string;
  requestHash: string;
}

export interface CreateCreatorTelegramReceiptInput extends CreatorTelegramReceiptKey {
  response: CreatorTelegramReply;
}

export type CreativeModeClaim =
  | { status: "consumed"; action: RovelleCreatorAction; result: CreatorTelegramReply }
  | { status: "duplicate"; action: RovelleCreatorAction; result: Prisma.JsonValue | null }
  | { status: "not_found" | "foreign_user" | "expired" };

export interface LockedCreatorCanonVersion {
  entityId: string;
  versionId: string;
  code: string;
  definition: Record<string, unknown>;
}

export type CreatorActionResult =
  | { status: "not_found" | "foreign_user" | "expired" | "invalid_result"; action?: undefined }
  | { status: "consumed" | "duplicate"; action: RovelleCreatorAction; result: Prisma.JsonValue | null };

export type PendingUploadResult =
  | { status: "not_found" | "foreign_user" | "expired"; action?: undefined }
  | { status: "consumed"; action: RovelleCreatorAction; result: Prisma.JsonValue | null }
  | { status: "pending"; action: RovelleCreatorAction };

export type PendingButtonResult =
  | { status: "not_found" | "foreign_user" | "expired"; action?: undefined }
  | { status: "pending"; action: RovelleCreatorAction }
  | { status: "duplicate"; action: RovelleCreatorAction; result: Prisma.JsonValue | null };

export type UploadReservationClaim =
  | { status: "claimed"; action: RovelleCreatorAction; assetId: string }
  | { status: "reserving"; action: RovelleCreatorAction; assetId: string }
  | { status: "not_found" | "foreign_user" | "expired" | "consumed" };

export type UploadCompletionClaim =
  | { status: "claimed"; action: RovelleCreatorAction }
  | { status: "processing"; action: RovelleCreatorAction }
  | { status: "duplicate"; action: RovelleCreatorAction; result: Prisma.JsonValue | null }
  | { status: "not_found" | "foreign_user" | "expired" | "unbound" };

const UPLOAD_LEASE_MS = 30_000;
const RESERVATION_LEASE_MS = 30_000;

@Injectable()
export class CreatorRepository {
  constructor(private readonly prisma: PrismaService) {}

  upsertSession(input: { telegramUserId: string; step: string; data: JsonResult }): Promise<RovelleCreatorSession> {
    return this.prisma.client.rovelleCreatorSession.upsert({
      where: { telegramUserId: input.telegramUserId },
      create: { telegramUserId: input.telegramUserId, step: input.step, data: input.data as Prisma.InputJsonValue },
      update: { step: input.step, data: input.data as Prisma.InputJsonValue },
    });
  }

  findSession(telegramUserId: string): Promise<RovelleCreatorSession | null> {
    return this.prisma.client.rovelleCreatorSession.findUnique({ where: { telegramUserId } });
  }

  async findTelegramReceipt(
    input: Pick<CreatorTelegramReceiptKey, "botId" | "updateId" | "requestHash">,
  ): Promise<CreatorTelegramReply | null> {
    const receipt = await this.prisma.client.rovelleTelegramReceipt.findUnique({
      where: { botId_updateId: { botId: input.botId, updateId: input.updateId } },
    });
    if (!receipt) return null;
    if (receipt.requestHash !== input.requestHash) {
      throw new ConflictException("Telegram update content changed after it was received");
    }
    return storedTelegramReply(receipt.response);
  }

  async withTelegramReceipt(
    input: CreatorTelegramReceiptKey,
    operation: (tx: Prisma.TransactionClient) => Promise<CreatorTelegramReply | null>,
  ): Promise<CreatorTelegramReply | null> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.prisma.client.$transaction(async (tx) => {
          const receipt = await tx.rovelleTelegramReceipt.findUnique({
            where: { botId_updateId: { botId: input.botId, updateId: input.updateId } },
          });
          if (receipt) {
            if (receipt.requestHash !== input.requestHash) {
              throw new ConflictException("Telegram update content changed after it was received");
            }
            return storedTelegramReply(receipt.response);
          }

          const response = await operation(tx);
          if (!response) return null;
          await this.createTelegramReceipt(tx, { ...input, response });
          return response;
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      } catch (error) {
        if (!isReceiptRetryableError(error) || attempt === 2) throw error;
        await delayReceiptRetry(attempt);
      }
    }
    throw new Error("unreachable");
  }

  createTelegramReceipt(
    tx: Prisma.TransactionClient,
    input: CreateCreatorTelegramReceiptInput,
  ) {
    return tx.rovelleTelegramReceipt.create({
      data: {
        botId: input.botId,
        updateId: input.updateId,
        telegramUserId: input.telegramUserId,
        chatId: input.chatId,
        requestHash: input.requestHash,
        response: input.response as unknown as Prisma.InputJsonValue,
      },
    });
  }

  async lockSession(tx: Prisma.TransactionClient, telegramUserId: string): Promise<RovelleCreatorSession> {
    const session = await tx.rovelleCreatorSession.upsert({
      where: { telegramUserId },
      create: { telegramUserId, step: "IDLE", data: {} },
      update: {},
    });
    await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM rovelle_creator_sessions WHERE id = ${session.id}::uuid FOR UPDATE`;
    return tx.rovelleCreatorSession.findUniqueOrThrow({ where: { id: session.id } });
  }

  saveSession(
    tx: Prisma.TransactionClient,
    input: { telegramUserId: string; step: string; data: JsonResult },
  ): Promise<RovelleCreatorSession> {
    return tx.rovelleCreatorSession.update({
      where: { telegramUserId: input.telegramUserId },
      data: { step: input.step, data: input.data as Prisma.InputJsonValue },
    });
  }

  findAction(token: string, telegramUserId: string): Promise<RovelleCreatorAction | null> {
    return this.prisma.client.rovelleCreatorAction.findFirst({ where: { token, telegramUserId } });
  }

  findActionInTransaction(tx: Prisma.TransactionClient, token: string): Promise<RovelleCreatorAction | null> {
    return tx.rovelleCreatorAction.findUnique({ where: { token } });
  }

  async lockActionInTransaction(
    tx: Prisma.TransactionClient,
    token: string,
  ): Promise<RovelleCreatorAction | null> {
    await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM rovelle_creator_actions WHERE token = ${token} FOR UPDATE`;
    return this.findActionInTransaction(tx, token);
  }

  createActionInTransaction(
    tx: Prisma.TransactionClient,
    input: { token: string; telegramUserId: string; kind: string; payload: JsonResult; expiresAt: Date },
  ): Promise<RovelleCreatorAction> {
    return tx.rovelleCreatorAction.create({
      data: { ...input, payload: input.payload as Prisma.InputJsonValue },
    });
  }

  async findCreativeModeActionsInTransaction(
    tx: Prisma.TransactionClient,
    input: { telegramUserId: string; actionGroup: string },
  ): Promise<RovelleCreatorAction[]> {
    const actions = await tx.rovelleCreatorAction.findMany({
      where: {
        telegramUserId: input.telegramUserId,
        kind: "CREATIVE_MODE",
        consumedAt: null,
        expiresAt: { gt: new Date() },
      },
    });
    return actions.filter((action) => readActionGroup(action.payload) === input.actionGroup);
  }

  async consumeCreativeModeActions(
    tx: Prisma.TransactionClient,
    input: {
      token: string;
      telegramUserId: string;
      result: CreatorTelegramReply;
      siblingResult: CreatorTelegramReply;
    },
  ): Promise<CreativeModeClaim> {
    const action = await tx.rovelleCreatorAction.findUnique({ where: { token: input.token } });
    if (!action || action.kind !== "CREATIVE_MODE") return { status: "not_found" };
    if (action.telegramUserId !== input.telegramUserId) return { status: "foreign_user" };
    const now = new Date();
    if (action.expiresAt <= now) return { status: "expired" };
    if (action.consumedAt) {
      return { status: "duplicate", action, result: action.result };
    }
    const actionGroup = readActionGroup(action.payload);
    if (!actionGroup) return { status: "not_found" };

    const siblings = (await tx.rovelleCreatorAction.findMany({
      where: {
        telegramUserId: input.telegramUserId,
        kind: "CREATIVE_MODE",
        consumedAt: null,
        expiresAt: { gt: now },
      },
    })).filter((candidate) => candidate.id !== action.id && readActionGroup(candidate.payload) === actionGroup);

    const selected = await tx.rovelleCreatorAction.updateMany({
      where: {
        id: action.id,
        telegramUserId: input.telegramUserId,
        kind: "CREATIVE_MODE",
        consumedAt: null,
        expiresAt: { gt: now },
      },
      data: {
        consumedAt: now,
        result: input.result as unknown as Prisma.InputJsonValue,
      },
    });
    if (selected.count !== 1) {
      const current = await tx.rovelleCreatorAction.findUnique({ where: { token: input.token } });
      return current?.consumedAt
        ? { status: "duplicate", action: current, result: current.result }
        : { status: "not_found" };
    }

    if (siblings.length) {
      const consumed = await tx.rovelleCreatorAction.updateMany({
        where: {
          id: { in: siblings.map((sibling) => sibling.id) },
          telegramUserId: input.telegramUserId,
          kind: "CREATIVE_MODE",
          consumedAt: null,
          expiresAt: { gt: now },
        },
        data: {
          consumedAt: now,
          result: input.siblingResult as unknown as Prisma.InputJsonValue,
        },
      });
      if (consumed.count !== siblings.length) {
        throw new ConflictException("Creative mode changed while it was being selected");
      }
    }

    return {
      status: "consumed",
      action: { ...action, consumedAt: now, result: input.result as unknown as Prisma.JsonValue },
      result: input.result,
    };
  }

  async consumeCreativeActionInTransaction(
    tx: Prisma.TransactionClient,
    input: {
      token: string;
      telegramUserId: string;
      kind: CreativeReviewActionKind;
      result: SafeActionResult;
    },
  ): Promise<CreatorActionResult> {
    if (!isSafeActionResult(input.result)) return { status: "invalid_result" };
    const action = await tx.rovelleCreatorAction.findUnique({
      where: { token: input.token },
    });
    if (!action || action.kind !== input.kind) return { status: "not_found" };

    const state = classifyButton(action, input.telegramUserId, new Date());
    if (state.status !== "pending") return state;

    const now = new Date();
    const consumed = await tx.rovelleCreatorAction.updateMany({
      where: {
        id: state.action.id,
        token: input.token,
        telegramUserId: input.telegramUserId,
        kind: input.kind,
        consumedAt: null,
        expiresAt: { gt: now },
      },
      data: { consumedAt: now, result: input.result as Prisma.InputJsonValue },
    });
    if (consumed.count !== 1) {
      const current = await tx.rovelleCreatorAction.findUnique({
        where: { token: input.token },
      });
      return current ? actionResultAfterRace(current, input.telegramUserId, false) : { status: "not_found" };
    }

    return {
      status: "consumed",
      action: { ...state.action, consumedAt: now, result: input.result },
      result: input.result,
    };
  }

  async findCreativeJobInTransaction(
    tx: Prisma.TransactionClient,
    input: { id: string; telegramUserId: string },
  ): Promise<RovelleCreativeJob | null> {
    const now = new Date();
    await tx.rovelleCreativeJob.updateMany({
      where: {
        id: input.id,
        telegramUserId: input.telegramUserId,
        status: RovelleCreativeJobStatus.RUNNING,
        leaseExpiresAt: { lte: now },
        supersededAt: null,
      },
      data: {
        status: RovelleCreativeJobStatus.OUTCOME_UNKNOWN,
        leaseExpiresAt: null,
      },
    });
    return tx.rovelleCreativeJob.findFirst({ where: { id: input.id, telegramUserId: input.telegramUserId } });
  }

  async lockCreativeJob(
    tx: Prisma.TransactionClient,
    input: { id: string; telegramUserId: string },
  ): Promise<RovelleCreativeJob | null> {
    await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM rovelle_creative_jobs WHERE id = ${input.id}::uuid AND telegram_user_id = ${input.telegramUserId} FOR UPDATE`;
    return this.findCreativeJobInTransaction(tx, input);
  }

  async approveCreativeJobInTransaction(
    tx: Prisma.TransactionClient,
    input: {
      id: string;
      telegramUserId: string;
      inputRevision: number;
      inputHash: string;
      episodeId: string;
      approvedAt: Date;
    },
  ): Promise<boolean> {
    const result = await tx.rovelleCreativeJob.updateMany({
      where: {
        id: input.id,
        telegramUserId: input.telegramUserId,
        inputRevision: input.inputRevision,
        inputHash: input.inputHash,
        status: RovelleCreativeJobStatus.SUCCEEDED,
        supersededAt: null,
        episodeId: null,
        approvedAt: null,
      },
      data: { episodeId: input.episodeId, approvedAt: input.approvedAt },
    });
    return result.count === 1;
  }

  findActiveCreativeJobInTransaction(
    tx: Prisma.TransactionClient,
    telegramUserId: string,
  ): Promise<RovelleCreativeJob | null> {
    return tx.rovelleCreativeJob.findFirst({
      where: {
        telegramUserId,
        status: { in: [RovelleCreativeJobStatus.QUEUED, RovelleCreativeJobStatus.RUNNING, RovelleCreativeJobStatus.OUTCOME_UNKNOWN] },
        supersededAt: null,
      },
      orderBy: { createdAt: "desc" },
    });
  }

  async supersedeCreativeJob(tx: Prisma.TransactionClient, job: RovelleCreativeJob, now: Date): Promise<void> {
    if (job.supersededAt) return;
    if (job.status === RovelleCreativeJobStatus.QUEUED) {
      await tx.rovelleCreativeJob.updateMany({
        where: { id: job.id, status: RovelleCreativeJobStatus.QUEUED, supersededAt: null },
        data: {
          status: RovelleCreativeJobStatus.FAILED,
          failureCode: "SUPERSEDED_BEFORE_START",
          leaseExpiresAt: null,
          supersededAt: now,
        },
      });
      return;
    }
    await tx.rovelleCreativeJob.updateMany({
      where: { id: job.id, status: job.status, supersededAt: null },
      data: { supersededAt: now },
    });
  }

  invalidateCreativeActions(tx: Prisma.TransactionClient, telegramUserId: string, now: Date) {
    return tx.rovelleCreatorAction.updateMany({
      where: { telegramUserId, kind: { startsWith: "CREATIVE_" }, consumedAt: null },
      data: {
        consumedAt: now,
        result: { text: "That creative action is no longer current. Check /mywork for the latest draft." },
      },
    });
  }

  async findLockedCanonVersions(
    tx: Prisma.TransactionClient,
    codes: string[],
  ): Promise<LockedCreatorCanonVersion[]> {
    if (!codes.length) return [];
    const entities = await tx.rovelleCanonEntity.findMany({
      where: { code: { in: codes } },
      include: {
        versions: {
          where: { status: RovelleCanonVersionStatus.LOCKED },
          orderBy: { version: "desc" },
          take: 1,
        },
      },
    });
    return entities.flatMap((entity) => {
      const version = entity.versions[0];
      if (!version) return [];
      return [{
        entityId: entity.id,
        versionId: version.id,
        code: entity.code,
        definition: version.definition as Record<string, unknown>,
      }];
    });
  }

  createAction(input: {
    token: string;
    telegramUserId: string;
    kind: string;
    payload: JsonResult;
    expiresAt: Date;
  }): Promise<RovelleCreatorAction> {
    return this.prisma.client.rovelleCreatorAction.create({ data: { ...input, payload: input.payload as Prisma.InputJsonValue } });
  }

  async findPendingUploadAction(token: string, telegramUserId: string): Promise<PendingUploadResult> {
    const action = await this.prisma.client.rovelleCreatorAction.findUnique({ where: { token } });
    return classifyPendingUpload(action, telegramUserId, new Date());
  }

  async findPendingUploadActionByToken(token: string): Promise<PendingUploadResult> {
    const action = await this.prisma.client.rovelleCreatorAction.findUnique({ where: { token } });
    return classifyPendingUpload(action, action?.telegramUserId ?? "", new Date());
  }

  async updatePendingUploadPayload(input: {
    token: string;
    telegramUserId: string;
    payload: JsonResult;
  }): Promise<PendingUploadResult> {
    const updated = await this.prisma.client.rovelleCreatorAction.updateMany({
      where: {
        token: input.token,
        telegramUserId: input.telegramUserId,
        kind: { startsWith: "UPLOAD_" },
        consumedAt: null,
        expiresAt: { gt: new Date() },
      },
      data: { payload: input.payload as Prisma.InputJsonValue },
    });
    if (updated.count !== 1) return this.findPendingUploadActionByToken(input.token);
    return this.findPendingUploadActionByToken(input.token);
  }

  async claimUploadReservation(input: {
    token: string;
    telegramUserId: string;
    assetId: string;
    mediaType: string;
  }): Promise<UploadReservationClaim> {
    const action = await this.prisma.client.rovelleCreatorAction.findUnique({ where: { token: input.token } });
    const now = new Date();
    const pending = classifyPendingUpload(action, input.telegramUserId, now);
    if (!action || pending.status !== "pending") return pending.status === "consumed" && action
      ? { status: "consumed" }
      : { status: pending.status } as UploadReservationClaim;
    const reservation = readUploadReservation(action.result);
    if (reservation) {
      if (reservation.leaseExpiresAt > now) return { status: "reserving", action, assetId: reservation.assetId };
      const reclaimed = await this.prisma.client.rovelleCreatorAction.updateMany({
        where: {
          id: action.id,
          token: input.token,
          telegramUserId: input.telegramUserId,
          consumedAt: null,
          expiresAt: { gt: now },
          updatedAt: { lte: reservation.leaseExpiresAt },
        },
        data: { result: reservationWork(reservation.assetId, reservation.mediaType, now) },
      });
      if (reclaimed.count === 1) return { status: "claimed", action, assetId: reservation.assetId };
      const current = await this.prisma.client.rovelleCreatorAction.findUnique({ where: { token: input.token } });
      const currentReservation = current ? readUploadReservation(current.result) : null;
      if (current && currentReservation) return { status: "reserving", action: current, assetId: currentReservation.assetId };
      return { status: "not_found" };
    }
    if (action.result !== null) return { status: "not_found" };
    const claimed = await this.prisma.client.rovelleCreatorAction.updateMany({
      where: { id: action.id, token: input.token, telegramUserId: input.telegramUserId, consumedAt: null, expiresAt: { gt: now }, result: { equals: Prisma.DbNull } },
      data: { result: reservationWork(input.assetId, input.mediaType, now) },
    });
    if (claimed.count === 1) return { status: "claimed", action, assetId: input.assetId };
    const current = await this.prisma.client.rovelleCreatorAction.findUnique({ where: { token: input.token } });
    const currentState = classifyPendingUpload(current, input.telegramUserId, new Date());
    if (currentState.status === "pending" && current) {
      const currentReservation = readUploadReservation(current.result);
      if (currentReservation) return { status: "reserving", action: current, assetId: currentReservation.assetId };
    }
    return currentState.status === "consumed" ? { status: "consumed" } : { status: currentState.status } as UploadReservationClaim;
  }

  async bindReservedUploadAsset(input: {
    token: string;
    telegramUserId: string;
    payload: JsonResult;
  }): Promise<PendingUploadResult> {
    await this.prisma.client.rovelleCreatorAction.updateMany({
      where: {
        token: input.token,
        telegramUserId: input.telegramUserId,
        kind: { startsWith: "UPLOAD_" },
        consumedAt: null,
        expiresAt: { gt: new Date() },
        result: { not: Prisma.DbNull },
      },
      data: { payload: input.payload as Prisma.InputJsonValue, result: Prisma.DbNull },
    });
    return this.findPendingUploadActionByToken(input.token);
  }

  async claimUploadCompletion(input: {
    token: string;
    telegramUserId: string;
  }): Promise<UploadCompletionClaim> {
    const action = await this.prisma.client.rovelleCreatorAction.findUnique({ where: { token: input.token } });
    const pending = classifyPendingUpload(action, input.telegramUserId, new Date());
    if (!action || pending.status !== "pending") {
      if (pending.status === "consumed" && action) return { status: "duplicate", action, result: action.result };
      return { status: pending.status } as UploadCompletionClaim;
    }
    if (!hasBoundUploadAsset(action.payload)) return { status: "unbound" };
    if (readUploadWork(action.result, "RESERVING")) return { status: "processing", action };
    const completing = readUploadWork(action.result, "COMPLETING");
    if (action.result !== null && !completing) return { status: "processing", action };
    const now = new Date();
    if (completing && action.updatedAt > new Date(now.getTime() - UPLOAD_LEASE_MS)) return { status: "processing", action };
    const where = completing
      ? { id: action.id, token: input.token, telegramUserId: input.telegramUserId, consumedAt: null, expiresAt: { gt: now }, updatedAt: { lt: new Date(now.getTime() - UPLOAD_LEASE_MS) } }
      : { id: action.id, token: input.token, telegramUserId: input.telegramUserId, consumedAt: null, expiresAt: { gt: now }, result: { equals: Prisma.DbNull } };
    const claimed = await this.prisma.client.rovelleCreatorAction.updateMany({
      where,
      data: { result: { phase: "COMPLETING" } },
    });
    if (claimed.count === 1) return { status: "claimed", action };
    const current = await this.prisma.client.rovelleCreatorAction.findUnique({ where: { token: input.token } });
    const currentState = classifyPendingUpload(current, input.telegramUserId, new Date());
    if (currentState.status === "consumed" && current) return { status: "duplicate", action: current, result: current.result };
    if (currentState.status === "pending" && current) return { status: "processing", action: current };
    return { status: currentState.status } as UploadCompletionClaim;
  }

  async findPendingButtonAction(token: string, telegramUserId: string): Promise<PendingButtonResult> {
    const action = await this.prisma.client.rovelleCreatorAction.findUnique({ where: { token } });
    const state = classifyButton(action, telegramUserId, new Date());
    if (state.status === "pending") return { status: "pending", action: state.action };
    if (state.status === "duplicate") return { status: "duplicate", action: state.action, result: state.result };
    if (state.status === "foreign_user" || state.status === "expired") return { status: state.status };
    return { status: "not_found" };
  }

  async completeUploadAction(input: {
    token: string;
    telegramUserId: string;
    result: JsonResult;
  }): Promise<CreatorActionResult> {
    return this.runSerializable(async (tx) => {
      const action = await tx.rovelleCreatorAction.findUnique({ where: { token: input.token } });
      const pending = classifyPendingUpload(action, input.telegramUserId, new Date());
      if (!action || pending.status !== "pending") {
        if (pending.status === "consumed" && action) {
          return { status: "duplicate", action, result: action.result };
        }
        return { status: pending.status } as CreatorActionResult;
      }
      const consumed = await tx.rovelleCreatorAction.updateMany({
        where: { id: action.id, token: input.token, telegramUserId: input.telegramUserId, consumedAt: null, expiresAt: { gt: new Date() } },
        data: { consumedAt: new Date(), result: input.result as Prisma.InputJsonValue },
      });
      if (consumed.count !== 1) {
        const current = await tx.rovelleCreatorAction.findUnique({ where: { token: input.token } });
        return current ? actionResultAfterRace(current, input.telegramUserId, true) : { status: "not_found" };
      }
      return { status: "consumed", action: { ...action, consumedAt: new Date(), result: input.result }, result: input.result };
    });
  }

  async consumeButtonAction(input: {
    token: string;
    telegramUserId: string;
    result: SafeActionResult;
  }): Promise<CreatorActionResult> {
    if (!input.result || typeof input.result !== "object" || Array.isArray(input.result)) {
      return { status: "invalid_result" };
    }
    return this.runSerializable(async (tx) => {
      const action = await tx.rovelleCreatorAction.findUnique({ where: { token: input.token } });
      const state = classifyButton(action, input.telegramUserId, new Date());
      if (state.status !== "pending") return state;
      const pendingAction = state.action;
      const now = new Date();
      const consumed = await tx.rovelleCreatorAction.updateMany({
        where: { id: pendingAction.id, token: input.token, telegramUserId: input.telegramUserId, consumedAt: null, expiresAt: { gt: now } },
        data: { consumedAt: now, result: input.result as Prisma.InputJsonValue },
      });
      if (consumed.count !== 1) {
        const current = await tx.rovelleCreatorAction.findUnique({ where: { token: input.token } });
        return current ? actionResultAfterRace(current, input.telegramUserId, false) : { status: "not_found" };
      }
      return { status: "consumed", action: { ...pendingAction, consumedAt: now, result: input.result }, result: input.result };
    });
  }

  async claimActionGroup(input: {
    token: string;
    telegramUserId: string;
    result: SafeActionResult;
    siblingResult: SafeActionResult;
    scope: ActionGroupScope;
  }): Promise<CreatorActionResult> {
    if (!isSafeActionResult(input.result) || !isSafeActionResult(input.siblingResult)) {
      return { status: "invalid_result" };
    }
    return this.runSerializable(async (tx) => {
      const action = await tx.rovelleCreatorAction.findUnique({ where: { token: input.token } });
      const state = classifyPendingActionGroup(action, input.telegramUserId, new Date(), input.scope);
      if (state.status !== "pending") return state;
      const actionGroup = readActionGroup(state.action.payload);
      if (!actionGroup) return { status: "not_found" };

      const now = new Date();
      const kinds = ACTION_GROUP_KINDS[input.scope];
      const eligible = await tx.rovelleCreatorAction.findMany({
        where: {
          telegramUserId: input.telegramUserId,
          kind: { in: [...kinds] },
          consumedAt: null,
          expiresAt: { gt: now },
        },
      });
      const siblings = eligible.filter((candidate) => candidate.id !== state.action.id && readActionGroup(candidate.payload) === actionGroup);
      const selected = await tx.rovelleCreatorAction.updateMany({
        where: {
          id: state.action.id,
          token: input.token,
          telegramUserId: input.telegramUserId,
          kind: state.action.kind,
          consumedAt: null,
          expiresAt: { gt: now },
        },
        data: { consumedAt: now, result: input.result as Prisma.InputJsonValue },
      });
      if (selected.count !== 1) {
        const current = await tx.rovelleCreatorAction.findUnique({ where: { token: input.token } });
        return current ? actionResultAfterRace(current, input.telegramUserId, false) : { status: "not_found" };
      }
      for (const sibling of siblings) {
        const consumed = await tx.rovelleCreatorAction.updateMany({
          where: {
            id: sibling.id,
            telegramUserId: input.telegramUserId,
            kind: sibling.kind,
            consumedAt: null,
            expiresAt: { gt: now },
          },
          data: { consumedAt: now, result: input.siblingResult as Prisma.InputJsonValue },
        });
        if (consumed.count !== 1) {
          return { status: "duplicate", action: { ...state.action, consumedAt: now, result: input.siblingResult }, result: input.siblingResult };
        }
      }
      return { status: "consumed", action: { ...state.action, consumedAt: now, result: input.result }, result: input.result };
    });
  }

  async updateConsumedButtonResult(input: {
    token: string;
    telegramUserId: string;
    result: SafeActionResult;
  }): Promise<void> {
    await this.prisma.client.rovelleCreatorAction.updateMany({
      where: { token: input.token, telegramUserId: input.telegramUserId, consumedAt: { not: null } },
      data: { result: input.result as Prisma.InputJsonValue },
    });
  }

  private async runSerializable<T>(operation: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.prisma.client.$transaction(operation, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        });
      } catch (error) {
        if (!isSerializableTransactionError(error) || attempt === 2) throw error;
      }
    }
    throw new Error("unreachable");
  }
}

function actionResultAfterRace(
  action: RovelleCreatorAction,
  telegramUserId: string,
  upload: boolean,
): CreatorActionResult {
  const state = upload
    ? classifyPendingUpload(action, telegramUserId, new Date())
    : classifyButton(action, telegramUserId, new Date());
  if (state.status === "duplicate") return state;
  if (upload && state.status === "consumed") return { status: "duplicate", action, result: action.result };
  if (state.status === "foreign_user" || state.status === "expired" || state.status === "not_found") {
    return { status: state.status };
  }
  return { status: "not_found" };
}

function storedTelegramReply(value: Prisma.JsonValue): CreatorTelegramReply {
  if (!value || typeof value !== "object" || Array.isArray(value) || !("text" in value) || typeof value.text !== "string") {
    throw new ConflictException("Stored Telegram response is invalid");
  }
  return value as unknown as CreatorTelegramReply;
}

function isReceiptRetryableError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  if ("code" in error) {
    if (error.code === "P2002" || error.code === "P2034" || error.code === "40001") return true;
    if (error.code === "P2010" && "meta" in error) {
      const meta = error.meta;
      if (typeof meta === "object" && meta !== null && "code" in meta && meta.code === "40001") return true;
    }
  }
  if ("message" in error && typeof error.message === "string" && /Code:\s*`40001`/.test(error.message)) {
    return true;
  }
  if (!("cause" in error)) return false;
  const cause = error.cause;
  return typeof cause === "object" && cause !== null && "originalCode" in cause && cause.originalCode === "40001";
}

function delayReceiptRetry(attempt: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
}

function isSerializableTransactionError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  if ("code" in error && error.code === "P2034") return true;
  if (!("cause" in error)) return false;
  const cause = error.cause;
  return typeof cause === "object" && cause !== null && "originalCode" in cause && cause.originalCode === "40001";
}

function classifyPendingUpload(action: RovelleCreatorAction | null, telegramUserId: string, now: Date): PendingUploadResult {
  if (!action) return { status: "not_found" };
  if (!action.kind.startsWith("UPLOAD_")) return { status: "not_found" };
  if (action.telegramUserId !== telegramUserId) return { status: "foreign_user" };
  if (action.consumedAt) return { status: "consumed", action, result: action.result };
  if (action.expiresAt <= now) return { status: "expired" };
  return { status: "pending", action };
}

function classifyButton(action: RovelleCreatorAction | null, telegramUserId: string, now: Date): CreatorActionResult | { status: "pending"; action: RovelleCreatorAction } {
  if (!action) return { status: "not_found" };
  if (action.kind.startsWith("UPLOAD_")) return { status: "not_found" };
  if (action.telegramUserId !== telegramUserId) return { status: "foreign_user" };
  if (action.consumedAt) return { status: "duplicate", action, result: action.result };
  if (action.expiresAt <= now) return { status: "expired" };
  return { status: "pending", action };
}

function classifyPendingActionGroup(action: RovelleCreatorAction | null, telegramUserId: string, now: Date, scope: ActionGroupScope): CreatorActionResult | { status: "pending"; action: RovelleCreatorAction } {
  if (!action || !(ACTION_GROUP_KINDS[scope] as readonly string[]).includes(action.kind)) return { status: "not_found" };
  return classifyButton(action, telegramUserId, now);
}

function readActionGroup(payload: Prisma.JsonValue): string | null {
  return typeof payload === "object" && payload !== null && !Array.isArray(payload) && "actionGroup" in payload && typeof payload.actionGroup === "string" && payload.actionGroup.length > 0
    ? payload.actionGroup
    : null;
}

function readUploadWork(value: Prisma.JsonValue | null, phase: "RESERVING" | "COMPLETING"): { assetId: string } | null {
  if (!value || typeof value !== "object" || Array.isArray(value) || !("phase" in value) || value.phase !== phase) return null;
  if (phase === "COMPLETING") return { assetId: "" };
  return "assetId" in value && typeof value.assetId === "string" ? { assetId: value.assetId } : null;
}

function readUploadReservation(value: Prisma.JsonValue | null): { assetId: string; mediaType: string; leaseExpiresAt: Date } | null {
  if (!value || typeof value !== "object" || Array.isArray(value) || !("phase" in value) || value.phase !== "RESERVING") return null;
  if (!("assetId" in value) || typeof value.assetId !== "string" || !("mediaType" in value) || typeof value.mediaType !== "string" || !("leaseExpiresAt" in value) || typeof value.leaseExpiresAt !== "string") return null;
  const leaseExpiresAt = new Date(value.leaseExpiresAt);
  return Number.isNaN(leaseExpiresAt.getTime()) ? null : { assetId: value.assetId, mediaType: value.mediaType, leaseExpiresAt };
}

function reservationWork(assetId: string, mediaType: string, now: Date): Prisma.JsonObject {
  return { phase: "RESERVING", assetId, mediaType, leaseExpiresAt: new Date(now.getTime() + RESERVATION_LEASE_MS).toISOString() };
}

function hasBoundUploadAsset(value: Prisma.JsonValue): boolean {
  return !!value && typeof value === "object" && !Array.isArray(value) && "assetId" in value && typeof value.assetId === "string";
}

function isSafeActionResult(value: unknown): value is SafeActionResult {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
