WITH active_child_matches AS (
  SELECT child.user_id, lower(child.category) AS category_key,
         min(child.parent_budget_id) AS pocket_id,
         count(*) AS match_count
  FROM public.budgets child
  JOIN public.budgets parent
    ON parent.id = child.parent_budget_id
   AND parent.user_id = child.user_id
   AND parent.parent_budget_id IS NULL
   AND parent.is_active = true
  WHERE child.parent_budget_id IS NOT NULL AND child.is_active = true
  GROUP BY child.user_id, lower(child.category)
), active_top_level_matches AS (
  SELECT user_id, lower(category) AS category_key, min(id) AS pocket_id,
         count(*) AS match_count
  FROM public.budgets
  WHERE parent_budget_id IS NULL AND is_active = true
  GROUP BY user_id, lower(category)
), single_active_pockets AS (
  SELECT user_id, min(id) AS pocket_id, count(*) AS match_count
  FROM public.budgets
  WHERE parent_budget_id IS NULL AND is_active = true
  GROUP BY user_id
), candidates AS (
  SELECT t.id,
         CASE
           WHEN COALESCE(child.match_count, 0) > 1 THEN NULL
           WHEN child.match_count = 1 THEN child.pocket_id
           WHEN COALESCE(top_level.match_count, 0) > 1 THEN NULL
           WHEN top_level.match_count = 1 THEN top_level.pocket_id
           WHEN single_pocket.match_count = 1 THEN single_pocket.pocket_id
         END AS pocket_id
  FROM public.transactions t
  LEFT JOIN active_child_matches child
    ON child.user_id = t.user_id AND child.category_key = lower(t.category)
  LEFT JOIN active_top_level_matches top_level
    ON top_level.user_id = t.user_id AND top_level.category_key = lower(t.category)
  LEFT JOIN single_active_pockets single_pocket ON single_pocket.user_id = t.user_id
  WHERE t.pocket_id IS NULL AND t.transaction_type = 'expense'
)
UPDATE public.transactions transaction
SET pocket_id = candidates.pocket_id
FROM candidates
WHERE transaction.id = candidates.id
  AND transaction.pocket_id IS NULL
  AND candidates.pocket_id IS NOT NULL;
