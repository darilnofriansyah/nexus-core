import { randomBytes } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  statfs,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";

import {
  hashCreativeValue,
  normalizeCreativeCompletion,
  normalizeCreativeInput,
} from "../rovelle/creative/creative-validation";
import type {
  CreativeClaim,
  CreativeCompletion,
} from "../rovelle/creative/dto/creative.dto";
import { CODEX_WORKER_SPOOL_MAX_BYTES } from "./worker-config";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COMPLETED_RETENTION_MS = 24 * 60 * 60 * 1000;

export type SpoolState =
  | "accepted"
  | "claiming"
  | "started"
  | "completed"
  | "acknowledged"
  | "quarantined"
  | "not_claimed";

export interface SpoolRecord {
  version: 1;
  jobId: string;
  state: SpoolState;
  createdAt: string;
  updatedAt: string;
  claim?: Extract<CreativeClaim, { claimed: true }>;
  completionEnvelope?: {
    jobId: string;
    completion: CreativeCompletion;
  };
  deliveryAttempts: number;
  lastDeliveryAttemptAt: string | null;
  acknowledgedAt: string | null;
  quarantinedStatus: number | null;
}

export class SpoolCapacityError extends Error {
  constructor() {
    super("Codex worker spool capacity is unavailable");
    this.name = "SpoolCapacityError";
  }
}

export function validateJobId(value: string): string {
  if (!UUID_PATTERN.test(value)) throw new Error("Invalid creative job UUID");
  return value.toLowerCase();
}

export class CompletionStore {
  private initialized = false;
  private readonly locks = new Map<string, Promise<void>>();

