# Veyra Database Schema

This file is the source of truth for Core API database access.

Rules for Codex:

* Do not invent tables, columns, enum values, or relationships.
* Do not use a column unless it exists in this document or an actual migration/schema SQL file.
* If a required field is missing, stop and ask.
* Prefer this file over README examples when working with database logic.
* Budget calculations must count only `transactions.status = 'confirmed'`.
* Do not use legacy/old guessed schema names such as `budget_amount`, `telegram_user_id` on `conversation_states`, or `occurrences` on `merchant_review_queue`.

---

## public.categories

```sql
CREATE TABLE public.categories (
  id bigserial NOT NULL,
  "name" text NOT NULL,
  CONSTRAINT categories_name_key UNIQUE (name),
  CONSTRAINT categories_pkey PRIMARY KEY (id)
);
```

Columns:

* `id`
* `name`

---

## public.telegram_users

```sql
CREATE TABLE public.telegram_users (
  id bigserial NOT NULL,
  telegram_id int8 NOT NULL,
  username text NULL,
  first_name text NULL,
  last_name text NULL,
  timezone text DEFAULT 'Asia/Jakarta'::text NULL,
  currency_code varchar(3) DEFAULT 'IDR'::character varying NULL,
  is_active bool DEFAULT true NULL,
  created_at timestamptz DEFAULT now() NULL,
  updated_at timestamptz DEFAULT now() NULL,
  cycle_start_day int4 DEFAULT 1 NULL,
  CONSTRAINT telegram_users_pkey PRIMARY KEY (id),
  CONSTRAINT telegram_users_telegram_id_key UNIQUE (telegram_id),
  CONSTRAINT telegram_users_telegram_id_unique UNIQUE (telegram_id)
);
```

Important:

* `telegram_id` is `int8`, not text.
* `id` is the internal user ID used by most foreign keys.
* Monthly cycle logic uses `cycle_start_day`.

---

## public.transactions

```sql
CREATE TABLE public.transactions (
  id bigserial NOT NULL,
  user_id int8 NOT NULL,
  transaction_type varchar(20) NOT NULL,
  amount numeric(15, 2) NOT NULL,
  merchant text NULL,
  merchant_normalized text NULL,
  category text NULL,
  transaction_date timestamptz NOT NULL,
  "source" varchar(30) NOT NULL,
  notes text NULL,
  created_at timestamptz DEFAULT now() NULL,
  updated_at timestamptz DEFAULT now() NULL,
  status varchar(20) DEFAULT 'confirmed'::character varying NOT NULL,
  confidence int4 NULL,
  raw_payload jsonb NULL,
  CONSTRAINT transactions_pkey PRIMARY KEY (id),
  CONSTRAINT transactions_source_check CHECK (((source)::text = ANY ((ARRAY['telegram'::character varying, 'email'::character varying, 'manual'::character varying, 'import'::character varying])::text[]))),
  CONSTRAINT transactions_status_check CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'confirmed'::character varying, 'rejected'::character varying])::text[]))),
  CONSTRAINT transactions_transaction_type_check CHECK (((transaction_type)::text = ANY ((ARRAY['expense'::character varying, 'income'::character varying, 'transfer'::character varying, 'reversal'::character varying])::text[]))),
  CONSTRAINT transactions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.telegram_users(id) ON DELETE CASCADE
);
```

Indexes:

```sql
CREATE INDEX idx_transactions_budget_lookup ON public.transactions USING btree (user_id, category, transaction_date);
CREATE INDEX idx_transactions_category ON public.transactions USING btree (category);
CREATE INDEX idx_transactions_status ON public.transactions USING btree (status);
CREATE INDEX idx_transactions_user_date ON public.transactions USING btree (user_id, transaction_date DESC);
```

Allowed `transaction_type`:

* `expense`
* `income`
* `transfer`
* `reversal`

Income transactions may have null `merchant`, `merchant_normalized`, and
`category` values. Application validation still requires merchant and category
for expense transactions.

