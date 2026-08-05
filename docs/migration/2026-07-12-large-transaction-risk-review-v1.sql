ALTER TABLE public.transaction_risk_reviews
  DROP CONSTRAINT IF EXISTS transaction_risk_reviews_user_response_check,
  ADD CONSTRAINT transaction_risk_reviews_user_response_check
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
  ) NOT VALID;

ALTER TABLE public.transaction_risk_reviews
  VALIDATE CONSTRAINT transaction_risk_reviews_user_response_check;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_transaction_risk_reviews_risk_type
ON public.transaction_risk_reviews (risk_type);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_transaction_risk_reviews_fingerprint
ON public.transaction_risk_reviews ((risk_metrics->>'evaluationFingerprint'))
WHERE risk_type = 'large_transaction';
