CREATE TABLE IF NOT EXISTS email_parser_templates (
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

CREATE INDEX IF NOT EXISTS idx_email_parser_templates_active_sender
ON email_parser_templates (user_id, lower(sender_address))
WHERE status = 'active';
