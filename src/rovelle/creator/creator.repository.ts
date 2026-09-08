import { Injectable } from "@nestjs/common";
import { Prisma, type RovelleCreatorAction, type RovelleCreatorSession } from "../../generated/prisma/client";
import { PrismaService } from "../../database/prisma.service";

type JsonResult = Prisma.JsonValue;
type SafeActionResult = Prisma.JsonObject;

export type CreatorActionResult =
  | { status: "not_found" | "foreign_user" | "expired" | "invalid_result"; action?: undefined }
  | { status: "consumed" | "duplicate"; action: RovelleCreatorAction; result: Prisma.JsonValue | null };

export type PendingUploadResult =
  | { status: "not_found" | "foreign_user" | "expired" | "consumed"; action?: undefined }
  | { status: "pending"; action: RovelleCreatorAction };

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
  if (action.consumedAt) return { status: "consumed" };
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
