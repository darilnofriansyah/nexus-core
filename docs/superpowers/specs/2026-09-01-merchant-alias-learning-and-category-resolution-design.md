# Merchant Alias Learning and Category Resolution Design

## Goal

Stop repeatedly asking users to categorize email transactions from merchants
they have already confirmed, while preventing email expenses from being
automatically saved as `Uncategorized`.

## Scope

This design covers:

- recording unknown parsed merchants in `merchant_review_queue`;
- learning a global merchant alias after the first confirmed email transaction;
- learning from hard-coded, learned-template, and AI-parsed email transactions;
- resolving a user's preferred category from confirmed transaction history;
- handling merchants used with more than one category;
- preventing `Uncategorized` email expenses from auto-confirming;
- focused Core API tests and n8n integration documentation.

This design does not include:

- a database migration or new table;
- a new AI categorization call;
- a merchant-review administration UI;
- production database cleanup of existing `Uncategorized` transactions;
- Gmail triggers, Telegram sending, or callback routing moving out of n8n;
- production deployment or n8n workflow changes.

## Current Behavior and Root Causes

The deterministic email flow requires an entry in `merchant_aliases` before it
attempts category resolution. If the alias is absent, Core creates a pending
transaction with reason `merchant alias could not be resolved`.

Confirmed email learning already exists, but
`learnConfirmedEmailTransaction()` only accepts transactions whose
`raw_payload.parserSource` is `ai`. A normal BCA, Mandiri, or Krom transaction
that was made pending by the missing-alias guard therefore never teaches the
alias after the user categorizes it.

`merchant_review_queue` exists in the current schema, but Core does not read or
write it. The migration audit documents the old n8n normalizer as its only
producer.

The recent `Uncategorized` auto-save behavior has a separate, confirmed root
cause. `BudgetService.resolveExpenseAssignment()` returns
`needsCategoryReview: true` when a suggested category is absent or not an
active user category and normalizes it to `Uncategorized`. The deterministic
email auto-save branch checks only `assignment.status`; it ignores
`assignment.needsCategoryReview` and inserts the transaction as `confirmed`.
This behavior entered with commit `970f150` when pocket assignment was added to
email expenses. Its test currently asserts that an unknown category is saved as
`Uncategorized`, so the test encodes the regression.

## Design Principles

- Reuse existing tables and confirmed transaction data.
- Treat aliases as global because `merchant_aliases` has no `user_id`.
- Treat category preference as user-specific.
- Never learn from a pending or rejected transaction.
- Never auto-confirm an email expense whose category still needs review.
- Use deterministic history before considering AI.
- Never silently replace an existing global canonical alias.

## End-to-End Workflow

### 1. Parse and Resolve Merchant

n8n sends the existing email request to Core. Core deduplicates, parses, and
validates the email as it does today.

For a valid merchant, Core performs the existing longest matching alias lookup
against `merchant_aliases`.

If an alias exists, Core uses its `canonical_name` and proceeds to category
resolution.

If no alias exists, Core:

1. upserts the parsed merchant into `merchant_review_queue`;
2. increments `occurrence_count` for an existing case-insensitive match;
3. records the parser's suggested merchant, category, and confidence when
   available;
4. creates the existing pending email transaction;
5. returns `needs_review` with reason
   `merchant alias could not be resolved`.

The pending transaction retains the parsed merchant as both the displayed
merchant and the fallback normalized merchant. The user can edit the merchant
before confirmation. No alias or category preference is learned yet.

### 2. Resolve Category

After merchant normalization, Core queries the current user's confirmed
expense history for the canonical merchant. Matching uses a case-insensitive
comparison against `merchant_normalized`, falling back to `merchant` for older
rows whose normalized value is null or empty.

Only rows with all of the following count:

- the same `user_id`;
- `status = 'confirmed'`;
- `transaction_type = 'expense'`;
- a non-empty category;
- a category other than `Uncategorized`.

Core groups matches by case-insensitive category name and counts them.

Resolution rules are:

1. One category, or one unique highest count: use that category.
2. Equal highest counts: return a pending category review.
3. No confirmed history: use the existing user-scoped `category_rules`
   resolution.
4. No history or matching rule: return a pending category review.

A tie is not broken by recency or AI. The category buttons show tied historical
categories first, ordered alphabetically for stable output, followed by the
user's other active categories.

`category_rules` remains a fallback for compatibility. Confirmed transactions
are the source of frequency because they already record every merchant-category
relationship and require no separate counter.

### 3. Validate Category and Pocket Before Auto-Save

For a resolved email expense, Core calls the existing
`resolveExpenseAssignment()`.

Core may auto-confirm only when:

- the assignment status is `resolved`;
- `needsCategoryReview` is false;
- the returned category is not `Uncategorized`;
- the existing merchant, authentication, confidence, deduplication, amount,
  date, and transaction-type guards pass.

If `needsCategoryReview` is true or the returned category is
`Uncategorized`, Core creates a pending transaction with reason
`category must be selected before confirmation`. It retains the resolved
default pocket when available so the user only needs to choose a category.

If no default pocket can be resolved, the existing `awaiting_pocket` behavior
continues.