Allowed `source`:

* `telegram`
* `email`
* `manual`
* `import`

Allowed `status`:

* `pending`
* `confirmed`
* `rejected`

Important:

* `category` is required.
* Budget spend must only count rows where `status = 'confirmed'`.
* Pending and rejected transactions must not affect budget spend.
* Use `transaction_date` for period and cycle filtering.

---

## public.credit_card_cycle_summaries

```sql
CREATE TABLE public.credit_card_cycle_summaries (
  id bigserial NOT NULL,
  user_id bigint NOT NULL,
  cycle_start date NOT NULL,
  credit_limit bigint NOT NULL,
  credit_used bigint NOT NULL,
  statement_balance bigint NOT NULL,
  CONSTRAINT credit_card_cycle_summaries_pkey PRIMARY KEY (id),
  CONSTRAINT credit_card_cycle_summaries_user_id_cycle_start_key UNIQUE (user_id, cycle_start),
  CONSTRAINT credit_card_cycle_summaries_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.telegram_users(id) ON DELETE CASCADE,
  CONSTRAINT credit_card_cycle_summaries_credit_limit_check CHECK ((credit_limit >= 0) AND (credit_limit <= 9007199254740991)),
  CONSTRAINT credit_card_cycle_summaries_credit_used_check CHECK ((credit_used >= 0) AND (credit_used <= 9007199254740991)),
  CONSTRAINT credit_card_cycle_summaries_statement_balance_check CHECK ((statement_balance >= 0) AND (statement_balance <= 9007199254740991))
);
```

Important:

* One combined summary exists per `(user_id, cycle_start)`; do not model individual cards.
* `cycle_start` uses dashboard financial-cycle boundaries, not calendar months.
* Amounts are non-negative safe IDR integers. `statement_balance` is closed-cycle bill.

---

## public.budgets

```sql
CREATE TABLE public.budgets (
  id bigserial NOT NULL,
  user_id int8 NOT NULL,
  parent_budget_id int8 NULL,
  category text NOT NULL,
  amount numeric(15, 2) NULL,
  period_type varchar(20) DEFAULT 'monthly'::character varying NOT NULL,
  is_active bool DEFAULT true NOT NULL,
  created_at timestamptz DEFAULT now() NULL,
  CONSTRAINT budgets_period_type_check CHECK (((period_type)::text = ANY ((ARRAY['weekly'::character varying, 'monthly'::character varying, 'yearly'::character varying])::text[]))),
  CONSTRAINT budgets_pkey PRIMARY KEY (id),
  CONSTRAINT budgets_parent_budget_id_fkey FOREIGN KEY (parent_budget_id) REFERENCES public.budgets(id) ON DELETE SET NULL,
  CONSTRAINT budgets_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.telegram_users(id) ON DELETE CASCADE
);
```

Indexes:

```sql
CREATE UNIQUE INDEX budgets_unique_child_category_per_parent_per_user
ON public.budgets USING btree (user_id, parent_budget_id, lower(category))
WHERE (parent_budget_id IS NOT NULL);

CREATE UNIQUE INDEX budgets_unique_top_level_category_per_user
ON public.budgets USING btree (user_id, lower(category))
WHERE (parent_budget_id IS NULL);

CREATE INDEX idx_budgets_user ON public.budgets USING btree (user_id);
```

Allowed `period_type`:

* `weekly`
* `monthly`
* `yearly`

Important:

* Use `amount`, not `budget_amount`.
* Top-level budget: `parent_budget_id IS NULL`.
* Child/sub-budget: `parent_budget_id IS NOT NULL`.
* Top-level category uniqueness is scoped by `(user_id, lower(category))`.
* Child category uniqueness is scoped by `(user_id, parent_budget_id, lower(category))`.
* There is no `updated_at`, `start_date`, or `end_date` column in this current schema.

---

## public.budget_alerts

