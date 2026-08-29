import { Injectable } from "@nestjs/common";
import {
  Prisma,
  RovelleCanonEntity,
  RovelleCanonVersion,
  RovelleCanonVersionStatus,
} from "../../generated/prisma/client";
import { PrismaService } from "../../database/prisma.service";
import type { CanonVersionWithAssets as CanonVersionAggregate } from "./canon-mapper";
import type {
  AttachCanonAssetRequestDto,
  CreateCanonEntityRequestDto,
} from "./dto/canon.dto";

const includeVersions = {
  versions: { orderBy: { version: "desc" as const } },
} satisfies Prisma.RovelleCanonEntityInclude;

const includeVersion = {
  entity: true,
  assets: {
    orderBy: [
      { sortOrder: "asc" as const },
      { role: "asc" as const },
      { assetId: "asc" as const },
    ],
    include: { asset: true },
  },
} satisfies Prisma.RovelleCanonVersionInclude;

export type CanonEntityWithVersions = RovelleCanonEntity & {
  versions: RovelleCanonVersion[];
};

export type CanonVersionWithAssets = CanonVersionAggregate;

export type CreateDraftVersionResult =
  | { status: "created"; version: RovelleCanonVersion }
  | { status: "not_found" };

export type AttachCanonAssetResult =
  | { status: "attached"; version: CanonVersionWithAssets }
  | { status: "not_found" }
  | { status: "invalid_state" }
  | { status: "conflict" };

export type DetachCanonAssetResult =
  | { status: "detached"; version: CanonVersionWithAssets }
  | { status: "not_found" }
  | { status: "invalid_state" };

export type LockCanonVersionResult =
  | { status: "locked"; version: CanonVersionWithAssets }
  | { status: "not_found" }
  | { status: "invalid_state" }
  | { status: "no_assets" };

@Injectable()
export class CanonRepository {
  constructor(private readonly prisma: PrismaService) {}

  async createEntity(
    input: CreateCanonEntityRequestDto,
  ): Promise<RovelleCanonEntity> {
    return this.prisma.client.rovelleCanonEntity.create({
      data: {
        code: input.code,
        displayName: input.displayName,
        entityType: input.entityType,
        description: input.description,
      },
    });
  }

  async listEntities(): Promise<RovelleCanonEntity[]> {
    return this.prisma.client.rovelleCanonEntity.findMany({
      orderBy: { code: "asc" },
    });
  }

  async findEntity(id: string): Promise<CanonEntityWithVersions | null> {
    return this.prisma.client.rovelleCanonEntity.findUnique({
      where: { id },
      include: includeVersions,
    });
  }

  async findEntityByCode(
    code: string,
  ): Promise<CanonEntityWithVersions | null> {
    return this.prisma.client.rovelleCanonEntity.findUnique({
      where: { code },
      include: includeVersions,
    });
  }

  async createDraftVersion(
    entityId: string,
    definition: Record<string, unknown>,
  ): Promise<CreateDraftVersionResult> {
    return this.prisma.client.$transaction(
      async (tx) => {
        const entity = await tx.rovelleCanonEntity.findUnique({
          where: { id: entityId },
        });

        if (!entity) return { status: "not_found" };

        const latest = await tx.rovelleCanonVersion.aggregate({
          where: { entityId },
          _max: { version: true },
        });
        const version = (latest._max.version ?? 0) + 1;
        const created = await tx.rovelleCanonVersion.create({
          data: {
            entityId,
            version,
            definition: definition as Prisma.InputJsonValue,
          },
        });

        return { status: "created", version: created };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }

  async findVersion(id: string): Promise<CanonVersionWithAssets | null> {
    return this.prisma.client.rovelleCanonVersion.findUnique({
      where: { id },
      include: includeVersion,
    });
  }

  async updateDraftDefinition(
    id: string,
    definition: Record<string, unknown>,
  ): Promise<CanonVersionWithAssets | null> {
    const result = await this.prisma.client.rovelleCanonVersion.updateMany({
      where: { id, status: RovelleCanonVersionStatus.DRAFT },
      data: { definition: definition as Prisma.InputJsonValue },
    });

    return result.count === 1 ? this.findVersion(id) : null;
  }

  async attachAsset(
    versionId: string,
    request: AttachCanonAssetRequestDto,
  ): Promise<AttachCanonAssetResult> {
    try {
      return await this.prisma.client.$transaction(
        async (tx) => {
          const version = await tx.rovelleCanonVersion.findUnique({
            where: { id: versionId },
            include: { entity: { select: { entityType: true } } },
          });

          if (!version) return { status: "not_found" };
          if (version.status !== RovelleCanonVersionStatus.DRAFT) {
            return { status: "invalid_state" };
          }

          await tx.rovelleCanonAsset.create({
            data: {
              canonVersionId: versionId,
              assetId: request.assetId,
              role: request.role,
              sortOrder: request.sortOrder ?? 0,
            },
          });

          const attached = await tx.rovelleCanonVersion.findUnique({
            where: { id: versionId },
            include: includeVersion,
          });

          return attached
            ? { status: "attached", version: attached }
            : { status: "not_found" };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (error) {
      if (isUniqueConstraintError(error)) return { status: "conflict" };
      throw error;
    }
  }

  async detachAsset(
    versionId: string,
    assetId: string,
  ): Promise<DetachCanonAssetResult> {
    return this.prisma.client.$transaction(
      async (tx) => {
        const version = await tx.rovelleCanonVersion.findUnique({
          where: { id: versionId },
        });

        if (!version) return { status: "not_found" };
        if (version.status !== RovelleCanonVersionStatus.DRAFT) {
          return { status: "invalid_state" };
        }

        await tx.rovelleCanonAsset.deleteMany({
          where: { canonVersionId: versionId, assetId },
        });

        const detached = await tx.rovelleCanonVersion.findUnique({
          where: { id: versionId },
          include: includeVersion,
        });

        return detached
          ? { status: "detached", version: detached }
          : { status: "not_found" };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }

  async lockVersion(id: string): Promise<LockCanonVersionResult> {
    return this.prisma.client.$transaction(
      async (tx) => {
        const version = await tx.rovelleCanonVersion.findUnique({
          where: { id },
          include: { _count: { select: { assets: true } } },
        });

        if (!version) return { status: "not_found" };
        if (version.status !== RovelleCanonVersionStatus.DRAFT) {
          return { status: "invalid_state" };
        }
        if (version._count.assets === 0) return { status: "no_assets" };

        const locked = await tx.rovelleCanonVersion.updateMany({
          where: { id, status: RovelleCanonVersionStatus.DRAFT },
          data: {
            status: RovelleCanonVersionStatus.LOCKED,
            lockedAt: new Date(),
          },
        });

        if (locked.count !== 1) return { status: "invalid_state" };

        const reloaded = await tx.rovelleCanonVersion.findUnique({
          where: { id },
          include: includeVersion,
        });

        return reloaded
          ? { status: "locked", version: reloaded }
          : { status: "invalid_state" };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "P2002"
  );
}
