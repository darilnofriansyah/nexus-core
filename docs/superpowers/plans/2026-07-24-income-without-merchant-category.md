# Income Without Merchant or Category Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record manual income transactions without merchant or category while preserving expense validation.

**Architecture:** Make nullable income metadata explicit from normalization through persistence and response formatting. Remove the database category constraint with a forward-only SQL migration, while leaving expense, transfer, reversal, n8n orchestration, and production deployment unchanged.

**Tech Stack:** NestJS 10, TypeScript 5.7, PostgreSQL, Node test runner.

## Global Constraints

- Preserve current expense behavior.
- Preserve current transfer and reversal behavior.
- Do not modify n8n workflows.
- Do not run the migration against production.
- Do not deploy.
- Do not add dependencies.
- Preserve unrelated working-tree changes.

---

### Task 1: Capture income behavior with failing tests

**Files:**
- Modify: `src/veyra/transactions/transaction.service.spec.ts`

**Interfaces:**
- Consumes: `TransactionService.normalizeTransaction()` and `TransactionService.handleManualTransaction()`.
- Produces: executable expectations for nullable income metadata and unchanged expense validation.

- [ ] **Step 1: Add an income normalization test**

Add a test that calls:

```ts
await service.normalizeTransaction({
  userId: "user-1",
  transactionType: "income",
  amount: 19_828_000,
});
```

Assert that `merchant`, `merchantNormalized`, and `category` are `null`, and that no alias/category SQL query runs.

- [ ] **Step 2: Add confirmed and pending manual income tests**

For confirmed confidence `95`, assert the insert receives:

```ts
["1", "income", 19_828_000, null, null, null]
```

and the response message is:

```ts
"✅ Recorded income: Rp19.828.000."
```

For pending confidence `80`, assert confirmation text contains `Type: Income` and `Amount: Rp19.828.000`, but contains neither `Merchant:` nor `Category:`.

- [ ] **Step 3: Add missing-field and expense-regression tests**

Send income with:

```ts
missing_fields: ["merchant", "category"]
```

and assert it inserts rather than returning `awaiting_missing_field`. Keep assertions proving expense still rejects a blank merchant and rejects an unresolved category.

- [ ] **Step 4: Compile and run the focused tests to verify failure**

Run:

```bash
npx tsc -p tsconfig.test.json
node --test dist-test/src/veyra/transactions/transaction.service.spec.js
```

Expected: the new income assertions fail because merchant/category are currently required.

### Task 2: Implement nullable income metadata

**Files:**
- Modify: `src/veyra/transactions/dto/normalize-transaction.dto.ts`
- Modify: `src/veyra/transactions/dto/handle-transaction.dto.ts`
- Modify: `src/veyra/transactions/dto/confirmation-payload.dto.ts`
- Modify: `src/veyra/transactions/transaction.service.ts`

**Interfaces:**
- Consumes: `NormalizedTransactionType`.
- Produces: nullable `merchant`, `merchantNormalized`, and `category` for normalized/saved income; conditional confirmation formatting.

- [ ] **Step 1: Make request and response metadata nullable**

Use these types:

```ts
merchant?: string | null;
merchantNormalized: string | null;
category: string | null;
```

Apply them to normalization input/output, saved transaction output, confirmation request, and confirmation summary where the fields represent persisted transaction metadata.

- [ ] **Step 2: Restrict merchant validation to expenses**

In `normalizeTransaction()`, require merchant only when:

```ts
transactionType === "expense"
```

Return `null` rather than an empty string for absent merchant and normalized merchant.

- [ ] **Step 3: Ignore income-only optional missing fields**

Before selecting the first missing field, filter out `merchant` and `category` when `transaction_type` normalizes to `income`. Continue to follow up for any remaining missing field.

- [ ] **Step 4: Preserve final category validation for expenses**

Replace unconditional category checks in manual handling and persistence with:

```ts
if (transactionType === "expense" && !category) {
  throw new BadRequestException("category is required");
}
```

Pass `null` metadata values unchanged to PostgreSQL.

- [ ] **Step 5: Format responses without invented metadata**

For confirmed income without merchant/category, return:

```ts
`${String.fromCodePoint(0x2705)} Recorded income: ${this.formatCurrency(transaction.amount)}.`
```

In confirmation payload construction, conditionally append merchant and category lines only when present. Keep existing expense output byte-for-byte unchanged.

- [ ] **Step 6: Run focused tests**

Run:

```bash
npx tsc -p tsconfig.test.json
node --test dist-test/src/veyra/transactions/transaction.service.spec.js
```

Expected: all transaction service tests pass.

### Task 3: Add the forward database migration and update schema documentation

**Files:**
- Create: `docs/migration/2026-07-24-income-nullable-category.sql`
- Modify: `docs/veyra-database-schema.md`

**Interfaces:**
- Produces: a schema that permits `transactions.category IS NULL`.

- [ ] **Step 1: Add the migration**

Create:

```sql
ALTER TABLE public.transactions
ALTER COLUMN category DROP NOT NULL;
```

- [ ] **Step 2: Update the schema source of truth**

Change the documented column from:

```sql
category text NOT NULL,
```

to:

```sql
category text NULL,
```

Document that category, merchant, and merchant-normalized values may be null for income, while application validation still requires merchant and category for expense.

- [ ] **Step 3: Validate migration text**

Run:

```bash
rg -n "ALTER COLUMN category DROP NOT NULL|category text NULL" \
  docs/migration/2026-07-24-income-nullable-category.sql \
  docs/veyra-database-schema.md
```

Expected: both migration and schema reference match.

### Task 4: Document the n8n contract and verify the repository

**Files:**
- Modify: `README.md`

**Interfaces:**
- Produces: the final manual transaction HTTP contract for n8n.

- [ ] **Step 1: Add a merchantless/categoryless income example**

Document this `llmResult`:

```json
{
  "transaction_type": "income",
  "amount": 19828000,
  "confidence": 0.8,
  "missing_fields": []
}
```

State that n8n must not report absent merchant/category as missing for income, and that Core API also ignores those two optional fields if reported.

- [ ] **Step 2: Document rollout order**

State that `docs/migration/2026-07-24-income-nullable-category.sql` must be applied before deploying the compatible API version.

- [ ] **Step 3: Run full verification**

Run:

```bash
npm test
npm run lint
npm run build
git diff --check
```

Expected: all tests pass, lint and build exit successfully, and no whitespace errors are reported.

- [ ] **Step 4: Review the final diff**

Confirm the diff contains only the approved transaction behavior, migration, tests, and documentation. Do not stage, commit, deploy, or execute SQL because Git metadata is read-only and production changes were not authorized.