```sql
CREATE TABLE public.budget_alerts (
  id bigserial NOT NULL,
  budget_id int8 NOT NULL,
  alert_type varchar(50) NOT NULL,
  threshold_percent int4 NOT NULL,
  triggered_at timestamp DEFAULT now() NOT NULL,
  period_key varchar(20) NOT NULL,
  CONSTRAINT budget_alerts_budget_id_alert_type_period_key_key UNIQUE (budget_id, alert_type, period_key),
  CONSTRAINT budget_alerts_pkey PRIMARY KEY (id),
  CONSTRAINT budget_alerts_budget_id_fkey FOREIGN KEY (budget_id) REFERENCES public.budgets(id) ON DELETE CASCADE
);
```

Indexes:

```sql
CREATE INDEX idx_budget_alerts_lookup
ON public.budget_alerts USING btree (budget_id, alert_type, period_key);
```

Important:

* There is no `user_id` column on `budget_alerts`.
* User must be inferred through `budgets.user_id`.
* Alert uniqueness is `(budget_id, alert_type, period_key)`.
* `period_key` is `varchar(20)`.
* Use the agreed period key format consistently, preferably cycle start date like `YYYY-MM-DD`.

---

## public.conversation_states

```sql
CREATE TABLE public.conversation_states (
  id bigserial NOT NULL,
  user_id int8 NOT NULL,
  state_name text NOT NULL,
  state_data jsonb NULL,
  expires_at timestamptz NULL,
  created_at timestamptz DEFAULT now() NULL,
  updated_at timestamptz DEFAULT now() NULL,
  CONSTRAINT conversation_states_pkey PRIMARY KEY (id),
  CONSTRAINT conversation_states_user_id_key UNIQUE (user_id),
  CONSTRAINT conversation_states_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.telegram_users(id) ON DELETE CASCADE
);
```

Indexes:

```sql
CREATE INDEX idx_conversation_states_user
ON public.conversation_states USING btree (user_id);
```

Important:

* Use `user_id`, not `telegram_user_id`.
* Use `state_name`, not `state`.
* Use `state_data`, not `payload`.
* There is one active state row per user because of `UNIQUE (user_id)`.

---

## public.category_rules

```sql
CREATE TABLE public.category_rules (
  id bigserial NOT NULL,
  user_id int8 NULL,
  priority int4 DEFAULT 100 NULL,
  merchant_pattern text NOT NULL,
  category text NOT NULL,
  transaction_type varchar(20) NULL,
  is_active bool DEFAULT true NULL,
  created_at timestamptz DEFAULT now() NULL,
  CONSTRAINT category_rules_pkey PRIMARY KEY (id),
  CONSTRAINT category_rules_transaction_type_check CHECK (((transaction_type)::text = ANY ((ARRAY['expense'::character varying, 'income'::character varying, 'transfer'::character varying])::text[]))),
  CONSTRAINT category_rules_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.telegram_users(id) ON DELETE CASCADE
);
```

Allowed `transaction_type`:

* `expense`
* `income`
* `transfer`

Important:

* Use `merchant_pattern`, not `merchant_name`.
* Rules can be global if `user_id IS NULL`.
* Rules can be user-specific if `user_id` is set.
* Sort by `priority` when applying rules.

---

## public.merchant_aliases

```sql
CREATE TABLE public.merchant_aliases (
  id bigserial NOT NULL,
  alias_name text NOT NULL,
  canonical_name text NOT NULL,
  created_at timestamptz DEFAULT now() NULL,
  CONSTRAINT merchant_aliases_alias_name_key UNIQUE (alias_name),
  CONSTRAINT merchant_aliases_pkey PRIMARY KEY (id)
);
```

Important:

* There is no `user_id` column.
* Alias uniqueness is global by `alias_name`.

---

## public.merchant_review_queue