  constructor(
    private readonly directory: string,
    private readonly maxBytes = CODEX_WORKER_SPOOL_MAX_BYTES,
  ) {}

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const directoryStat = await lstat(this.directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
      throw new Error("Codex worker spool path is not a private directory");
    }
    await chmod(this.directory, 0o700);
    const privateStat = await lstat(this.directory);
    if ((privateStat.mode & 0o777) !== 0o700) {
      throw new Error("Codex worker spool permissions are not private");
    }
    this.initialized = true;
  }

  async createAccepted(jobId: string, now = new Date()): Promise<boolean> {
    const id = validateJobId(jobId);
    await this.initialize();
    return this.withJobLock(id, async () => {
      if (await this.readUnlocked(id)) return false;
      const timestamp = now.toISOString();
      const record: SpoolRecord = {
        version: 1,
        jobId: id,
        state: "accepted",
        createdAt: timestamp,
        updatedAt: timestamp,
        deliveryAttempts: 0,
        lastDeliveryAttemptAt: null,
        acknowledgedAt: null,
        quarantinedStatus: null,
      };
      const serialized = JSON.stringify(record);
      await this.assertCapacity(Buffer.byteLength(serialized));
      await this.writeNew(id, serialized);
      return true;
    });
  }

  async markClaiming(jobId: string, now = new Date()): Promise<void> {
    await this.transition(jobId, now, (record) => {
      if (record.state !== "accepted") {
        throw new Error("Creative job is not awaiting a claim");
      }
      record.state = "claiming";
    });
  }

  async markNotClaimed(jobId: string, now = new Date()): Promise<void> {
    await this.transition(jobId, now, (record) => {
      if (record.state !== "claiming") {
        throw new Error("Creative job has no pending claim");
      }
      record.state = "not_claimed";
    });
  }

  async markStarted(
    jobId: string,
    claim: Extract<CreativeClaim, { claimed: true }>,
    now = new Date(),
  ): Promise<void> {
    const id = validateJobId(jobId);
    const normalizedClaim = this.normalizeClaim(id, claim);
    await this.transition(id, now, (record) => {
      if (record.state !== "claiming") {
        throw new Error("Creative job has no durable claim marker");
      }
      record.state = "started";
      record.claim = normalizedClaim;
    });
  }

  async markCompleted(
    jobId: string,
    completion: CreativeCompletion,
    now = new Date(),
  ): Promise<void> {
    const id = validateJobId(jobId);
    await this.transition(id, now, (record) => {
      if (record.state !== "started" || !record.claim) {
        throw new Error("Creative job has no durable execution marker");
      }
      const normalized = normalizeCreativeCompletion(
        completion,
        record.claim.input,
      );
      if (
        normalized.attemptToken !== record.claim.attemptToken ||
        normalized.inputHash !== record.claim.inputHash
      ) {
        throw new Error("Creative completion does not match the durable claim");
      }
      record.state = "completed";
      record.completionEnvelope = { jobId: id, completion: normalized };
      record.deliveryAttempts = 0;
      record.lastDeliveryAttemptAt = null;
    });
  }

  async markDeliveryAttempt(
    jobId: string,
    now = new Date(),
  ): Promise<SpoolRecord> {
    let updated: SpoolRecord | undefined;
    await this.transition(jobId, now, (record) => {
      if (record.state !== "completed" || !record.completionEnvelope) {
        throw new Error("Creative completion is not ready for delivery");
      }
      record.deliveryAttempts += 1;
      record.lastDeliveryAttemptAt = now.toISOString();
      updated = record;
    });
    if (!updated) throw new Error("Creative completion delivery marker failed");
    return updated;
  }

  async markAcknowledged(jobId: string, now = new Date()): Promise<void> {
    await this.transition(jobId, now, (record) => {
      if (record.state !== "completed" || !record.completionEnvelope) {
        throw new Error("Creative completion is not awaiting acknowledgement");
      }
      record.state = "acknowledged";
      record.acknowledgedAt = now.toISOString();
    });
  }

  async quarantine(
    jobId: string,
    status: number,
    now = new Date(),
  ): Promise<void> {
    await this.transition(jobId, now, (record) => {
      if (record.state !== "completed" || !record.completionEnvelope) {
        throw new Error("Creative completion is not available to quarantine");
      }
      record.state = "quarantined";
      record.quarantinedStatus = status;
    });
  }

  async get(jobId: string): Promise<SpoolRecord | null> {
    const id = validateJobId(jobId);
    await this.initialize();
    return this.readUnlocked(id);
  }

  async list(): Promise<SpoolRecord[]> {
    await this.initialize();
    const names = await readdir(this.directory);
    const records: SpoolRecord[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const id = validateJobId(name.slice(0, -5));
      const record = await this.readUnlocked(id);
      if (!record) throw new Error("Codex worker spool entry disappeared");
      records.push(record);
    }
    return records;
  }

  async cleanupAcknowledged(now = new Date()): Promise<number> {
    const cutoff = now.getTime() - COMPLETED_RETENTION_MS;
    const expired = (await this.list()).filter(
      (record) =>
        record.state === "acknowledged" &&
        record.acknowledgedAt !== null &&
        Date.parse(record.acknowledgedAt) <= cutoff,
    );
    for (const record of expired) {
      await this.withJobLock(record.jobId, async () => {
        const current = await this.readUnlocked(record.jobId);
        if (
          current?.state !== "acknowledged" ||
          current.acknowledgedAt !== record.acknowledgedAt
        ) {
          return;
        }
        await unlink(this.filePath(record.jobId));
        await this.syncDirectory();
      });
    }
    return expired.length;
  }

  private async transition(
    jobId: string,
    now: Date,
    change: (record: SpoolRecord) => void,
  ): Promise<void> {
    const id = validateJobId(jobId);
    await this.initialize();
    await this.withJobLock(id, async () => {
      const current = await this.readUnlocked(id);
      if (!current) throw new Error("Creative job is missing from the spool");
      const next = structuredClone(current);
      change(next);
      next.updatedAt = now.toISOString();
      await this.replaceRecord(id, next);
    });
  }

  private normalizeClaim(
    jobId: string,
    claim: Extract<CreativeClaim, { claimed: true }>,
  ): Extract<CreativeClaim, { claimed: true }> {
    if (
      !claim ||
      claim.claimed !== true ||
      claim.jobId !== jobId ||
      claim.task !== "STORYBOARD" ||
      typeof claim.attemptToken !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(claim.attemptToken) ||
      typeof claim.inputHash !== "string" ||
      !/^[a-f0-9]{64}$/.test(claim.inputHash) ||
      !Number.isFinite(Date.parse(claim.leaseExpiresAt))
    ) {
      throw new Error("Invalid creative claim for spool");
    }
    const input = normalizeCreativeInput(claim.input);
    if (hashCreativeValue(input) !== claim.inputHash) {
      throw new Error("Creative claim input hash is invalid");
    }
    return {
      claimed: true,
      jobId,
      task: "STORYBOARD",
      attemptToken: claim.attemptToken,
      inputHash: claim.inputHash,
      leaseExpiresAt: new Date(claim.leaseExpiresAt).toISOString(),
      input,
    };
  }

  private async readUnlocked(jobId: string): Promise<SpoolRecord | null> {
    const path = this.filePath(jobId);
    let fileStat;
    try {
      fileStat = await lstat(path);
    } catch (error) {
      if (isMissingFile(error)) return null;
      throw error;
    }
    if (
      !fileStat.isFile() ||
      fileStat.isSymbolicLink() ||
      (fileStat.mode & 0o777) !== 0o600
    ) {
      throw new Error("Codex worker spool entry is not a private file");
    }
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    return this.parseRecord(jobId, parsed);
  }

  private parseRecord(jobId: string, value: unknown): SpoolRecord {
    if (!isRecord(value)) throw new Error("Invalid Codex worker spool record");
    const states: readonly SpoolState[] = [
      "accepted",
      "claiming",
      "started",
      "completed",
      "acknowledged",
      "quarantined",
      "not_claimed",
    ];
    if (
      value.version !== 1 ||
      value.jobId !== jobId ||
      typeof value.state !== "string" ||
      !states.includes(value.state as SpoolState) ||
      typeof value.createdAt !== "string" ||
      !Number.isFinite(Date.parse(value.createdAt)) ||
      typeof value.updatedAt !== "string" ||
      !Number.isFinite(Date.parse(value.updatedAt)) ||
      !Number.isSafeInteger(value.deliveryAttempts) ||
      (value.deliveryAttempts as number) < 0 ||
      !(
        value.lastDeliveryAttemptAt === null ||
        typeof value.lastDeliveryAttemptAt === "string"
      ) ||
      !(
        value.acknowledgedAt === null ||
        typeof value.acknowledgedAt === "string"
      ) ||
      !(
        value.quarantinedStatus === null ||
        Number.isInteger(value.quarantinedStatus)
      )
    ) {
      throw new Error("Invalid Codex worker spool record");
    }

    const record = value as unknown as SpoolRecord;
    if (
      ["started", "completed", "acknowledged", "quarantined"].includes(
        record.state,
      )
    ) {
      if (!isRecord(value.claim)) throw new Error("Spool claim is missing");
      record.claim = this.normalizeClaim(jobId, value.claim as never);
    }
    if (["completed", "acknowledged", "quarantined"].includes(record.state)) {
      if (!record.claim) {
        throw new Error("Spool completion is missing");
      }

      // Older v1 records persisted the completion beside jobId.
      const legacyCompletion = value.completion;
      if (
        value.completionEnvelope !== undefined &&
        legacyCompletion !== undefined
      ) {
        throw new Error("Spool completion envelope is ambiguous");
      }
      const envelopeValue =
        value.completionEnvelope ??
        (legacyCompletion === undefined
          ? undefined
          : { jobId, completion: legacyCompletion });
      if (
        !isRecord(envelopeValue) ||
        Object.keys(envelopeValue).length !== 2 ||
        !Object.keys(envelopeValue).includes("jobId") ||
        !Object.keys(envelopeValue).includes("completion") ||
        envelopeValue.jobId !== jobId
      ) {
        throw new Error("Spool completion envelope is invalid");
      }
      const normalizedCompletion = normalizeCreativeCompletion(
        envelopeValue.completion,
        record.claim.input,
      );
      if (
        normalizedCompletion.attemptToken !== record.claim.attemptToken ||
        normalizedCompletion.inputHash !== record.claim.inputHash
      ) {
        throw new Error("Spool completion does not match its claim");
      }
      delete value.completion;
      record.completionEnvelope = { jobId, completion: normalizedCompletion };
    }
    if (
      record.state === "acknowledged" &&
      (typeof record.acknowledgedAt !== "string" ||
        !Number.isFinite(Date.parse(record.acknowledgedAt)))
    ) {
      throw new Error("Spool acknowledgement time is invalid");
    }
    return record;
  }

  private async replaceRecord(
    jobId: string,
    record: SpoolRecord,
  ): Promise<void> {
    const serialized = JSON.stringify(record);
    await this.assertCapacity(Buffer.byteLength(serialized));
    const temporaryPath = this.temporaryPath(jobId);
    const handle = await open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(serialized, "utf8");
      await handle.sync();
    } catch (error) {
      await handle.close();
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
    await handle.close();
    try {
      await rename(temporaryPath, this.filePath(jobId));
      await this.syncDirectory();
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }

  private async writeNew(jobId: string, serialized: string): Promise<void> {
    const temporaryPath = this.temporaryPath(jobId);
    const handle = await open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(serialized, "utf8");
      await handle.sync();
    } catch (error) {
      await handle.close();
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
    await handle.close();
    try {
      await link(temporaryPath, this.filePath(jobId));
      await unlink(temporaryPath);
      await this.syncDirectory();
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      if (isAlreadyExists(error)) return;
      throw error;
    }
  }

  private async assertCapacity(additionalBytes: number): Promise<void> {
    const names = await readdir(this.directory);
    let currentBytes = 0;
    for (const name of names) {
      const entry = await lstat(join(this.directory, name));
      if (entry.isSymbolicLink() || !entry.isFile()) {
        throw new Error("Codex worker spool contains an unsafe entry");
      }
      currentBytes += entry.size;
    }
    const filesystem = await statfs(this.directory);
    const freeBytes = filesystem.bavail * filesystem.bsize;
    if (
      currentBytes + additionalBytes > this.maxBytes ||
      freeBytes < additionalBytes
    ) {
      throw new SpoolCapacityError();
    }
  }

  private async syncDirectory(): Promise<void> {
    const handle = await open(this.directory, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private filePath(jobId: string): string {
    return join(this.directory, `${validateJobId(jobId)}.json`);
  }

  private temporaryPath(jobId: string): string {
    return join(
      this.directory,
      `.${validateJobId(jobId)}.${randomBytes(12).toString("hex")}.tmp`,
    );
  }

  private async withJobLock<T>(
    jobId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.locks.get(jobId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.locks.set(jobId, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.locks.get(jobId) === tail) this.locks.delete(jobId);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isMissingFile(error: unknown): boolean {
  return isNodeError(error) && error.code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return isNodeError(error) && error.code === "EEXIST";
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
