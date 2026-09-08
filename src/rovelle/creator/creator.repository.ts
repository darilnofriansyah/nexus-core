import { Injectable } from "@nestjs/common";
import { Prisma, type RovelleCreatorAction, type RovelleCreatorSession } from "../../generated/prisma/client";
import { PrismaService } from "../../database/prisma.service";

type JsonResult = Prisma.JsonValue;
type SafeActionResult = Prisma.JsonObject;

const ACTION_GROUP_KINDS = {
  generation: ["GENERATE_SHOT"],
  review: ["APPROVE_GENERATION", "REGENERATE_SHOT"],
  render: ["QUEUE_RENDER"],
  canonLock: ["LOCK_CANON"],
} as const;

type ActionGroupScope = keyof typeof ACTION_GROUP_KINDS;

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
