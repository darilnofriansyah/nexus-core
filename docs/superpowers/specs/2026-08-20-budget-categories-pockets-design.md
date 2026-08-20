# Budget Categories and Pockets Design

**Date:** 2026-08-20
**Status:** Approved

## Problem

Veyra currently treats transaction categories and budgets as one concept.
Production category buttons come from active leaf `budgets` rows, and
`catid:{budgetId}:{transactionId}` derives the saved transaction category from
that budget. A user therefore cannot save a one-time category under a parent
budget without first creating a child budget.

Example: a `Toys` expense should consume `Monthly Transactions`, even when no
`Toys` child budget exists.

## Goals

- Make user categories independent from pockets.
- Store both category and pocket assignment on each expense transaction.
- Let an expense consume a pocket without requiring a matching child budget.
- Preserve optional category caps inside a pocket.
- Save unknown categories as `Uncategorized`, then let the user review them.
- Give first-time users default categories and a renameable `Main Pocket`.
- Preserve existing PostgreSQL data, n8n orchestration, Telegram sending, and
  callback routing.
- Roll out in small, reversible slices without deployment.

## Non-goals

- New pocket hierarchy beyond the existing parent/child budget model.
- Automatic creation of arbitrary AI-suggested categories.
- Category renaming and historical category rewrites in the first rollout.
- Production n8n workflow edits, activation, deactivation, or deployment.
- Replacing Telegram triggers, callback routing, or message delivery in n8n.

## Domain Model

### Category

A category describes what a transaction was for. Categories belong to a user,
not a pocket. The same category may be used with any pocket.

`Uncategorized` is a reserved active category created for every user. Missing,
unknown, archived, or unconfirmed category suggestions resolve to
`Uncategorized` when a transaction is saved. AI and email processing never
create categories automatically.

### Pocket

A top-level `budgets` row is exposed as a pocket. Its existing `category`
column remains the stored pocket name to avoid a broad rename migration. A
pocket may have an amount or may be amount-less.

Each user has at most one default pocket. New users receive an amount-less
`Main Pocket`; users may rename it later without changing transaction links.

### Optional child budget

A child `budgets` row remains an optional category cap scoped to its parent
pocket. It never authorizes or blocks transaction saving.

For example, `Monthly Transactions + Dining = Rp1,000,000` measures only
`Dining` expenses assigned to `Monthly Transactions`. A `Toys` expense assigned
to the same pocket still saves and consumes the parent even without a `Toys`
child budget.

### Transaction

An expense transaction stores two independent facts:

- `transactions.category`: user-category name.
- `transactions.pocket_id`: top-level `budgets.id` selected for the expense.

There is no permanent category-to-pocket ownership relation. The transaction
is the normal link. A child budget is only an optional limit over the pair.

## Database Changes

All changes are additive during rollout.

### `categories`

Evolve the existing, currently unused category catalog:

- Add nullable `user_id bigint` referencing `telegram_users(id)` with
  `ON DELETE CASCADE`.
- Add `is_active boolean NOT NULL DEFAULT true`.
- Drop the current global `categories_name_key` constraint.
- Keep `user_id IS NULL` rows as default templates.
- Add case-insensitive unique indexes for template names and for
  `(user_id, name)` user rows.

Default templates initially mirror the existing production category options
and add `Uncategorized`:

`Food`, `Transport`, `Groceries`, `Bills`, `Health & Beauty`, `Shopping`,
`Entertainment`, `Transfer`, `Other`, and `Uncategorized`.

The schema migration inserts any missing template rows before first-use setup
can copy them.

### `budgets`

- Add `is_default boolean NOT NULL DEFAULT false`.
- Add a partial unique index allowing one default active top-level budget per
  user.
- Keep `category`, `amount`, `parent_budget_id`, `period_type`, and existing
  uniqueness rules unchanged during rollout.

Application validation must reject default selection for inactive, child, or
cross-user budgets.

### `transactions`

- Add nullable `pocket_id bigint` referencing `budgets(id)` with
  `ON DELETE SET NULL`.
- Add an index on `(user_id, pocket_id, transaction_date)`.

Application validation must verify that an assigned pocket is active,
top-level, and belongs to the transaction user. PostgreSQL cannot express all
three rules with the foreign key alone.

`pocket_id` stays nullable until legacy backfill and review finish.

## First-use Setup

Core performs setup idempotently before category listing, pocket listing, or
transaction persistence:

1. Copy missing `user_id IS NULL` category templates to the user using the
   case-insensitive unique index for conflict safety.
2. Ensure the user has active `Uncategorized`.
3. When no top-level budget exists, create amount-less `Main Pocket` and mark
   it default.
4. When exactly one top-level budget exists, mark it default.
5. When multiple top-level budgets exist and none is default, do not guess.
   An expense without explicit `pocketId` returns an awaiting-pocket response.

Concurrent setup calls must converge on one category row per name and at most
one default pocket.

## Transaction Flow

1. Preserve current parsing, confidence, pending-confirmation, and source
   behavior.
2. Run first-use setup before persistence.
3. Resolve `pocketId` from an explicit request value or the user's default.
4. Reject an explicit inactive, child, missing, or cross-user pocket.
5. If no explicit or default pocket can be resolved, keep the transaction
   pending and return `awaiting_pocket`; do not write a confirmed expense.
6. Resolve category by case-insensitive match against active user categories.
7. On save, replace missing or unmatched category with `Uncategorized`.
8. Persist the category and `pocket_id` together.
9. Include `Review Category` in the confirmation keyboard for
   `Uncategorized` transactions.
