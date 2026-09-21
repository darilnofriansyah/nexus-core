# Task 2 report: additive installment persistence

## RED

`rtk npx tsc -p tsconfig.test.json` initially failed after adding the service contract tests:

```
TS2307: Cannot find module './installments.repository'
TS2307: Cannot find module './installments.service'
```

That failure demonstrated the missing persistence/service implementation before production code was added.

## GREEN and verification

* `rtk npx tsc -p tsconfig.test.json` — passed with no TypeScript errors.
* Focused ESLint over all new installment production/test files — passed with no issues.
* `rtk node dist-test/src/veyra/transactions/installments.service.spec.js` — 6 passed.
* `rtk node dist-test/src/veyra/transactions/installments.repository.spec.js` — 3 passed.
* `rtk node dist-test/src/veyra/transactions/installments.controller.spec.js` — 2 passed.
* `rtk node dist-test/src/veyra/transactions/installments.migration.spec.js` — 1 passed.
* `rtk node dist-test/src/veyra/transactions/installments.integration.spec.js` — 3 explicitly skipped: no `INSTALLMENTS_TEST_DATABASE_URL` naming a dedicated `installments_test` database was configured. No production/default `DATABASE_URL` fallback exists.
* `rtk proxy npm test` — began after Prisma generation but did not complete in the available command window. Its visible output reported pre-existing failures in Codex-worker and Rovelle suites (`execution-server`, `job-processor`, `worker-server`, `creative-flow.integration`, `creative.controller`, `creative.integration`, `creator-creative.integration`); no installment result appeared before the command ended.

## Changed files

* `docs/migration/2026-09-18-credit-card-installments.sql`
* `docs/veyra-database-schema.md`
* `src/veyra/veyra.module.ts`
* `src/veyra/transactions/installments.{repository,service,controller}.ts`
* `src/veyra/transactions/installments.{repository,service,controller,integration,migration}.spec.ts`

The Task 1 calculation/DTO files remain unstaged because they belong to the separate preceding task.

## Self-review

* Creation locks the user-scoped original, checks an existing plan before optimistic version comparison for idempotent retries, validates owned pockets, and inserts the plan plus every schedule row inside `DatabaseService.withTransaction`.
* Preview is read-only; both preview and locked creation reject non-confirmed, non-email, non-expense, non-credit-card, non-whole/unsafe, stale, and pre-purchase-date inputs as appropriate. All runtime SQL values are parameters.
* The migration is additive and unapplied; no n8n, production, or Prisma migration was changed. The Prisma schema was left unchanged because these raw-pg Veyra tables have no CI-required generated migration/mirror convention in this task.

## Concern

Disposable PostgreSQL concurrency/rollback behavior is implemented but not executed until a dedicated test database URL is supplied. Full-suite failures listed above predate and are outside Task 2 scope.

## Fix round 1

### Root cause and RED

The integration fixture unconditionally dropped all named tables in `finally`, even if its first `CREATE TABLE` failed because a supposedly disposable database already contained prerequisites. The create service also loaded and date-validated the original before the repository had a chance to lock and return an existing matching plan.

Added a service regression for a `Pacific/Kiritimati` retry whose current local purchase date would be after the stored first due date. Before the change it failed with `originalLookups === 1`; after the change it proves the service delegates directly to the locked repository path (`originalLookups === 0`) and returns plan `7`.

### Fixes

* The fixture now preflights every prerequisite/migration table and fails without cleanup when any exists. It records each successfully created table, discovers only partial migration tables after a failed migration, and drops only recorded objects in dependency-safe order.
* Fixture DDL now mirrors the source schema definitions for `telegram_users`, `budgets`, and `transactions`, including nullable/default fields, checks, foreign keys, and indexes.
* `InstallmentsService.create` delegates schedule building to the repository after the repository locks the original and compares canonical existing-plan terms. Matching retries therefore return their persisted plan before new-plan eligibility/current-timezone date checks. New-plan validation and schedule calculation remain inside the same transaction.

### Fix verification

* `rtk npx tsc -p tsconfig.test.json` — passed.
* `rtk node dist-test/src/veyra/transactions/installments.service.spec.js` — 7 passed.
* `rtk node dist-test/src/veyra/transactions/installments.repository.spec.js` — 4 passed.
* `rtk node dist-test/src/veyra/transactions/installments.integration.spec.js` — 3 explicit skips; no dedicated test URL was configured.
