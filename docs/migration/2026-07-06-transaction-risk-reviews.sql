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
        'impulse',
        'wrong_category',
        'note_added',
        'ignored'
      )
    )
);

CREATE INDEX idx_transaction_risk_reviews_user_created
ON public.transaction_risk_reviews (user_id, created_at DESC);

CREATE INDEX idx_transaction_risk_reviews_transaction
ON public.transaction_risk_reviews (transaction_id);

CREATE INDEX idx_transaction_risk_reviews_status
ON public.transaction_risk_reviews (status);

CREATE INDEX idx_transaction_risk_reviews_user_status
ON public.transaction_risk_reviews (user_id, status);

CREATE UNIQUE INDEX transaction_risk_reviews_unique_pending
ON public.transaction_risk_reviews (transaction_id, risk_type)
WHERE status = 'pending';