```sql
CREATE TABLE public.merchant_review_queue (
  id bigserial NOT NULL,
  merchant_name text NOT NULL,
  suggested_category text NULL,
  confidence int4 NULL,
  occurrence_count int4 DEFAULT 1 NULL,
  status varchar(20) DEFAULT 'pending'::character varying NULL,
  reviewed_category text NULL,
  reviewed_at timestamptz NULL,
  created_at timestamptz DEFAULT now() NULL,
  suggested_merchant_name text NULL,
  CONSTRAINT merchant_review_queue_merchant_name_unique UNIQUE (merchant_name),
  CONSTRAINT merchant_review_queue_pkey PRIMARY KEY (id),
  CONSTRAINT merchant_review_queue_status_check CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'approved'::character varying, 'rejected'::character varying])::text[])))
);
```

Allowed `status`:

* `pending`
* `approved`
* `rejected`

Important:

* Use `occurrence_count`, not `occurrences`.
* There is no `user_id` column.
* Merchant uniqueness is global by `merchant_name`.

---

## public.email_parse_attempts

```sql
CREATE TABLE public.email_parse_attempts (
  id bigserial NOT NULL,
  user_id int8 NOT NULL,
  source_reference text NOT NULL,
  provider text NULL,
  template_key text NULL,
  status text NOT NULL,
  sender text NULL,
  subject text NULL,
  email_date timestamptz NULL,
  parsed_payload jsonb NULL,
  error_reason text NULL,
  body_sample text NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT email_parse_attempts_pkey PRIMARY KEY (id),
  CONSTRAINT email_parse_attempts_user_id_source_reference_key UNIQUE (user_id, source_reference),
  CONSTRAINT email_parse_attempts_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.telegram_users(id)
);
```

Important:

* Use this for idempotency/debugging of email parsing attempts.
* Unique key is `(user_id, source_reference)`.

---

## public.transaction_imports

```sql
CREATE TABLE public.transaction_imports (
  id bigserial NOT NULL,
  user_id int8 NOT NULL,
  "source" text NOT NULL,
  source_reference text NOT NULL,
  transaction_id int8 NULL,
  status text NOT NULL,
  raw_payload jsonb NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT transaction_imports_pkey PRIMARY KEY (id),
  CONSTRAINT transaction_imports_user_id_source_source_reference_key UNIQUE (user_id, source, source_reference),
  CONSTRAINT transaction_imports_transaction_id_fkey FOREIGN KEY (transaction_id) REFERENCES public.transactions(id),
  CONSTRAINT transaction_imports_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.telegram_users(id)
);
```

Important:

* Use this for import/email idempotency.
* Unique key is `(user_id, source, source_reference)`.
* `transaction_id` can be null if the import attempt did not create a transaction.

---

## public.transactions_import

Legacy/import staging table.

```sql
CREATE TABLE public.transactions_import (
  id int4 NULL,
  telegram_user_id int8 NULL,
  "type" text NULL,
  amount int4 NULL,
  merchant text NULL,
  category text NULL,
  wallet text NULL,
  notes text NULL,
  created_at timestamp NULL
);
```

Important:

* Treat this as legacy/staging unless a task explicitly says to use it.
* Do not confuse this with `transaction_imports`.

---

## public.transaction_risk_reviews

```sql
CREATE TABLE public.transaction_risk_reviews (
  id bigserial PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES public.telegram_users(id) ON DELETE CASCADE,
  transaction_id bigint NOT NULL REFERENCES public.transactions(id) ON DELETE CASCADE,
  risk_type text NOT NULL,
  risk_level text NOT NULL,
  risk_score numeric(5, 2) NULL,
  risk_reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
  risk_metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending',
  user_response text NULL,
  note text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz NULL,
  CONSTRAINT transaction_risk_reviews_risk_level_check
    CHECK (risk_level IN ('low', 'medium', 'high', 'critical')),
  CONSTRAINT transaction_risk_reviews_status_check
    CHECK (status IN ('pending', 'resolved', 'ignored', 'cancelled')),
  CONSTRAINT transaction_risk_reviews_user_response_check
    CHECK (
      user_response IS NULL OR user_response IN (
        'planned',
        'necessary',
        'regret',
        'ignore',
        'impulse',
        'wrong_category',
        'note_added',
        'ignored'
      )
    )
);
```