This guard belongs before `saveConfirmedEmailTransaction()` so no caller can
insert an auto-confirmed `Uncategorized` expense through this path.

### 4. User Confirmation and Learning

The existing Save and category-selection callbacks remain unchanged at the
n8n boundary.

After an email transaction wins the transition to `confirmed`, Core runs one
shared learning function for parser sources `hardcoded`, `learned`, and `ai`.
The existing stored-email content binding remains required.

Learning performs:

1. **Alias insert:** add the raw parsed merchant as `alias_name` and the final
   reviewed normalized merchant as `canonical_name`. If the user did not
   provide a cleaner canonical name, use the parsed merchant itself.
2. **Alias conflict:** if the alias already exists, keep its canonical name.
   Do not let one user's confirmation silently rewrite a global alias.
3. **Category fallback:** retain the existing user-specific category-rule
   learning for compatibility. Category frequency still comes from confirmed
   transactions.
4. **Queue approval:** mark the case-insensitive matching
   `merchant_review_queue` row `approved`, record `reviewed_at`, and retain the
   reviewed category as audit information. The reviewed category is never used
   across users as a category preference.

Learning failure is logged but does not roll back a valid confirmed
transaction. Retrying confirmation must not increment or relearn after another
request already won the transition.

Rejected or cancelled transactions do not create aliases, category rules, or
queue approvals.

### 5. Subsequent Transactions

The next matching email resolves through:

1. raw merchant to global alias;
2. alias to canonical merchant;
3. canonical merchant to the user's confirmed category history;
4. existing category rule only when no history exists;
5. category and pocket validation;
6. auto-confirm only if no category review remains.

For example, history containing `Shopping: 8` and `Groceries: 2` resolves to
`Shopping`. History containing `Shopping: 3` and `Groceries: 3` stays pending
and offers both categories first.

## Storage Semantics

No schema change is required.

- `merchant_aliases` remains global and unique by `alias_name`.
- `merchant_review_queue` remains global and unique by `merchant_name`.
- `category_rules` remains optionally user-scoped; email lookup continues to
  use the current user.
- `transactions` provides user-scoped merchant-category frequency.

Because the current unique constraints are case-sensitive, Core uses a
case-insensitive lookup before insert or update. This avoids creating common
case variants without requiring an index migration. Concurrent inserts still
honor the existing unique constraints; a conflict is treated as an idempotent
learning result, not a failed confirmation.

## Error Handling

- Queue upsert failure: log it and still create the pending transaction.
- Alias/category learning failure after confirmation: log it; keep the
  confirmed transaction.
- Existing alias with a different canonical name: keep the existing alias and
  leave the conflict visible for later review.
- Historical category points to an inactive category: exclude it from automatic
  resolution and require review unless another active category wins.
- Category-frequency tie: require user selection.
- Missing or invalid merchant: retain the existing pending review behavior.
- Duplicate email message ID: return the existing import state; do not increment
  the review queue or learn twice.

## API and n8n Contract

The existing email request payload and callback data remain unchanged.

Core may return these review reasons from the current email handler:

- `merchant alias could not be resolved`;
- `category could not be resolved`;
- `category choice is ambiguous`;
- `category must be selected before confirmation`;
- `pocket must be selected before confirmation`.

n8n continues to own Gmail triggers, HTTP orchestration, Telegram delivery, and
callback routing. After Core owns the queue upsert, an old n8n
`merchant_review_queue` side effect may be removed only through a separately
approved production workflow change.

## Implementation Scope

Expected files:

- `src/veyra/transactions/transaction.service.ts`;
- `src/veyra/transactions/transaction.service.spec.ts`;
- `README.md` or the existing migration integration documentation.

No dependency, DTO expansion, controller change, or database migration is
required. The existing response `reason` string and category-option response
can represent ambiguity and ordered choices.

## Test Plan

Focused tests will prove:

1. an unknown deterministic merchant upserts `merchant_review_queue` and stays
   pending;
2. repeated unknown occurrences increment the queue without duplicate rows;
3. confirming a hard-coded-parser transaction inserts the alias and approves
   the queue;
4. confirming AI and learned-template transactions still learns exactly once;
5. cancellation and rejection teach nothing;
6. an existing global alias is not overwritten;
7. the next matching email resolves from the learned alias;
8. confirmed history is user-scoped and excludes pending, rejected, income,
   empty, inactive, and `Uncategorized` categories;
9. a unique highest category count auto-resolves;
10. tied top counts stay pending and prioritize historical choices;
11. no history falls back to the existing category rule;
12. `needsCategoryReview: true` prevents email auto-save;
13. an assignment returning `Uncategorized` prevents email auto-save;
14. a valid category and resolved pocket still auto-save normally;
15. duplicate email handling produces no extra queue or learning side effects.

The regression test named `confirmed email with unknown category uses
Uncategorized` will be replaced with a test asserting a pending category review
and no confirmed transaction insert.

## Rollout Notes

Implementation changes Core only. Do not deploy as part of implementation.

Existing confirmed `Uncategorized` transactions are outside this change. They
can be identified and repaired later through a separately approved,
non-destructive cleanup workflow.
