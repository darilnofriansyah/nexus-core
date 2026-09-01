-- CreateEnum
CREATE TYPE "RovelleRenderReviewDecision" AS ENUM ('APPROVE', 'REJECT', 'RERENDER');

-- CreateTable
CREATE TABLE "rovelle_render_reviews" (
    "id" UUID NOT NULL,
    "client_request_id" UUID NOT NULL,
    "render_id" UUID NOT NULL,
    "reviewer_type" "RovelleReviewerType" NOT NULL DEFAULT 'HUMAN',
    "decision" "RovelleRenderReviewDecision" NOT NULL,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rovelle_render_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "rovelle_render_reviews_client_request_id_key" ON "rovelle_render_reviews"("client_request_id");

-- CreateIndex
CREATE INDEX "rovelle_render_reviews_render_id_created_at_idx" ON "rovelle_render_reviews"("render_id", "created_at");

-- CreateIndex
CREATE INDEX "rovelle_render_reviews_reviewer_type_decision_created_at_idx" ON "rovelle_render_reviews"("reviewer_type", "decision", "created_at");

-- AlterTable
ALTER TABLE "rovelle_episodes" ADD COLUMN "approved_render_id" UUID;

-- CreateIndex
CREATE UNIQUE INDEX "rovelle_episodes_approved_render_id_key" ON "rovelle_episodes"("approved_render_id");

-- AddForeignKey
ALTER TABLE "rovelle_episodes" ADD CONSTRAINT "rovelle_episodes_approved_render_id_fkey" FOREIGN KEY ("approved_render_id") REFERENCES "rovelle_renders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rovelle_render_reviews" ADD CONSTRAINT "rovelle_render_reviews_render_id_fkey" FOREIGN KEY ("render_id") REFERENCES "rovelle_renders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
