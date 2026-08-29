-- CreateEnum
CREATE TYPE "RovelleCanonEntityType" AS ENUM ('CHARACTER', 'ENVIRONMENT', 'STYLE');

-- CreateEnum
CREATE TYPE "RovelleCanonVersionStatus" AS ENUM ('DRAFT', 'LOCKED');

-- CreateTable
CREATE TABLE "rovelle_canon_entities" (
    "id" UUID NOT NULL,
    "code" VARCHAR(64) NOT NULL,
    "display_name" VARCHAR(120) NOT NULL,
    "entity_type" "RovelleCanonEntityType" NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "rovelle_canon_entities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rovelle_canon_versions" (
    "id" UUID NOT NULL,
    "entity_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "RovelleCanonVersionStatus" NOT NULL DEFAULT 'DRAFT',
    "definition_json" JSONB NOT NULL,
    "locked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "rovelle_canon_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rovelle_canon_assets" (
    "canon_version_id" UUID NOT NULL,
    "asset_id" UUID NOT NULL,
    "role" VARCHAR(64) NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rovelle_canon_assets_pkey" PRIMARY KEY ("canon_version_id","asset_id")
);

-- CreateTable
CREATE TABLE "rovelle_episode_canon_pins" (
    "episode_id" UUID NOT NULL,
    "canon_entity_id" UUID NOT NULL,
    "canon_version_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "rovelle_episode_canon_pins_pkey" PRIMARY KEY ("episode_id","canon_entity_id")
);

-- CreateTable
CREATE TABLE "rovelle_shot_canon_pins" (
    "shot_id" UUID NOT NULL,
    "canon_entity_id" UUID NOT NULL,
    "canon_version_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "rovelle_shot_canon_pins_pkey" PRIMARY KEY ("shot_id","canon_entity_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "rovelle_canon_entities_code_key" ON "rovelle_canon_entities"("code");

-- CreateIndex
CREATE INDEX "rovelle_canon_entities_entity_type_idx" ON "rovelle_canon_entities"("entity_type");

-- CreateIndex
CREATE INDEX "rovelle_canon_versions_entity_id_status_idx" ON "rovelle_canon_versions"("entity_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "rovelle_canon_versions_entity_id_version_key" ON "rovelle_canon_versions"("entity_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "rovelle_canon_versions_id_entity_id_key" ON "rovelle_canon_versions"("id", "entity_id");

-- CreateIndex
CREATE INDEX "rovelle_canon_assets_asset_id_idx" ON "rovelle_canon_assets"("asset_id");

-- CreateIndex
CREATE UNIQUE INDEX "rovelle_canon_assets_canon_version_id_role_sort_order_key" ON "rovelle_canon_assets"("canon_version_id", "role", "sort_order");

-- CreateIndex
CREATE INDEX "rovelle_episode_canon_pins_canon_version_id_idx" ON "rovelle_episode_canon_pins"("canon_version_id");

-- CreateIndex
CREATE INDEX "rovelle_shot_canon_pins_canon_version_id_idx" ON "rovelle_shot_canon_pins"("canon_version_id");

-- AddForeignKey
ALTER TABLE "rovelle_canon_versions" ADD CONSTRAINT "rovelle_canon_versions_entity_id_fkey" FOREIGN KEY ("entity_id") REFERENCES "rovelle_canon_entities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rovelle_canon_assets" ADD CONSTRAINT "rovelle_canon_assets_canon_version_id_fkey" FOREIGN KEY ("canon_version_id") REFERENCES "rovelle_canon_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rovelle_canon_assets" ADD CONSTRAINT "rovelle_canon_assets_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "rovelle_assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rovelle_episode_canon_pins" ADD CONSTRAINT "rovelle_episode_canon_pins_episode_id_fkey" FOREIGN KEY ("episode_id") REFERENCES "rovelle_episodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rovelle_episode_canon_pins" ADD CONSTRAINT "rovelle_episode_canon_pins_canon_entity_id_fkey" FOREIGN KEY ("canon_entity_id") REFERENCES "rovelle_canon_entities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rovelle_episode_canon_pins" ADD CONSTRAINT "rovelle_episode_canon_pins_canon_version_id_canon_entity_i_fkey" FOREIGN KEY ("canon_version_id", "canon_entity_id") REFERENCES "rovelle_canon_versions"("id", "entity_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rovelle_shot_canon_pins" ADD CONSTRAINT "rovelle_shot_canon_pins_shot_id_fkey" FOREIGN KEY ("shot_id") REFERENCES "rovelle_shots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rovelle_shot_canon_pins" ADD CONSTRAINT "rovelle_shot_canon_pins_canon_entity_id_fkey" FOREIGN KEY ("canon_entity_id") REFERENCES "rovelle_canon_entities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rovelle_shot_canon_pins" ADD CONSTRAINT "rovelle_shot_canon_pins_canon_version_id_canon_entity_id_fkey" FOREIGN KEY ("canon_version_id", "canon_entity_id") REFERENCES "rovelle_canon_versions"("id", "entity_id") ON DELETE RESTRICT ON UPDATE CASCADE;
