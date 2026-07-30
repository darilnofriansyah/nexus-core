# Confirmed Email Credit-Card Expenses

## Scope

Update `credit_card_cycle_summaries.credit_used` when an email expense whose
parsed `paymentType` is `Credit Card` becomes confirmed.

This first slice excludes manual, Telegram, and imported transactions.

## Behavior

- Match `raw_payload.parsed.paymentType` case-insensitively after trimming.
- Require `transaction_type = 'expense'`.
- Cover both email confirmation paths:
  - deterministic email transactions inserted directly as confirmed;
  - pending email transactions confirmed by Save or category selection.
- Derive `cycle_start` from `transaction_date` using the user's `timezone` and
  `cycle_start_day`.
- Insert a missing summary with `credit_limit = 0`,
  `statement_balance = 0`, and `credit_used = transaction amount`.
- On conflict for `(user_id, cycle_start)`, increment only `credit_used`.
- Run the summary write in the same database transaction as the transaction
  confirmation. Any summary-write failure rolls back confirmation.
- Repeated or concurrent confirmation must not increment twice.

## Implementation

Add one private `TransactionService` helper that accepts the active database
query function and confirmed transaction fields. It returns immediately for
non-expenses or non-credit-card payloads, then performs one PostgreSQL upsert.

Call it from:

1. confirmed deterministic email insertion, before commit;
2. `transitionPendingEmailTransaction`, only after a successful transition to
   `confirmed`, before commit.

No controller, DTO, endpoint, schema, or n8n payload change is needed.

## Error Handling

Database constraints remain authoritative for non-negative safe IDR values.
The helper rejects invalid transaction amounts before writing. Database errors
propagate so the surrounding transaction rolls back.

## Tests

Focused transaction-service tests must prove:

- direct confirmed credit-card email inserts/upserts the matching cycle;
- pending credit-card email confirmation upserts once inside its transaction;
- category confirmation uses the same path;
- non-credit-card and non-expense email transactions do not write summaries;
- existing confirmation behavior remains unchanged.

README documentation will state the internal credit-card summary side effect
and that n8n request payloads remain unchanged.