10. On later category review, update only the category, then rerun budget and
    risk evaluation.

Income keeps its existing nullable-category behavior and does not require a
pocket. Transfer and reversal behavior remains unchanged in the first slice.

## Category Review Compatibility

`POST /api/veyra/transactions/category-options` reads active user categories
instead of leaf budgets. Button labels contain category names only.

Keep the production callback envelope
`catid:{categoryId}:{transactionId}` so n8n callback routing need not change.
Core reinterprets the first identifier as a user-category ID and validates its
ownership before updating the transaction.

Unlike the current category callback, review must allow category changes on a
confirmed expense. It changes only category metadata, preserves confirmed
status, and reruns watchdog evaluation.

The existing callback parser, Telegram intake, and Telegram edit/send nodes
stay in n8n. Documentation must state the changed identifier semantics.

## Pocket and Category Operations

Add focused Core operations for n8n:

- List active user categories.
- Create a user category.
- Archive a user category except reserved `Uncategorized`.
- List active top-level pockets.
- Rename a pocket by ID.
- Set one top-level pocket as default.

Pocket rename uses its ID, so linked transactions need no updates. Category
rename is deferred because transactions currently store category text; users
may archive an old category and create a new one.

## Budget Calculations

All calculations continue to use confirmed expense transactions within the
user's financial cycle derived from `telegram_users.cycle_start_day`.

### Parent pocket

Parent spent amount is the sum of every confirmed expense whose
`transactions.pocket_id` equals the pocket ID. Category does not restrict the
parent total.

### Child category cap

Child spent amount is the sum of confirmed expenses whose:

- `pocket_id` equals the child row's `parent_budget_id`, and
- category matches the child row's category case-insensitively.

Parent amount remains the explicit parent amount when present. Existing
amount-less parent aggregation from child amounts remains compatible until a
separate product decision changes it.

### Watchdog

A confirmed expense evaluates:

- its assigned parent pocket when that pocket has an amount, and
- a matching active child category cap when one exists.

`Uncategorized` affects the parent pocket immediately but has no child cap.
Reclassification reruns evaluation so the matching child cap can alert.
Existing `budget_alerts` dedupe remains keyed by budget, alert type, and cycle.

## Legacy Migration

Backfill `transactions.pocket_id` only when assignment is unambiguous:

1. A category matching exactly one active child budget receives that child's
   parent pocket ID.
2. Otherwise, a category matching one active top-level budget receives that
   pocket ID.
3. Otherwise, a user with exactly one active top-level budget receives that
   pocket ID.
4. All remaining rows stay null for later user review.

During rollout, budget reads use `pocket_id` first. For null legacy rows only,
the existing category-based matching remains as a compatibility fallback.
Remove that fallback only after a residual-null audit and explicit approval.

No migration updates ambiguous rows, deletes budgets, or changes historical
category text.

## Errors and Validation

- Cross-user pocket or category ID: reject as not found/unauthorized without
  revealing another user's data.
- Child or inactive pocket selection: reject.
- Missing default with multiple pockets: return `awaiting_pocket`.
- Unknown category at save time: store `Uncategorized`; do not fail.
- Archived category callback: reject and leave transaction unchanged.
- Setup or persistence failure: do not partially confirm the transaction.

## API and n8n Contract Changes

Transaction create/handle contracts gain optional `pocketId`. Responses and
confirmation summaries gain `pocket_id` and `pocket_name` when assigned.

Each migrated endpoint must document an n8n HTTP Request payload. n8n keeps:

- Telegram and email triggers.
- Callback prefix routing.
- HTTP Request orchestration.
- Telegram sending and editing.
- Credentials and retry behavior.

Core owns category/pocket validation, default resolution, persistence, budget
math, and structured response payloads.

## Test Strategy

Minimum focused coverage:

- First-use setup creates defaults and one amount-less `Main Pocket`.
- Repeated and concurrent setup remains idempotent.
- Existing single top-level budget becomes default; multiple budgets do not
  receive a guessed default.
- `Toys` saves under `Monthly Transactions` without a `Toys` child budget.
- Unknown category saves as `Uncategorized` and requests review.
- Same category assigned to two pockets affects each independently.
- Parent pocket includes every assigned confirmed expense.
- Child cap includes only matching pocket and category.
- Pending, rejected, income, and cross-user rows do not affect pocket spend.
- Custom cycle start continues to bound all status and watchdog queries.
- Category callback validates user ownership and preserves n8n callback shape.
- Reclassification reruns child-cap evaluation.
- Legacy null-pocket fallback preserves current results.
- Backfill leaves ambiguous multi-pocket transactions null.

Repository tests cover parameterized SQL and backfill selection. Service tests
mock repositories and cover setup, resolution, validation, and error branches.
Controller tests cover request validation and public response shapes without
testing NestJS internals.

## Rollout Slices

1. Add schema migration, schema documentation, and migration tests.
2. Add user-category and pocket setup/list/manage operations.
3. Add optional pocket assignment to transaction persistence paths.
4. Decouple category options and callbacks from budgets.
5. Switch budget status and watchdog math to pocket assignment with legacy
   fallback.
6. Run the safe historical backfill and audit remaining null assignments.
7. Remove legacy fallback only under a later explicit approval.

Each slice updates focused tests and README n8n payloads. No slice deploys or
modifies production n8n workflows.
