-- CreateEnum
CREATE TYPE "RovelleReviewerType" AS ENUM ('HUMAN', 'AI');

-- CreateEnum
CREATE TYPE "RovelleReviewDecision" AS ENUM ('APPROVE', 'REJECT', 'REGENERATE', 'RECOMMEND_APPROVE', 'RECOMMEND_REJECT');

-- AlterTable
ALTER TABLE "rovelle_episodes" ADD COLUMN "generation_budget_usd" DECIMAL(12,6);

-- AlterTable
ALTER TABLE "rovelle_shot_generations" ADD COLUMN "currency" CHAR(3) NOT NULL DEFAULT 'USD';

-- AlterTable
ALTER TABLE "rovelle_shots" ADD COLUMN "approved_generation_id" UUID;

-- CreateTable
CREATE TABLE "rovelle_reviews" (
    "id" UUID NOT NULL,
    "client_request_id" UUID NOT NULL,
    "generation_id" UUID NOT NULL,
    "reviewer_type" "RovelleReviewerType" NOT NULL DEFAULT 'HUMAN',
    "decision" "RovelleReviewDecision" NOT NULL,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rovelle_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "rovelle_shots_approved_generation_id_key" ON "rovelle_shots"("approved_generation_id");

-- CreateIndex
CREATE UNIQUE INDEX "rovelle_reviews_client_request_id_key" ON "rovelle_reviews"("client_request_id");

-- CreateIndex
CREATE INDEX "rovelle_reviews_generation_id_created_at_idx" ON "rovelle_reviews"("generation_id", "created_at");

-- CreateIndex
CREATE INDEX "rovelle_reviews_reviewer_type_decision_created_at_idx" ON "rovelle_reviews"("reviewer_type", "decision", "created_at");

-- AddForeignKey
ALTER TABLE "rovelle_reviews" ADD CONSTRAINT "rovelle_reviews_generation_id_fkey" FOREIGN KEY ("generation_id") REFERENCES "rovelle_shot_generations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rovelle_shots" ADD CONSTRAINT "rovelle_shots_approved_generation_id_fkey" FOREIGN KEY ("approved_generation_id") REFERENCES "rovelle_shot_generations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
