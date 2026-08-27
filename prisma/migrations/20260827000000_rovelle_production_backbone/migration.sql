-- CreateEnum
CREATE TYPE "RovelleEpisodeStatus" AS ENUM ('DRAFT', 'BRIEF_APPROVED', 'PREPRODUCTION', 'READY_TO_GENERATE', 'GENERATING', 'REVIEW_REQUIRED', 'GENERATION_APPROVED', 'RENDERING', 'FINAL_REVIEW', 'PUBLISH_READY', 'PUBLISHING', 'PUBLISHED', 'PAUSED', 'CANCELLED', 'FAILED');

-- CreateEnum
CREATE TYPE "RovelleShotStatus" AS ENUM ('DRAFT', 'READY_TO_GENERATE', 'GENERATING', 'REVIEW_REQUIRED', 'APPROVED', 'FAILED', 'CANCELLED');

-- CreateTable
CREATE TABLE "rovelle_episodes" (
    "id" UUID NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "status" "RovelleEpisodeStatus" NOT NULL DEFAULT 'DRAFT',
    "brief_json" JSONB,
    "target_duration_seconds" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "rovelle_episodes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rovelle_shots" (
    "id" UUID NOT NULL,
    "episode_id" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "name" VARCHAR(120),
    "direction" TEXT NOT NULL,
    "target_duration_seconds" INTEGER,
    "status" "RovelleShotStatus" NOT NULL DEFAULT 'DRAFT',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "rovelle_shots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "rovelle_episodes_code_key" ON "rovelle_episodes"("code");

-- CreateIndex
CREATE INDEX "rovelle_episodes_status_idx" ON "rovelle_episodes"("status");

-- CreateIndex
CREATE INDEX "rovelle_shots_episode_id_status_idx" ON "rovelle_shots"("episode_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "rovelle_shots_episode_id_sequence_key" ON "rovelle_shots"("episode_id", "sequence");

-- AddForeignKey
ALTER TABLE "rovelle_shots" ADD CONSTRAINT "rovelle_shots_episode_id_fkey" FOREIGN KEY ("episode_id") REFERENCES "rovelle_episodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
