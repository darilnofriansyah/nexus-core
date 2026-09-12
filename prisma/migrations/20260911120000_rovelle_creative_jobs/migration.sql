CREATE TYPE "RovelleCreativeJobStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'OUTCOME_UNKNOWN');

CREATE TABLE "rovelle_creative_jobs" (
    "id" UUID NOT NULL,
    "creator_session_id" UUID NOT NULL,
    "telegram_user_id" VARCHAR(32) NOT NULL,
    "chat_id" VARCHAR(32) NOT NULL,
    "input_revision" INTEGER NOT NULL,
    "task" VARCHAR(32) NOT NULL,
    "input" JSONB NOT NULL,
    "input_hash" VARCHAR(64) NOT NULL,
    "status" "RovelleCreativeJobStatus" NOT NULL DEFAULT 'QUEUED',
    "attempt_token_hash" VARCHAR(64),
    "lease_expires_at" TIMESTAMPTZ(6),
    "result" JSONB,
    "completion_metadata" JSONB,
    "completion_response" JSONB,
    "completion_hash" VARCHAR(64),
    "failure_code" VARCHAR(64),
    "superseded_at" TIMESTAMPTZ(6),
    "episode_id" UUID,
    "approved_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rovelle_creative_jobs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "rovelle_telegram_receipts" (
    "id" UUID NOT NULL,
    "bot_id" VARCHAR(32) NOT NULL,
    "update_id" VARCHAR(32) NOT NULL,
    "telegram_user_id" VARCHAR(32) NOT NULL,
    "chat_id" VARCHAR(32) NOT NULL,
    "request_hash" VARCHAR(64) NOT NULL,
    "response" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rovelle_telegram_receipts_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "rovelle_creative_jobs"
  ADD CONSTRAINT "rovelle_creative_jobs_input_revision_check" CHECK ("input_revision" > 0),
  ADD CONSTRAINT "rovelle_creative_jobs_task_check" CHECK ("task" = 'STORYBOARD'),
  ADD CONSTRAINT "rovelle_creative_jobs_approval_coherence_check"
    CHECK (("approved_at" IS NULL AND "episode_id" IS NULL) OR ("approved_at" IS NOT NULL AND "episode_id" IS NOT NULL));

CREATE UNIQUE INDEX "rovelle_creative_jobs_creator_session_id_input_revision_key"
  ON "rovelle_creative_jobs"("creator_session_id", "input_revision");
CREATE UNIQUE INDEX "rovelle_creative_jobs_one_active_creator"
  ON "rovelle_creative_jobs"("telegram_user_id")
  WHERE "status" IN ('QUEUED', 'RUNNING', 'OUTCOME_UNKNOWN');
CREATE UNIQUE INDEX "rovelle_creative_jobs_episode_id_key"
  ON "rovelle_creative_jobs"("episode_id");
CREATE INDEX "rovelle_creative_jobs_status_created_at_id_idx"
  ON "rovelle_creative_jobs"("status", "created_at", "id");
CREATE INDEX "rovelle_creative_jobs_telegram_user_id_created_at_idx"
  ON "rovelle_creative_jobs"("telegram_user_id", "created_at");
CREATE UNIQUE INDEX "rovelle_telegram_receipts_bot_id_update_id_key"
  ON "rovelle_telegram_receipts"("bot_id", "update_id");

ALTER TABLE "rovelle_creative_jobs"
  ADD CONSTRAINT "rovelle_creative_jobs_creator_session_id_fkey"
  FOREIGN KEY ("creator_session_id") REFERENCES "rovelle_creator_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "rovelle_creative_jobs"
  ADD CONSTRAINT "rovelle_creative_jobs_episode_id_fkey"
  FOREIGN KEY ("episode_id") REFERENCES "rovelle_episodes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
