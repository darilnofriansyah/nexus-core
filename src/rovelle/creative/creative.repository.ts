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
} from "../../generated/prisma/client";
import { PrismaService } from "../../database/prisma.service";
import type { CreatorTelegramReply } from "../creator/dto/creator.dto";
import type {
  CreativeClaim,
  CreativeCompletion,
  CreativeInput,
} from "./dto/creative.dto";
import {
  hashCreativeValue,
  normalizeCreativeCompletion,
  normalizeCreativeInput,
} from "./creative-validation";

const CREATIVE_TASK = "STORYBOARD" as const;
const LEASE_MS = 10 * 60 * 1000;
const QUEUED_LIMIT = 20;

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

      const reply = completionReply(normalized);
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

function completionReply(completion: CreativeCompletion): CreatorTelegramReply {
  return completion.status === "COMPLETED"
    ? { text: "Creative draft ready. Check /mywork to review it." }
    : {
        text: "Creative draft could not be completed. Check /mywork to retry.",
      };
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
