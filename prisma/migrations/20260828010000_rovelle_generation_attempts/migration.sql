-- CreateEnum
CREATE TYPE "RovelleGenerationProvider" AS ENUM ('RUNWARE');

-- CreateEnum
CREATE TYPE "RovelleGenerationModality" AS ENUM ('VIDEO');

-- CreateEnum
CREATE TYPE "RovelleGenerationProfile" AS ENUM ('DRAFT', 'PRODUCTION');

-- CreateEnum
CREATE TYPE "RovelleGenerationStatus" AS ENUM ('CREATED', 'SUBMITTED', 'SUBMISSION_FAILED', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateTable
CREATE TABLE "rovelle_shot_generations" (
    "id" UUID NOT NULL,
    "client_request_id" UUID NOT NULL,
    "shot_id" UUID NOT NULL,
    "attempt" INTEGER NOT NULL,
    "provider" "RovelleGenerationProvider" NOT NULL DEFAULT 'RUNWARE',
    "modality" "RovelleGenerationModality" NOT NULL DEFAULT 'VIDEO',
    "profile" "RovelleGenerationProfile" NOT NULL,
    "model" VARCHAR(200) NOT NULL,
    "provider_task_id" UUID NOT NULL,
    "prompt" TEXT NOT NULL,
    "request_json" JSONB NOT NULL,
    "status" "RovelleGenerationStatus" NOT NULL DEFAULT 'CREATED',
    "output_asset_id" UUID NOT NULL,
    "estimated_cost_usd" DECIMAL(12,6) NOT NULL,
    "pricing_source" VARCHAR(120) NOT NULL,
    "actual_cost_usd" DECIMAL(12,6),
    "error_code" VARCHAR(120),
    "error_message" TEXT,
    "submitted_at" TIMESTAMPTZ(6),
    "completed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "rovelle_shot_generations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "rovelle_shot_generations_client_request_id_key" ON "rovelle_shot_generations"("client_request_id");

-- CreateIndex
CREATE UNIQUE INDEX "rovelle_shot_generations_provider_task_id_key" ON "rovelle_shot_generations"("provider_task_id");

-- CreateIndex
CREATE UNIQUE INDEX "rovelle_shot_generations_output_asset_id_key" ON "rovelle_shot_generations"("output_asset_id");

-- CreateIndex
CREATE UNIQUE INDEX "rovelle_shot_generations_shot_id_attempt_key" ON "rovelle_shot_generations"("shot_id", "attempt");

-- CreateIndex
CREATE INDEX "rovelle_shot_generations_shot_id_status_idx" ON "rovelle_shot_generations"("shot_id", "status");

-- CreateIndex
CREATE INDEX "rovelle_shot_generations_status_created_at_idx" ON "rovelle_shot_generations"("status", "created_at");

-- AddForeignKey
ALTER TABLE "rovelle_shot_generations" ADD CONSTRAINT "rovelle_shot_generations_shot_id_fkey" FOREIGN KEY ("shot_id") REFERENCES "rovelle_shots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rovelle_shot_generations" ADD CONSTRAINT "rovelle_shot_generations_output_asset_id_fkey" FOREIGN KEY ("output_asset_id") REFERENCES "rovelle_assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
