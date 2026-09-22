# Credit-card installment tracker integration

This document covers the Core API handoff for the additive installment
migration. It is operational guidance, not authorization to apply a migration,
deploy services, or change an n8n workflow.

## Core API

The preview and create routes use an existing eligible confirmed credit-card
email expense:

```http
POST /api/veyra/transactions/123456/installments/preview
POST /api/veyra/transactions/123456/installments
x-core-api-key: <existing secret-backed key>
Content-Type: application/json
```

```json
{
  "telegramUserId": "123456789",
  "expectedUpdatedAt": "2026-09-18T04:00:00.000000Z",
  "tenorMonths": 6,
  "monthlyRatePercent": "1",
  "firstDueDate": "2026-10-18"
}
```

The ID is illustrative. The trusted Veyra server supplies the user identity;
the browser must not call Core or receive the API key. Preview performs no
write. Create stores one immutable plan and dated schedule, is idempotent for
identical terms, and returns a conflict for different terms or a stale version.

## n8n due-interest scheduler

Configure this later in the existing n8n environment with an HTTP Request node:

- `POST /api/veyra/installments/post-due-interest`
- JSON body: `{}`
- existing secret-backed `x-core-api-key` header
- hourly Schedule Trigger
- when the response has `hasMore: true`, repeat with a configured maximum of
  20 batches per run; remaining work catches up on the next run
- authentication and network failures use the existing workflow retry policy

Do not add n8n SQL nodes. Scheduling, HTTP orchestration, credentials, and
notifications remain in n8n; installment calculations and database writes stay
in Core. This additive tracker does not require replacing an existing node.
Automatic interest posting is not active until an operator configures this
schedule. Without it, schedule display works but positive due interest remains
pending. This work does not activate or modify n8n.

## Rollout order

1. Review the additive migration.
2. Have an operator apply the migration.
3. Deploy the Core endpoints.
4. Deploy the web application.
5. Have an operator configure the scheduled HTTP call.

These are instructions only. No production migration or backfill was run, and
the migration creates no default cards. Default-card creation and payment
method capture require a separate design and implementation plan.

## Verification and limitations

Core focused tests cover schedule calculation, migration assertions, endpoint
contracts, repository/service behavior, edit guards, due-interest idempotency,
and timeline pagination/filter logic. The full Core check is `rtk npm test`.
The dedicated disposable PostgreSQL checks require
`INSTALLMENTS_TEST_DATABASE_URL`; when absent, migration/concurrency/rollback
and mixed-feed SQL checks are explicitly skipped. No production `DATABASE_URL`
fallback is permitted. The web checkout is outside this Core-only task, so web
tests and manual UI acceptance remain unverified and Task 6 remains excluded.
CI must perform production builds; no local production build is run.
