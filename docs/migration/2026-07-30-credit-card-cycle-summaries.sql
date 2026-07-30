CREATE TABLE public.credit_card_cycle_summaries (
  id bigserial PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES public.telegram_users(id) ON DELETE CASCADE,
  cycle_start date NOT NULL,
  credit_limit bigint NOT NULL CHECK (credit_limit >= 0 AND credit_limit <= 9007199254740991),
  credit_used bigint NOT NULL CHECK (credit_used >= 0 AND credit_used <= 9007199254740991),
  statement_balance bigint NOT NULL CHECK (statement_balance >= 0 AND statement_balance <= 9007199254740991),
  UNIQUE (user_id, cycle_start)
);
