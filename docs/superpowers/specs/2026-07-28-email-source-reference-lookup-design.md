# Email Source Reference Lookup

## Goal

Expose the Gmail message ID linked to one pending email transaction so n8n can
refetch the original email for the `edit_email_details:{transactionId}` flow.

## API Contract

Add:

`POST /api/veyra/transactions/email/source-reference`

Request:

```json
{
  "telegramUserId": "976684739",
  "transactionId": "123"
}
```

Successful response:

```json
{
  "transactionId": "123",
  "messageId": "gmail-message-id"
}
```

Both request identifiers accept positive integer strings or numbers and are
normalized to strings in the response. Missing, blank, non-integer, zero, or
negative identifiers return `400 Bad Request`.

## Data Access and Ownership

Core API resolves `telegramUserId` through `telegram_users.telegram_id`, then
looks up the transaction through:

- `transactions.id = transactionId`;
- `transactions.user_id = resolved telegram_users.id`;
- `transactions.source = 'email'`;
- `transactions.status = 'pending'`;
- `transaction_imports.transaction_id = transactions.id`;
- `transaction_imports.user_id = transactions.user_id`;
- `transaction_imports.source = 'email'`.
- `transaction_imports.status = 'pending'`.

The response `messageId` is `transaction_imports.source_reference`.

Missing users, transactions owned by another user, non-email or non-pending
transactions, and email transactions without a linked pending import all
return the same `404 Not Found` response. This avoids exposing whether another
user's transaction exists and rejects stale Edit Details callbacks.

No schema change is needed. The existing `transaction_imports` foreign key and
email source reference provide the mapping.

## Workflow Boundary

Only the future `edit_email_details:{transactionId}` callback branch consumes
this endpoint:

1. callback supplies `transactionId`;
2. n8n calls this endpoint with `telegramUserId`;
3. n8n refetches Gmail using `messageId`;
4. n8n invokes its existing AI node;
5. n8n sends the regenerated candidate, template, `transactionId`,
   `reviewToken`, and email data to
   `POST /api/veyra/transactions/email/resolve-review`.

Gmail triggers, Gmail refetching, AI invocation, Telegram callbacks, and
workflow activation remain in n8n. This task does not modify n8n or deploy the
Core API.

## Expected Files

- Add lookup request and response DTOs beside existing email transaction DTOs.
- Add one controller route.
- Add one focused transaction service method and parameterized SQL query.
- Add service and controller tests for the contract.
- Document the n8n HTTP Request payload and response in `README.md`.

No new repository abstraction or dependency is needed for one query.

## Verification

Focused tests cover:

1. Returning the linked Gmail message ID for the owning Telegram user.
2. Query ownership and email-source constraints.
3. Rejecting invalid `telegramUserId`.
4. Rejecting invalid `transactionId`.
5. Returning `404` for an unknown user or absent mapping.
6. Controller route delegation and response shape.
7. Existing tests, lint, and build remain green.
