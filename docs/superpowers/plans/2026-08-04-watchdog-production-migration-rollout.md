# Watchdog Production Migration Rollout Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply and verify the production `transaction_risk_reviews` compatibility migration before enabling Watchdog notification callbacks.

**Architecture:** Reuse the reviewed migration and the production runbook. Run read-only catalog/data gates first, apply the migration once outside a transaction block, then record fresh catalog evidence; do not touch n8n in this task.

**Tech Stack:** PostgreSQL, `psql`, NestJS repository migration contract tests.

## Global Constraints

- Production migration execution was explicitly approved by the user on 2026-08-04 Asia/Jakarta.
- Never print or persist `DATABASE_URL` or other credentials.
- Do not use `BEGIN`, `psql -1`, or `--single-transaction`; the migration uses `CREATE INDEX CONCURRENTLY`.
- Stop when a precheck gate fails; do not repair or delete production data implicitly.
- Do not modify, activate, or deactivate n8n workflows in this task.
- Do not deploy Core API.
- Preserve unrelated working-tree changes.

---

### Task 1: Durable execution record

**Files:**
- Create: `docs/superpowers/plans/2026-08-04-watchdog-production-migration-rollout.md`
- Modify after execution: `docs/migration/watchdog-production-verification.md`

**Interfaces:**
- Consumes: explicit user approval and the reviewed migration runbook.
- Produces: a cross-chat status record with evidence and remaining work.

- [x] **Step 1: Record authorization and safety boundaries**
- [x] **Step 2: Record the production connection source without its value**
- [x] **Step 3: Record precheck results**
- [x] **Step 4: Record migration command result and UTC timestamp**
- [x] **Step 5: Record postcheck results**

### Task 2: Production precheck

**Files:**
- Read: `docs/migration/watchdog-production-verification.md`
- Read: `docs/migration/2026-07-12-large-transaction-risk-review-v1.sql`

**Interfaces:**
- Consumes: production `DATABASE_URL` through the existing secret source.
- Produces: table, constraint, index, and response-distribution evidence.

- [x] **Step 1: Verify the connection targets the intended database without exposing credentials**
- [x] **Step 2: Run the runbook precheck queries with stop-on-error behavior**
- [x] **Step 3: Require table existence and zero unsupported response values**
- [x] **Step 4: Require no conflicting or invalid target indexes**
- [x] **Step 5: Stop without mutation if any gate fails**

### Task 3: Apply the migration

**Files:**
- Execute: `docs/migration/2026-07-12-large-transaction-risk-review-v1.sql`

**Interfaces:**
- Consumes: passing Task 2 evidence.
- Produces: an eight-value validated response constraint and two valid indexes.

- [x] **Step 1: Run the approved command**

```bash
PGOPTIONS='-c lock_timeout=5s -c statement_timeout=15min' \
  psql "$DATABASE_URL" -X --set=ON_ERROR_STOP=1 \
  --file=docs/migration/2026-07-12-large-transaction-risk-review-v1.sql
```

- [x] **Step 2: Stop on any nonzero exit; do not retry until catalog state is inspected**

### Task 4: Production postcheck and handoff

**Files:**
- Modify: `docs/migration/watchdog-production-verification.md`
- Modify: `docs/superpowers/plans/2026-08-04-watchdog-production-migration-rollout.md`

**Interfaces:**
- Consumes: Task 3 execution result.
- Produces: authoritative applied/not-applied status for the next chat.

- [x] **Step 1: Re-run constraint, index, and unsupported-response queries**
- [x] **Step 2: Require `convalidated = true` and all eight allowed responses**
- [x] **Step 3: Require both target indexes to be ready and valid with exact definitions**
- [x] **Step 4: Record sanitized evidence and UTC timestamp in the verification document**
- [x] **Step 5: Run `git diff --check` and the migration contract test**
- [x] **Step 6: Leave the next task as n8n outbound notification delivery; do not perform it here**

## Resume point

The database migration task is complete. Read this file and
`docs/migration/watchdog-production-verification.md`, then start a separate task
for ordered outbound `risk_review`, `budget_alert`, and `burn_rate` delivery
with the risk-review keyboard.

## Execution evidence

- Approved by the user on 2026-08-04 Asia/Jakarta.
- Connection source: running `core-api` container `DATABASE_URL`; its value was
  never printed or persisted. Sanitized target was PostgreSQL host `postgres`,
  database `veyra`.
- Precheck: table present, exactly one named legacy response check, 32 null
  responses, zero unsupported responses, and no conflicting target indexes.
- Execution: ran through the `postgres` container with role `daril`, verified as
  table owner. Output was two successful `ALTER TABLE` statements and two
  successful `CREATE INDEX` statements.
- Postcheck: passed at `2026-08-04T09:55:27.714Z`; the response constraint is
  validated with all eight values, both indexes are ready and valid, and data
  remains 32 null responses with zero unsupported values.
- Production n8n remains unchanged and blocked on the next task.
