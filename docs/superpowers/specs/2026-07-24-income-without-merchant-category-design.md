# Income Without Merchant or Category

## Goal

Allow manual income transactions to be recorded with only a user, positive
amount, transaction type, and confidence. Merchant and category are optional
metadata for income, not required fields.

Expense behavior remains unchanged.

## Data Model

`transactions.merchant` and `transactions.merchant_normalized` are already
nullable. A migration will remove the `NOT NULL` constraint from
`transactions.category`.

The migration must be applied before releasing the API change. Deployment and
production migration execution are outside this task.

## API Behavior

`POST /api/veyra/transactions/normalize` and
`POST /api/veyra/transactions/handle` will:

- require merchant and category for `expense`;
- accept absent merchant and category for `income`;
- persist absent income merchant, normalized merchant, and category as SQL
  `NULL`;
- preserve current validation for amount, confidence, source, and transaction
  type;
- preserve current behavior for transfer and reversal.

The manual handler will not ask follow-up questions for absent income merchant
or category. If the LLM reports either field in `missing_fields` for an income,
Core API will ignore those two missing-field entries and continue with any
remaining required missing field.

## Responses

Confirmed income without optional metadata will use:

`✅ Recorded income: Rp19.828.000.`

Pending income confirmation text will omit merchant and category lines when
they are absent. Existing expense messages and confirmation controls remain
unchanged.

## Scope

Expected changes:

- one SQL migration;
- the database schema reference;
- transaction DTO nullability;
- manual normalization, handling, persistence, and response formatting;
- focused transaction service tests;
- README request, response, and n8n payload documentation.

No n8n workflow, production database, deployment, or unrelated transaction
flow will be changed.

## Verification

Focused tests will cover:

1. Merchantless and categoryless income normalization.
2. Confirmed income persistence with SQL `NULL` values.
3. Pending income confirmation without merchant/category lines.
4. Income ignoring merchant/category-only `missing_fields`.
5. Expense still rejecting absent merchant or category.
6. Existing transaction tests, lint, and build remain green.
