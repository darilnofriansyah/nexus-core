-- CreateEnum
CREATE TYPE "RovelleAssetType" AS ENUM ('SOURCE', 'CHARACTER_REFERENCE', 'ENVIRONMENT_REFERENCE', 'STYLE_REFERENCE', 'AUDIO_MASTER', 'STORYBOARD', 'GENERATION', 'RENDER', 'THUMBNAIL', 'CAPTION', 'PUBLISH_COPY');

-- CreateEnum
CREATE TYPE "RovelleAssetStatus" AS ENUM ('RESERVED', 'AVAILABLE');

-- CreateTable
CREATE TABLE "rovelle_assets" (
    "id" UUID NOT NULL,
    "episode_id" UUID,
    "asset_type" "RovelleAssetType" NOT NULL,
    "status" "RovelleAssetStatus" NOT NULL DEFAULT 'RESERVED',
    "media_type" VARCHAR(127) NOT NULL,
    "storage_key" VARCHAR(512) NOT NULL,
    "original_filename" VARCHAR(255),
    "byte_size" BIGINT,
    "etag" VARCHAR(128),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "rovelle_assets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "rovelle_assets_storage_key_key" ON "rovelle_assets"("storage_key");

-- CreateIndex
CREATE INDEX "rovelle_assets_episode_id_idx" ON "rovelle_assets"("episode_id");

-- CreateIndex
CREATE INDEX "rovelle_assets_asset_type_status_idx" ON "rovelle_assets"("asset_type", "status");

-- AddForeignKey
ALTER TABLE "rovelle_assets" ADD CONSTRAINT "rovelle_assets_episode_id_fkey" FOREIGN KEY ("episode_id") REFERENCES "rovelle_episodes"("id") ON DELETE SET NULL ON UPDATE CASCADE;
