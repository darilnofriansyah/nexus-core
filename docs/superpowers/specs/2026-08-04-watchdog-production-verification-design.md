# Watchdog Production Verification Design

## Goal

Prepare repeatable evidence for Watchdog notification ordering, `veyra_risk:*`
callback mapping, and production migration state without changing n8n or the
database.

## Observed Production State

Read-only inspection on 2026-08-04 found:

- `public.transaction_risk_reviews` exists with 27 `large_transaction` rows:
  10 pending, 15 resolved, and 2 cancelled.
- All 27 rows have `user_response IS NULL`; no resolved risk callback is
  evidenced in the database.
- The deployed constraint allows `planned`, `impulse`, `wrong_category`,
  `note_added`, and `ignored`. It rejects current callback values `necessary`,
  `regret`, and `ignore`.
- `idx_transaction_risk_reviews_risk_type` and
  `idx_transaction_risk_reviews_fingerprint` are absent.
- Therefore the committed final form of
  `2026-07-06-transaction-risk-reviews.sql` is not fully reflected, and
  `2026-07-12-large-transaction-risk-review-v1.sql` is not applied.
- No migration ledger or separate production-approval record exists in the
  database. Git history proves the SQL was committed, not that rollout was
  approved.
- n8n workflow `oXuLf0DvtlinpcvK` forwards callback data unchanged to
  `/api/veyra/transactions/callback/handle` and forwards the returned Telegram
  edit payload. Its 25 retained executions contain no `veyra_risk:*` callback.
- n8n workflows `rbKbj56pSbMU5vTp` and `li32iEVL1omy7bJb` send one base
  Telegram response but do not iterate the Core API `notifications` array.
  Separate ordered `risk_review`, `budget_alert`, and `burn_rate` delivery,
  including the risk keyboard, is not implemented.

Production verification currently fails. This work records the failure and
creates fixtures; it does not claim rollout completion.

## Fixture Contract

Add one sanitized JSON fixture under
`src/veyra/transactions/test/fixtures/watchdog/` containing:

- a confirmed Core API result with notifications ordered exactly as
  `risk_review`, `budget_alert`, `burn_rate`;
- expected priorities, message fields, and risk-review keyboard;
- all four callback values: `planned`, `necessary`, `regret`, and `ignore`;
- expected callback HTTP request fields and Telegram edit response fields;
- workflow IDs and inspected version IDs as evidence metadata, not runtime
  configuration.

No real user IDs, transaction data, tokens, credentials, or email content are
stored.

## Executable Check

Reuse `src/veyra/transactions/transaction.service.spec.ts` and its existing
service/repository fakes. Avoid a new mapper or production abstraction.

The focused assertions will prove:

1. a Watchdog evaluation producing all three notification kinds keeps the
   required array order;
2. generated risk buttons match every fixture callback value;
3. each callback reaches the existing Core API behavior;
4. `regret` starts note collection and remains pending;
5. other accepted callbacks resolve through the repository contract.

This proves the Core-side contract and makes expected n8n behavior explicit.
It cannot prove current n8n delivery because the inspected workflows do not
implement that mapping.

## Verification Record

Add `docs/migration/watchdog-production-verification.md` with:

- migration approval and application status;
- sanitized catalog-query results;
- inspected n8n workflow/version evidence;
- fixture path and focused test command;
- pass/fail criteria for a later authorized n8n test;
- rollout blocker: apply the reviewed migration before callback testing;
- rollback boundary: no Core/n8n cutover until ordered delivery and all four
  callback cases pass.

Update stale README wording only where it omits `burn_rate`. Update the
Watchdog checklist to mark discovery/fixtures accurately, not to mark failed
production verification complete.

## Safety Boundaries

- No n8n workflow creation, update, publish, unpublish, activation, execution,
  or test execution.
- No database writes or migration application.
- No production Telegram sends.
- No schema changes beyond documenting the already committed migration.
- Preserve unrelated working-tree changes.

## Success Criteria

- Fixture contains all three ordered notifications and four callback actions.
- Focused test and full recursive test suite pass.
- Documentation states migration and n8n status with no false approval or
  application claim.
- Build and lint pass.
- Production remains unchanged.
