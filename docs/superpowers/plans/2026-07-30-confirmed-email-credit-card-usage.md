# Confirmed Email Credit-Card Usage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Atomically add confirmed email credit-card expenses to cycle usage and subtract confirmed reversals from the reversal-date cycle.

**Architecture:** Reuse both existing email confirmation transactions. One private `TransactionService` helper identifies `raw_payload.parsed.paymentType = "Credit Card"` and performs one PostgreSQL upsert using the user's timezone and financial cycle day.

**Tech Stack:** NestJS 10, TypeScript 5.7, PostgreSQL 16, Node test runner.

## Global Constraints

- Email transactions only; no manual, Telegram, import, or historical backfill.
- Expense adds usage; reversal subtracts from its transaction-date cycle.
- Floor reversal results at zero.
- Keep confirmation and summary adjustment in one DB transaction.
- New rows use zero `credit_limit` and `statement_balance`.
- Preserve schema and n8n payloads. Add no dependency.

---

### Task 1: Persist Confirmed Email Credit-Card Usage

**Files:**
- Modify: `src/veyra/transactions/transaction.service.spec.ts`
- Modify: `src/veyra/transactions/transaction.service.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: `saveConfirmedEmailTransaction(...)`, `transitionPendingEmailTransaction(...)`, `TransactionRow`, and transactional `client.query`.
- Produces: `updateCreditCardCycleUsage(transaction, query): Promise<void>`.

- [x] **Step 1: Write failing tests**

Cover direct confirmed inserts, pending Save confirmation, category
confirmation, reversals, and non-card exclusion. Assert upsert values:

```typescript
assert.deepEqual(summaryCall.values, [
  userId,
  transactionDate,
  transactionType === "expense" ? amount : 0,
  transactionType === "expense" ? amount : -amount,
]);
```

- [x] **Step 2: Verify RED**

```bash
rtk npx tsc -p tsconfig.test.json
rtk node --test --test-name-pattern="credit-card" dist-test/src/veyra/transactions/transaction.service.spec.js
```

Expected: missing `credit_card_cycle_summaries` query.

- [x] **Step 3: Write minimal implementation**

Implement one parameterized upsert. Calculate `cycle_start` from
`transaction_date`, `telegram_users.timezone`, and
`telegram_users.cycle_start_day`. Use:

```sql
ON CONFLICT (user_id, cycle_start) DO UPDATE
SET credit_used = GREATEST(
  0,
  credit_card_cycle_summaries.credit_used + $4
)
```

Call it inside direct-confirm and pending-transition DB transactions.

- [x] **Step 4: Verify focused GREEN**

Run compile and focused transaction tests. Confirm mutation removing
`paymentType` guard makes non-card test fail, then restore guard.

- [x] **Step 5: Document unchanged n8n contract**

Document expense addition, reversal subtraction, user financial cycles, and
unchanged n8n request bodies under `POST /api/veyra/transactions/confirm`.

- [x] **Step 6: Verify repository**

```bash
rtk npm test
rtk node --test dist-test/src/veyra/transactions/transaction.service.spec.js
rtk npm run lint
rtk npm run build
rtk git diff --check
```

- [x] **Step 7: Commit scoped files**

```bash
rtk git add README.md src/veyra/transactions/transaction.service.ts src/veyra/transactions/transaction.service.spec.ts docs/superpowers/plans/2026-07-30-confirmed-email-credit-card-usage.md
rtk git commit -m "feat(transactions): track credit-card usage"
```
