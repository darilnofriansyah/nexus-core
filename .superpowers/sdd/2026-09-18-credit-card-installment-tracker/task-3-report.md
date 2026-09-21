# Task 3 report: installment transaction mutation guard

## Trace

`rg` found no `DELETE FROM transactions` callers. `UPDATE transactions` callers were traced to:

- Web PATCH (`WebTransactionsRepository.updateTransaction`): confirmed income/expense rows, now guarded after its existing `FOR UPDATE` lock.
- Telegram manage edit/reject (`TransactionService.applyManageEdit` / `rejectManageTransaction`): now locked and guarded in their transactions; `handleManageConfirmation` converts the conflict into the existing invalid Telegram reply.
- Pending email correction and pending-email transitions: only `source = 'email' AND status = 'pending'`; an eligible installment purchase is confirmed and generated interest is confirmed/manual, so neither can reference a schedule link.
- Email-template cleanup: only confirmed email rows; generated interest is manual and planned-purchase raw-payload cleanup does not alter material fields.
- Confirm/reject and category callbacks: terminal confirmed generated-interest rows are not transitioned by the status flow; confirmed category changes are snapshot-safe for a purchase. Task 4 does not yet create generated-interest rows.
- Regret-note update: notes are snapshot-safe on a planned purchase; Task 4 interest transactions are not exposed by the regret-review flow.

## RED

Before the production guard existed, the new web planned-purchase amount test completed the update, and the planned Telegram edit, rejection, and linked-interest edit tests all returned `completed` instead of a safe conflict reply.

## GREEN

- Added `assertInstallmentMutationAllowed(query, transactionId, changedFields)` using the two ownership-independent plan/interest link checks.
- Planned purchases reject actual amount/date/type/status/user changes and rejection/deletion, while merchant/category/pocket/note snapshots remain allowed.
- Linked interest rejects every actual edit.
- Web amount edits and Telegram manage edit/reject serialize with plan creation by locking the transaction before checking links.

## Tests

- Focused guard, web repository, and TransactionService specs passed after GREEN.
- Full `npm test` started, but the environment ended the run after 30 seconds before a final summary. Before that cutoff it reported unrelated existing failures in Codex-worker and Rovelle specs; the focused Task 3 checks remained green.

## Self-review / concerns

- No migration, deployment, n8n action, or generated-interest posting path was changed.
- The no-op path skips the link query because `changedFields` is empty; this is intentional and preserves optimistic-update behavior without treating only `updated_at` as an edit.
