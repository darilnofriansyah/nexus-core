CREATE TABLE "rovelle_creator_sessions" (
    "id" UUID NOT NULL,
    "telegram_user_id" VARCHAR(32) NOT NULL,
    "step" VARCHAR(64) NOT NULL,
    "data" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "rovelle_creator_sessions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "rovelle_creator_sessions_telegram_user_id_key" ON "rovelle_creator_sessions"("telegram_user_id");
CREATE INDEX "rovelle_creator_sessions_telegram_user_id_updated_at_idx" ON "rovelle_creator_sessions"("telegram_user_id", "updated_at");

CREATE TABLE "rovelle_creator_actions" (
    "id" UUID NOT NULL,
    "token" VARCHAR(128) NOT NULL,
    "telegram_user_id" VARCHAR(32) NOT NULL,
    "kind" VARCHAR(64) NOT NULL,
    "payload" JSONB NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "consumed_at" TIMESTAMPTZ(6),
    "result" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "rovelle_creator_actions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "rovelle_creator_actions_token_key" ON "rovelle_creator_actions"("token");
CREATE INDEX "rovelle_creator_actions_telegram_user_id_expires_at_idx" ON "rovelle_creator_actions"("telegram_user_id", "expires_at");
CREATE INDEX "rovelle_creator_actions_expires_at_consumed_at_idx" ON "rovelle_creator_actions"("expires_at", "consumed_at");
