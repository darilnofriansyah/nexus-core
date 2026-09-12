import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { createHash, randomBytes } from "node:crypto";
import {
  Prisma,
  RovelleCreativeJobStatus,
  type RovelleCreativeJob,
} from "../../generated/prisma/client";
import { PrismaService } from "../../database/prisma.service";
import type {
  CreatorInlineButton,
  CreatorTelegramReply,
} from "../creator/dto/creator.dto";
import type {
  CreativeClaim,
  CreativeCompletion,
  CreativeInput,
} from "./dto/creative.dto";
import { renderCreativePages } from "./creative-preview";
import {
  hashCreativeValue,
  normalizeCreativeCompletion,
  normalizeCreativeInput,
} from "./creative-validation";

const CREATIVE_TASK = "STORYBOARD" as const;
const LEASE_MS = 10 * 60 * 1000;
const QUEUED_LIMIT = 20;
const CREATIVE_ACTION_TTL_MS = 15 * 60 * 1000;

export interface CreateQueuedCreativeJobInput {
  sessionId: string;
  telegramUserId: string;
  chatId: string;
  input: CreativeInput;
}

@Injectable()
export class CreativeRepository {
  constructor(private readonly prisma: PrismaService) {}

  async createQueued(
    tx: Prisma.TransactionClient,
    input: CreateQueuedCreativeJobInput,
  ) {
    const normalizedInput = normalizeCreativeInput(input.input);

    return tx.rovelleCreativeJob.create({
      data: {
        creatorSessionId: input.sessionId,
        telegramUserId: input.telegramUserId,
        chatId: input.chatId,
        inputRevision: normalizedInput.inputRevision,
        task: CREATIVE_TASK,
        input: normalizedInput as unknown as Prisma.InputJsonValue,
        inputHash: hashCreativeValue(normalizedInput),
      },
      select: {
        id: true,
        creatorSessionId: true,
        telegramUserId: true,
        chatId: true,
        inputRevision: true,
        task: true,
        input: true,
        inputHash: true,
        status: true,
        leaseExpiresAt: true,
        result: true,
        completionMetadata: true,
        completionResponse: true,
        completionHash: true,
        failureCode: true,
        supersededAt: true,
        episodeId: true,
        approvedAt: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  }

  async claim(jobId: string, now: Date): Promise<CreativeClaim> {
    return this.runSerializable(async (tx) => {
      await this.reconcileExpired(tx, now, jobId);

      const queued = await tx.rovelleCreativeJob.findUnique({
        where: { id: jobId },
      });
      if (!queued) throw new NotFoundException("Creative job was not found");
      if (
        queued.status !== RovelleCreativeJobStatus.QUEUED ||
        queued.supersededAt !== null
      ) {
        return { claimed: false };
      }

      const leaseExpiresAt = new Date(now.getTime() + LEASE_MS);
      const transitioned = await tx.rovelleCreativeJob.updateMany({
        where: {
          id: jobId,
          status: RovelleCreativeJobStatus.QUEUED,
          supersededAt: null,
        },
        data: {
          status: RovelleCreativeJobStatus.RUNNING,
          leaseExpiresAt,
        },
      });
      if (transitioned.count !== 1) return { claimed: false };

      const attemptToken = randomBytes(32).toString("base64url");
      const claimed = await tx.rovelleCreativeJob.update({
        where: { id: jobId },
        data: { attemptTokenHash: hashToken(attemptToken) },
      });
      const creativeInput = normalizeCreativeInput(claimed.input);

      return {
        claimed: true,
        jobId: claimed.id,
        task: CREATIVE_TASK,
        attemptToken,
        inputHash: claimed.inputHash,
        leaseExpiresAt: leaseExpiresAt.toISOString(),
        input: creativeInput,
      };
    });
  }

  async complete(
    jobId: string,
    completion: CreativeCompletion,
    now: Date,
  ): Promise<{ chatId: string; reply: CreatorTelegramReply }> {
    return this.runSerializable(async (tx) => {
      const firstRead = await tx.rovelleCreativeJob.findUnique({
        where: { id: jobId },
      });
      if (!firstRead) throw new NotFoundException("Creative job was not found");
      await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id
        FROM rovelle_creator_sessions
        WHERE id = ${firstRead.creatorSessionId}::uuid
        FOR UPDATE
      `;
      await this.reconcileExpired(tx, now, jobId);
      const job = await tx.rovelleCreativeJob.findUnique({
        where: { id: jobId },
      });
      if (!job) throw new NotFoundException("Creative job was not found");
      if (job.supersededAt !== null) {
        throw new ConflictException("Creative job was superseded");
      }

      const creativeInput = normalizeCreativeInput(job.input);
      const expectedInputHash = hashCreativeValue(creativeInput);
      if (job.inputHash !== expectedInputHash) {
        throw new ConflictException("Creative job input hash is invalid");
      }
      if (
        typeof completion.inputHash === "string" &&
        completion.inputHash !== job.inputHash
      ) {
        throw new ConflictException(
          "Creative completion input hash does not match",
        );
      }

      const normalized = normalizeCreativeCompletion(completion, creativeInput);
      if (!job.attemptTokenHash) {
        throw new ConflictException(
          "Creative job has no active execution token",
        );
      }
      if (hashToken(normalized.attemptToken) !== job.attemptTokenHash) {
        throw new ForbiddenException("Creative execution token is invalid");
      }

      const completionHash = hashCreativeValue(normalized);
      if (
        job.status === RovelleCreativeJobStatus.SUCCEEDED ||
        job.status === RovelleCreativeJobStatus.FAILED
      ) {
        if (job.completionHash !== completionHash || !job.completionResponse) {
          throw new ConflictException(
            "Creative completion conflicts with the stored result",
          );
        }
        return {
          chatId: job.chatId,
          reply: job.completionResponse as unknown as CreatorTelegramReply,
        };
      }
      if (
        job.status !== RovelleCreativeJobStatus.RUNNING &&
        job.status !== RovelleCreativeJobStatus.OUTCOME_UNKNOWN
      ) {
        throw new ConflictException(
          "Creative job is not accepting a completion",
        );
      }

      const reply = await completionReply(tx, job, creativeInput, normalized);
      const updated = await tx.rovelleCreativeJob.updateMany({
        where: {
          id: job.id,
          status: job.status,
          supersededAt: null,
          attemptTokenHash: job.attemptTokenHash,
        },
        data: {
          status:
            normalized.status === "COMPLETED"
              ? RovelleCreativeJobStatus.SUCCEEDED
              : RovelleCreativeJobStatus.FAILED,
          leaseExpiresAt: null,
          result:
            normalized.status === "COMPLETED"
              ? (normalized.result as unknown as Prisma.InputJsonValue)
              : Prisma.JsonNull,
          completionMetadata:
            normalized.metadata as unknown as Prisma.InputJsonValue,
          completionResponse: reply as unknown as Prisma.InputJsonValue,
          completionHash,
          failureCode:
            normalized.status === "FAILED" ? normalized.errorCode : null,
        },
      });
      if (updated.count !== 1) {
        throw new ConflictException("Creative job changed while completing");
      }

      return { chatId: job.chatId, reply };
    });
  }

  async listQueued(now: Date): Promise<Array<{ id: string }>> {
    return this.runSerializable(async (tx) => {
      await this.reconcileExpired(tx, now);

      return tx.rovelleCreativeJob.findMany({
        where: {
          status: RovelleCreativeJobStatus.QUEUED,
          supersededAt: null,
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: QUEUED_LIMIT,
        select: { id: true },
      });
    });
  }

  private async reconcileExpired(
    tx: Prisma.TransactionClient,
    now: Date,
    jobId?: string,
  ): Promise<void> {
    await tx.rovelleCreativeJob.updateMany({
      where: {
        ...(jobId ? { id: jobId } : {}),
        status: RovelleCreativeJobStatus.RUNNING,
        leaseExpiresAt: { lte: now },
      },
      data: {
        status: RovelleCreativeJobStatus.OUTCOME_UNKNOWN,
        leaseExpiresAt: null,
      },
    });
  }

  private async runSerializable<T>(
    operation: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.prisma.client.$transaction(operation, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        });
      } catch (error) {
        if (!isSerializableTransactionError(error) || attempt === 2) {
          throw error;
        }
      }
    }
    throw new Error("unreachable");
  }
}

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

async function completionReply(
  tx: Prisma.TransactionClient,
  job: RovelleCreativeJob,
  input: CreativeInput,
  completion: CreativeCompletion,
): Promise<CreatorTelegramReply> {
  if (completion.status === "FAILED") {
    const retry = await createCreativeAction(tx, job, "CREATIVE_RETRY", 1, "Retry");
    return {
      text: "Creative draft could not be completed. It was not retried automatically.",
      inlineKeyboard: [[retry]],
    };
  }

  const pages = renderCreativePages(input, completion.result);
  const buttons: CreatorInlineButton[] = [];
  if (pages.length > 1) {
    buttons.push(await createCreativeAction(tx, job, "CREATIVE_PAGE", 2, "Next"));
  }
  buttons.push(await createCreativeAction(tx, job, "CREATIVE_REVISE", 1, "Revise"));
  if (pages.length === 1) {
    buttons.push(await createCreativeAction(tx, job, "CREATIVE_APPROVE", 1, "Approve plan"));
  }
  await recordInitialPreviewProgress(tx, job);
  return {
    text: pages[0]!,
    inlineKeyboard: buttons.map((button) => [button]),
  };
}

async function createCreativeAction(
  tx: Prisma.TransactionClient,
  job: RovelleCreativeJob,
  kind: "CREATIVE_PAGE" | "CREATIVE_REVISE" | "CREATIVE_APPROVE" | "CREATIVE_RETRY",
  page: number,
  text: string,
): Promise<CreatorInlineButton> {
  const action = await tx.rovelleCreatorAction.create({
    data: {
      token: randomBytes(18).toString("base64url"),
      telegramUserId: job.telegramUserId,
      kind,
      payload: {
        jobId: job.id,
        inputRevision: job.inputRevision,
        inputHash: job.inputHash,
        page,
      },
      expiresAt: new Date(Date.now() + CREATIVE_ACTION_TTL_MS),
    },
  });
  return { text, callbackData: `rv:${action.token}` };
}

async function recordInitialPreviewProgress(
  tx: Prisma.TransactionClient,
  job: RovelleCreativeJob,
): Promise<void> {
  const session = await tx.rovelleCreatorSession.findUnique({
    where: { id: job.creatorSessionId },
  });
  if (!session) return;
  const data = plainRecord(session.data);
  if (data.creativeJobId !== job.id || data.creativeInputRevision !== job.inputRevision) return;
  await tx.rovelleCreatorSession.update({
    where: { id: session.id },
    data: {
      data: {
        ...data,
        creativeReviewProgress: {
          jobId: job.id,
          inputRevision: job.inputRevision,
          inputHash: job.inputHash,
          currentPage: 1,
          viewedPages: [1],
        },
      },
    },
  });
}

function plainRecord(value: Prisma.JsonValue): Record<string, Prisma.JsonValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, Prisma.JsonValue>)
    : {};
}

function isSerializableTransactionError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  if ("code" in error && error.code === "P2034") return true;
  if (!("cause" in error)) return false;
  const cause = error.cause;
  return (
    typeof cause === "object" &&
    cause !== null &&
    "originalCode" in cause &&
    cause.originalCode === "40001"
  );
}