Indexes:

```sql
CREATE INDEX idx_transaction_risk_reviews_user_created
ON public.transaction_risk_reviews (user_id, created_at DESC);

CREATE INDEX idx_transaction_risk_reviews_transaction
ON public.transaction_risk_reviews (transaction_id);

CREATE INDEX idx_transaction_risk_reviews_status
ON public.transaction_risk_reviews (status);

CREATE INDEX idx_transaction_risk_reviews_risk_type
ON public.transaction_risk_reviews (risk_type);

CREATE INDEX idx_transaction_risk_reviews_fingerprint
ON public.transaction_risk_reviews ((risk_metrics->>'evaluationFingerprint'))
WHERE risk_type = 'large_transaction';

CREATE INDEX idx_transaction_risk_reviews_user_status
ON public.transaction_risk_reviews (user_id, status);

CREATE UNIQUE INDEX transaction_risk_reviews_unique_pending
ON public.transaction_risk_reviews (transaction_id, risk_type)
WHERE status = 'pending';
```

Allowed `risk_level`:

* `low`
* `medium`
* `high`
* `critical`

Allowed `status`:

* `pending`
* `resolved`
* `ignored`
* `cancelled`

Allowed `user_response`:

* `planned`
* `necessary`
* `regret`
* `ignore`
* `impulse`
* `wrong_category`
* `note_added`
* `ignored`

Important:

* Large Transaction / Regret Detector v1 uses `risk_type = 'large_transaction'`.
* Trigger details belong in `risk_reasons`; numeric/context facts belong in `risk_metrics`.
* Pending review idempotency is `(transaction_id, risk_type) WHERE status = 'pending'`; v1 also stores `risk_metrics.evaluationFingerprint` to avoid repeated notifications for unchanged transaction state.
* `ignore` resolves only the current review as `status = 'resolved'` with `user_response = 'ignore'`; it does not suppress future alerts globally.

---

## public.email_parser_templates

```sql
CREATE TABLE public.email_parser_templates (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES telegram_users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  sender_address TEXT NOT NULL,
  template_key TEXT NOT NULL,
  template_version INTEGER NOT NULL DEFAULT 1,
  fingerprint TEXT NOT NULL,
  rules JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'disabled')),
  last_matched_at TIMESTAMPTZ NULL,
  disabled_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, fingerprint)
);
```

Indexes:

```sql
CREATE INDEX idx_email_parser_templates_active_sender
ON public.email_parser_templates (user_id, lower(sender_address))
WHERE status = 'active';
```

Important:

* One template fingerprint is unique per user: `(user_id, fingerprint)`.
* `rules` stores the validated `EmailParserTemplateProposalDto` JSON, not executable code.
* Only `active` templates are eligible for matching; disabling records `disabled_at`.
* Active template lookup is user-scoped and case-insensitive by `sender_address`.

---

# Common Hallucination Traps

Do not use these unless they are added to the actual schema later:

* `budgets.budget_amount`
* `budgets.updated_at`
* `budgets.start_date`
* `budgets.end_date`
* `budget_alerts.user_id`
* `conversation_states.telegram_user_id`
* `conversation_states.state`
* `conversation_states.payload`
* `category_rules.merchant_name`
* `merchant_aliases.user_id`
* `merchant_review_queue.user_id`
* `merchant_review_queue.occurrences`
* `pending_transactions`

# Source of Truth Priority

When working on database code, use this priority:

1. Actual migration/schema SQL files
2. `docs/veyra-database-schema.md`
3. Existing repository/service code
4. README endpoint examples

If these conflict, stop and mention the conflict before coding.
