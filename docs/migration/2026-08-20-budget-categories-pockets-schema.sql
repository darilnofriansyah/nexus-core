-- Preflight; migration must stop if this returns rows. Resolve duplicates only
-- with explicit data approval.
-- SELECT lower(name), count(*)
-- FROM public.categories
-- WHERE user_id IS NULL
-- GROUP BY lower(name)
-- HAVING count(*) > 1;

ALTER TABLE public.categories
  ADD COLUMN user_id bigint NULL REFERENCES public.telegram_users(id) ON DELETE CASCADE,
  ADD COLUMN is_active boolean NOT NULL DEFAULT true;

ALTER TABLE public.categories DROP CONSTRAINT categories_name_key;

CREATE UNIQUE INDEX categories_unique_template_name_ci
  ON public.categories (lower(name))
  WHERE user_id IS NULL;

CREATE UNIQUE INDEX categories_unique_user_name_ci
  ON public.categories (user_id, lower(name))
  WHERE user_id IS NOT NULL;

INSERT INTO public.categories (name)
VALUES
  ('Food'), ('Transport'), ('Groceries'), ('Bills'),
  ('Health & Beauty'), ('Shopping'), ('Entertainment'),
  ('Transfer'), ('Other'), ('Uncategorized')
ON CONFLICT (lower(name)) WHERE user_id IS NULL DO NOTHING;

ALTER TABLE public.budgets
  ADD COLUMN is_default boolean NOT NULL DEFAULT false;

CREATE UNIQUE INDEX budgets_unique_default_active_top_level_per_user
  ON public.budgets (user_id)
  WHERE is_default AND is_active AND parent_budget_id IS NULL;

ALTER TABLE public.transactions
  ADD COLUMN pocket_id bigint NULL
  CONSTRAINT transactions_pocket_id_fkey
  REFERENCES public.budgets(id) ON DELETE SET NULL;

CREATE INDEX idx_transactions_user_pocket_date
  ON public.transactions (user_id, pocket_id, transaction_date);
