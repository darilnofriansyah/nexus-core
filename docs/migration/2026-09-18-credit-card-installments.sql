CREATE TABLE public.credit_card_installment_plans (
  id bigserial PRIMARY KEY,
  transaction_id bigint NOT NULL UNIQUE REFERENCES public.transactions(id) ON DELETE RESTRICT,
  principal bigint NOT NULL CHECK (principal BETWEEN 1 AND 9999999999999),
  tenor_months integer NOT NULL CHECK (tenor_months BETWEEN 1 AND 120),
  monthly_rate_units integer NOT NULL CHECK (monthly_rate_units BETWEEN 0 AND 1000000),
  first_due_date date NOT NULL,
  timezone text NOT NULL,
  merchant text NOT NULL,
  category text NOT NULL,
  pocket_id bigint REFERENCES public.budgets(id) ON DELETE SET NULL,
  original_updated_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.credit_card_installments (
  id bigserial PRIMARY KEY,
  plan_id bigint NOT NULL REFERENCES public.credit_card_installment_plans(id) ON DELETE RESTRICT,
  sequence integer NOT NULL CHECK (sequence BETWEEN 1 AND 120),
  due_date date NOT NULL,
  principal bigint NOT NULL CHECK (principal BETWEEN 1 AND 9999999999999),
  interest bigint NOT NULL CHECK (interest BETWEEN 0 AND 9999999999999),
  interest_transaction_id bigint UNIQUE REFERENCES public.transactions(id) ON DELETE RESTRICT,
  UNIQUE (plan_id, sequence)
);

CREATE INDEX credit_card_installments_unposted_due
  ON public.credit_card_installments (due_date, id)
  WHERE interest_transaction_id IS NULL AND interest > 0;
