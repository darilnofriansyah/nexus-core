-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "budget_alerts" (
    "id" BIGSERIAL NOT NULL,
    "budget_id" BIGINT NOT NULL,
    "alert_type" VARCHAR(50) NOT NULL,
    "threshold_percent" INTEGER NOT NULL,
    "triggered_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "period_key" VARCHAR(20) NOT NULL,

    CONSTRAINT "budget_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "budgets" (
    "id" BIGSERIAL NOT NULL,
    "user_id" BIGINT NOT NULL,
    "parent_budget_id" BIGINT,
    "category" TEXT NOT NULL,
    "amount" DECIMAL(15,2),
    "period_type" VARCHAR(20) NOT NULL DEFAULT 'monthly',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "is_default" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "budgets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "categories" (
    "id" BIGSERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "user_id" BIGINT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "category_rules" (
    "id" BIGSERIAL NOT NULL,
    "user_id" BIGINT,
    "priority" INTEGER DEFAULT 100,
    "merchant_pattern" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "transaction_type" VARCHAR(20),
    "is_active" BOOLEAN DEFAULT true,
    "created_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "category_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversation_states" (
    "id" BIGSERIAL NOT NULL,
    "user_id" BIGINT NOT NULL,
    "state_name" TEXT NOT NULL,
    "state_data" JSONB,
    "expires_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversation_states_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_card_cycle_summaries" (
    "id" BIGSERIAL NOT NULL,
    "user_id" BIGINT NOT NULL,
    "cycle_start" DATE NOT NULL,
    "credit_limit" BIGINT NOT NULL,
    "credit_used" BIGINT NOT NULL,
    "statement_balance" BIGINT NOT NULL,

    CONSTRAINT "credit_card_cycle_summaries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_parse_attempts" (
    "id" BIGSERIAL NOT NULL,
    "user_id" BIGINT NOT NULL,
    "source_reference" TEXT NOT NULL,
    "provider" TEXT,
    "template_key" TEXT,
    "status" TEXT NOT NULL,
    "sender" TEXT,
    "subject" TEXT,
    "email_date" TIMESTAMPTZ(6),
    "parsed_payload" JSONB,
    "error_reason" TEXT,
    "body_sample" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_parse_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_parser_templates" (
    "id" BIGSERIAL NOT NULL,
    "user_id" BIGINT NOT NULL,
    "provider" TEXT NOT NULL,
    "sender_address" TEXT NOT NULL,
    "template_key" TEXT NOT NULL,
    "template_version" INTEGER NOT NULL DEFAULT 1,
    "fingerprint" TEXT NOT NULL,
    "rules" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "last_matched_at" TIMESTAMPTZ(6),
    "disabled_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_parser_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "merchant_aliases" (
    "id" BIGSERIAL NOT NULL,
    "alias_name" TEXT NOT NULL,
    "canonical_name" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "merchant_aliases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "merchant_review_queue" (
    "id" BIGSERIAL NOT NULL,
    "merchant_name" TEXT NOT NULL,
    "suggested_category" TEXT,
    "confidence" INTEGER,
    "occurrence_count" INTEGER DEFAULT 1,
    "status" VARCHAR(20) DEFAULT 'pending',
    "reviewed_category" TEXT,
    "reviewed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "suggested_merchant_name" TEXT,

    CONSTRAINT "merchant_review_queue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "telegram_users" (
    "id" BIGSERIAL NOT NULL,
    "telegram_id" BIGINT NOT NULL,
    "username" TEXT,
    "first_name" TEXT,
    "last_name" TEXT,
    "timezone" TEXT DEFAULT 'Asia/Jakarta',
    "currency_code" VARCHAR(3) DEFAULT 'IDR',
    "is_active" BOOLEAN DEFAULT true,
    "created_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "cycle_start_day" INTEGER DEFAULT 1,

    CONSTRAINT "telegram_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transaction_imports" (
    "id" BIGSERIAL NOT NULL,
    "user_id" BIGINT NOT NULL,
    "source" TEXT NOT NULL,
    "source_reference" TEXT NOT NULL,
    "transaction_id" BIGINT,
    "status" TEXT NOT NULL,
    "raw_payload" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transaction_imports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transaction_risk_reviews" (
    "id" BIGSERIAL NOT NULL,
    "user_id" BIGINT NOT NULL,
    "transaction_id" BIGINT NOT NULL,
    "risk_type" TEXT NOT NULL,
    "risk_level" TEXT NOT NULL,
    "risk_score" DECIMAL(5,2),
    "risk_reasons" JSONB NOT NULL DEFAULT '[]',
    "risk_metrics" JSONB NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "user_response" TEXT,
    "note" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMPTZ(6),

    CONSTRAINT "transaction_risk_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transactions" (
    "id" BIGSERIAL NOT NULL,
    "user_id" BIGINT NOT NULL,
    "transaction_type" VARCHAR(20) NOT NULL,
    "amount" DECIMAL(15,2) NOT NULL,
    "merchant" TEXT,
    "merchant_normalized" TEXT,
    "category" TEXT NOT NULL,
    "transaction_date" TIMESTAMPTZ(6) NOT NULL,
    "source" VARCHAR(30) NOT NULL,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "status" VARCHAR(20) NOT NULL DEFAULT 'confirmed',
    "confidence" INTEGER,
    "raw_payload" JSONB,
    "pocket_id" BIGINT,

    CONSTRAINT "transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transactions_import" (
    "id" INTEGER,
    "telegram_user_id" BIGINT,
    "type" TEXT,
    "amount" INTEGER,
    "merchant" TEXT,
    "category" TEXT,
    "wallet" TEXT,
    "notes" TEXT,
    "created_at" TIMESTAMP(6)
);

-- CreateIndex
CREATE INDEX "idx_budget_alerts_lookup" ON "budget_alerts"("budget_id", "alert_type", "period_key");

-- CreateIndex
CREATE UNIQUE INDEX "budget_alerts_budget_id_alert_type_period_key_key" ON "budget_alerts"("budget_id", "alert_type", "period_key");

-- CreateIndex
CREATE UNIQUE INDEX "budgets_unique_default_active_top_level_per_user" ON "budgets"("user_id") WHERE (is_default AND is_active AND (parent_budget_id IS NULL));

-- CreateIndex
CREATE INDEX "idx_budgets_user" ON "budgets"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "conversation_states_user_id_key" ON "conversation_states"("user_id");

-- CreateIndex
CREATE INDEX "idx_conversation_states_user" ON "conversation_states"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "credit_card_cycle_summaries_user_id_cycle_start_key" ON "credit_card_cycle_summaries"("user_id", "cycle_start");

-- CreateIndex
CREATE UNIQUE INDEX "email_parse_attempts_user_id_source_reference_key" ON "email_parse_attempts"("user_id", "source_reference");

-- CreateIndex
CREATE UNIQUE INDEX "email_parser_templates_user_id_fingerprint_key" ON "email_parser_templates"("user_id", "fingerprint");

-- CreateIndex
CREATE UNIQUE INDEX "merchant_aliases_alias_name_key" ON "merchant_aliases"("alias_name");

-- CreateIndex
CREATE UNIQUE INDEX "merchant_review_queue_merchant_name_unique" ON "merchant_review_queue"("merchant_name");

-- CreateIndex
CREATE UNIQUE INDEX "telegram_users_telegram_id_key" ON "telegram_users"("telegram_id");

-- CreateIndex
CREATE UNIQUE INDEX "transaction_imports_user_id_source_source_reference_key" ON "transaction_imports"("user_id", "source", "source_reference");

-- CreateIndex
CREATE INDEX "idx_transaction_risk_reviews_risk_type" ON "transaction_risk_reviews"("risk_type");

-- CreateIndex
CREATE INDEX "idx_transaction_risk_reviews_status" ON "transaction_risk_reviews"("status");

-- CreateIndex
CREATE INDEX "idx_transaction_risk_reviews_transaction" ON "transaction_risk_reviews"("transaction_id");

-- CreateIndex
CREATE INDEX "idx_transaction_risk_reviews_user_created" ON "transaction_risk_reviews"("user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "idx_transaction_risk_reviews_user_status" ON "transaction_risk_reviews"("user_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "transaction_risk_reviews_unique_pending" ON "transaction_risk_reviews"("transaction_id", "risk_type") WHERE (status = 'pending'::text);

-- CreateIndex
CREATE INDEX "idx_transactions_budget_lookup" ON "transactions"("user_id", "category", "transaction_date");

-- CreateIndex
CREATE INDEX "idx_transactions_category" ON "transactions"("category");

-- CreateIndex
CREATE INDEX "idx_transactions_status" ON "transactions"("status");

-- CreateIndex
CREATE INDEX "idx_transactions_user_date" ON "transactions"("user_id", "transaction_date" DESC);

-- CreateIndex
CREATE INDEX "idx_transactions_user_pocket_date" ON "transactions"("user_id", "pocket_id", "transaction_date");

-- AddForeignKey
ALTER TABLE "budget_alerts" ADD CONSTRAINT "budget_alerts_budget_id_fkey" FOREIGN KEY ("budget_id") REFERENCES "budgets"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_parent_budget_id_fkey" FOREIGN KEY ("parent_budget_id") REFERENCES "budgets"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "telegram_users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "categories" ADD CONSTRAINT "categories_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "telegram_users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "category_rules" ADD CONSTRAINT "category_rules_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "telegram_users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "conversation_states" ADD CONSTRAINT "conversation_states_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "telegram_users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "credit_card_cycle_summaries" ADD CONSTRAINT "credit_card_cycle_summaries_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "telegram_users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "email_parse_attempts" ADD CONSTRAINT "email_parse_attempts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "telegram_users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "email_parser_templates" ADD CONSTRAINT "email_parser_templates_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "telegram_users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "transaction_imports" ADD CONSTRAINT "transaction_imports_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "transactions"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "transaction_imports" ADD CONSTRAINT "transaction_imports_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "telegram_users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "transaction_risk_reviews" ADD CONSTRAINT "transaction_risk_reviews_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "transactions"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "transaction_risk_reviews" ADD CONSTRAINT "transaction_risk_reviews_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "telegram_users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_pocket_id_fkey" FOREIGN KEY ("pocket_id") REFERENCES "budgets"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "telegram_users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
