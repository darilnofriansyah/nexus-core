CREATE TABLE IF NOT EXISTS transaction_imports (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES telegram_users(id),
  source TEXT NOT NULL,
  source_reference TEXT NOT NULL,
  transaction_id BIGINT NULL REFERENCES transactions(id),
  status TEXT NOT NULL,
  raw_payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, source, source_reference)
);

CREATE TABLE IF NOT EXISTS email_parse_attempts (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES telegram_users(id),
  source_reference TEXT NOT NULL,
  provider TEXT NULL,
  template_key TEXT NULL,
  status TEXT NOT NULL,
  sender TEXT NULL,
  subject TEXT NULL,
  email_date TIMESTAMPTZ NULL,
  parsed_payload JSONB NULL,
  error_reason TEXT NULL,
  body_sample TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, source_reference)
);
