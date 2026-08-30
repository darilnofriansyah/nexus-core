-- CreateEnum
CREATE TYPE "RovelleRenderProfile" AS ENUM ('VERTICAL_SHORT_V1');

-- CreateEnum
CREATE TYPE "RovelleRenderStatus" AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "RovelleRenderJobStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED');

-- CreateTable
CREATE TABLE "rovelle_renders" (
    "id" UUID NOT NULL,
    "client_request_id" UUID NOT NULL,
    "episode_id" UUID NOT NULL,
    "attempt" INTEGER NOT NULL,
    "profile" "RovelleRenderProfile" NOT NULL DEFAULT 'VERTICAL_SHORT_V1',
    "status" "RovelleRenderStatus" NOT NULL DEFAULT 'QUEUED',
    "spec_version" INTEGER NOT NULL DEFAULT 1,
    "spec_json" JSONB NOT NULL,
    "spec_hash" CHAR(64) NOT NULL,
    "output_asset_id" UUID NOT NULL,
    "completed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "rovelle_renders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rovelle_render_jobs" (
    "id" UUID NOT NULL,
    "client_request_id" UUID NOT NULL,
    "render_id" UUID NOT NULL,
    "attempt" INTEGER NOT NULL,
    "status" "RovelleRenderJobStatus" NOT NULL DEFAULT 'QUEUED',
    "available_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "worker_id" VARCHAR(120),
    "lease_token" UUID,
    "claimed_at" TIMESTAMPTZ(6),
    "heartbeat_at" TIMESTAMPTZ(6),
    "lease_expires_at" TIMESTAMPTZ(6),
    "started_at" TIMESTAMPTZ(6),
    "finished_at" TIMESTAMPTZ(6),
    "error_code" VARCHAR(120),
    "error_message" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "rovelle_render_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "rovelle_renders_client_request_id_key" ON "rovelle_renders"("client_request_id");

-- CreateIndex
CREATE UNIQUE INDEX "rovelle_renders_output_asset_id_key" ON "rovelle_renders"("output_asset_id");

-- CreateIndex
CREATE INDEX "rovelle_renders_episode_id_status_idx" ON "rovelle_renders"("episode_id", "status");

-- CreateIndex
CREATE INDEX "rovelle_renders_status_created_at_idx" ON "rovelle_renders"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "rovelle_renders_episode_id_attempt_key" ON "rovelle_renders"("episode_id", "attempt");

-- CreateIndex
CREATE UNIQUE INDEX "rovelle_render_jobs_client_request_id_key" ON "rovelle_render_jobs"("client_request_id");

-- CreateIndex
CREATE INDEX "rovelle_render_jobs_status_available_at_created_at_idx" ON "rovelle_render_jobs"("status", "available_at", "created_at");

-- CreateIndex
CREATE INDEX "rovelle_render_jobs_render_id_status_idx" ON "rovelle_render_jobs"("render_id", "status");

-- CreateIndex
CREATE INDEX "rovelle_render_jobs_lease_expires_at_idx" ON "rovelle_render_jobs"("lease_expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "rovelle_render_jobs_render_id_attempt_key" ON "rovelle_render_jobs"("render_id", "attempt");

-- AddForeignKey
ALTER TABLE "rovelle_renders" ADD CONSTRAINT "rovelle_renders_episode_id_fkey" FOREIGN KEY ("episode_id") REFERENCES "rovelle_episodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rovelle_renders" ADD CONSTRAINT "rovelle_renders_output_asset_id_fkey" FOREIGN KEY ("output_asset_id") REFERENCES "rovelle_assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rovelle_render_jobs" ADD CONSTRAINT "rovelle_render_jobs_render_id_fkey" FOREIGN KEY ("render_id") REFERENCES "rovelle_renders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
