# Merchant Alias Learning and Category Resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make confirmed email transactions teach merchant aliases and user category preferences, resolve repeat merchants from confirmed history, and prevent email expenses from auto-saving as `Uncategorized`.

**Architecture:** Keep the existing email transaction service as the orchestration boundary. Reuse `merchant_review_queue`, `merchant_aliases`, `category_rules`, and confirmed `transactions`; add small private service helpers rather than a new repository or schema. Resolve a canonical merchant first, then choose a category from user-scoped confirmed history, falling back to existing category rules only when history is absent.

**Tech Stack:** NestJS 10, TypeScript 5.7, PostgreSQL through the existing `DatabaseService`, Node.js built-in test runner and `assert`.

**Spec:** `docs/superpowers/specs/2026-09-01-merchant-alias-learning-and-category-resolution-design.md`

## Global Constraints

- Preserve existing PostgreSQL schema and n8n request/callback payloads.
- Do not add a dependency, controller, DTO, database migration, or AI call.
- Keep Gmail triggers, Telegram sending, and callback routing in n8n.
- Never learn from pending, rejected, cancelled, duplicate, or unbound email transactions.
- Never silently overwrite an existing global merchant alias.
- Never auto-confirm an email expense when `needsCategoryReview` is true or the resolved category is `Uncategorized`.
- Do not modify production n8n workflows, deploy, run destructive SQL, or run `npm build`/`npm run build` locally.
- Read `docs/veyra-database-schema.md` before modifying the SQL in each task.

---

## File Map

- Modify `src/veyra/transactions/transaction.service.ts`: queue unknown merchants, guard email auto-save, learn aliases after every bound confirmed email, resolve category history, and order category choices.
- Modify `src/veyra/transactions/transaction.service.spec.ts`: focused regression and behavior tests using the existing query fake.
- Modify `README.md`: document Core-owned alias learning, category ambiguity, and the `Uncategorized` review response.
- No files are created under `src/`; the existing service remains the single business-logic boundary.

### Task 1: Prevent `Uncategorized` Email Auto-Save

**Files:**
- Modify: `src/veyra/transactions/transaction.service.spec.ts:5248`
- Modify: `src/veyra/transactions/transaction.service.ts:1038-1070`
- Modify: `src/veyra/transactions/transaction.service.ts:3483-3605`

**Interfaces:**
- Consumes: `BudgetService.resolveExpenseAssignment()` returning `ExpenseAssignment` with `status`, `category`, `needsCategoryReview`, and optional pocket fields.
- Produces: deterministic email responses with `status: "needs_review"`, reason `category must be selected before confirmation`, a pending transaction, and the already resolved `pocket_id`.

- [ ] **Step 1: Replace the regression test with a failing pending-review test**

Replace `confirmed email with unknown category uses Uncategorized` with:

```ts
test("email with unknown category stays pending for category review", async () => {
  const { calls, service } = createService(
    [
      [],
      [{ canonical_name: "Kopi Tuku Canonical" }],
      [{ category: "Food" }],
      [{ id: "import-1" }],
      [{ id: "tx-pending" }],
      [{ id: "import-1" }],
      [],
    ],
    createResolvedBudgetService("42", "Main Pocket", "Uncategorized"),
  );

  const result = await service.handleEmailTransaction(kromQrisRequest());

  assert.equal(result.status, "needs_review");
  assert.equal(result.reason, "category must be selected before confirmation");
  assert.equal(result.transaction?.status, "pending");
  assert.equal(result.transaction?.category, "Uncategorized");
  assert.equal(result.transaction?.pocket_id, "42");
  assert.equal(
    calls.some(
      ({ text }) =>
        /INSERT INTO transactions/.test(text) && /'confirmed'/.test(text),
    ),
    false,
  );
});
```

- [ ] **Step 2: Run the targeted test and confirm the current auto-save behavior fails it**

Run:

```bash
npx tsc -p tsconfig.test.json && node --test --test-concurrency=1 --test-name-pattern="email with unknown category stays pending" dist-test/src/veyra/transactions/transaction.service.spec.js
```

Expected: FAIL because the handler returns `confirmed` and inserts a confirmed transaction.

- [ ] **Step 3: Extend deterministic review persistence to retain an already resolved pocket**

Add optional fields to `recordDeterministicEmailReview()`:

```ts
pocketId?: string | null;
pocketName?: string | null;
```

Change the pending transaction insert so `pocket_id` is parameterized instead of hard-coded `NULL`, pass `input.pocketId ?? null`, and return:

```ts
pocket_id: input.pocketId ?? null,
pocket_name: input.pocketName ?? null,
```

- [ ] **Step 4: Add the auto-save guard before `saveConfirmedEmailTransaction()`**

Immediately after the existing `awaiting_pocket` branch, add:

```ts
if (
  assignment?.needsCategoryReview ||
  this.cleanString(assignment?.category)?.toLowerCase() === "uncategorized"
) {
  return this.recordDeterministicEmailReview({
    request: validated,
    provider: parsed.provider,
    templateKey: parsed.templateKey,
    reason: "category must be selected before confirmation",
    parsed,
    detection,
    merchant,
    merchantNormalized,
    category: "Uncategorized",
    pocketId: assignment?.status === "resolved" ? assignment.pocketId : null,
    pocketName:
      assignment?.status === "resolved" ? assignment.pocketName : null,
  });
}
```

Keep the existing `awaiting_pocket` behavior before this guard.

- [ ] **Step 5: Run the regression and existing auto-save tests**

Run:

```bash
npx tsc -p tsconfig.test.json && node --test --test-concurrency=1 --test-name-pattern="email with unknown category stays pending|confirmed email expense writes default pocket_id|email expense without resolvable default stays pending" dist-test/src/veyra/transactions/transaction.service.spec.js
```

Expected: all selected tests PASS.

- [ ] **Step 6: Commit the isolated regression fix**

```bash
git add src/veyra/transactions/transaction.service.ts src/veyra/transactions/transaction.service.spec.ts
git commit -m "fix(veyra): review uncategorized email expenses"
```

### Task 2: Activate the Merchant Review Queue

**Files:**
- Modify: `src/veyra/transactions/transaction.service.spec.ts:5418-5460`
- Modify: `src/veyra/transactions/transaction.service.ts:995-1012`
- Modify: `src/veyra/transactions/transaction.service.ts:6491-6608`

**Interfaces:**
- Consumes: parsed merchant, confidence, and normalized merchant from the email handler.
- Produces: `recordMerchantReviewCandidate(input): Promise<void>` using the current `merchant_review_queue` schema.

- [ ] **Step 1: Extend the missing-alias test to require a queue upsert**

Update `returns needs_review for known email when merchant alias is missing` so its fake rows include an empty result for the queue update and an inserted queue row before the existing pending-import rows. Add assertions:

```ts
const queueUpdate = calls.find(({ text }) =>
  /UPDATE merchant_review_queue/.test(text),
);
const queueInsert = calls.find(({ text }) =>
  /INSERT INTO merchant_review_queue/.test(text),
);

assert.ok(queueUpdate);
assert.ok(queueInsert);
assert.deepEqual(queueUpdate.values, [
  "SHOPEE.CO.ID",
  null,
  result.parsed?.confidence ?? null,
  "SHOPEE.CO.ID",
]);
```

Retain the existing assertions that the transaction stays pending and has no Save button. Stop asserting an exact total call count because the queue adds two intentional calls.

- [ ] **Step 2: Run the missing-alias test and verify it fails**

```bash
npx tsc -p tsconfig.test.json && node --test --test-concurrency=1 --test-name-pattern="merchant alias is missing" dist-test/src/veyra/transactions/transaction.service.spec.js
```

Expected: FAIL because no `merchant_review_queue` query exists.

- [ ] **Step 3: Implement the queue candidate helper**

Add:

```ts
private async recordMerchantReviewCandidate(input: {
  merchantName: string;
  suggestedCategory: string | null;
  confidence: number | null;
  suggestedMerchantName: string;
}): Promise<void> {
  try {
    const updated = await this.database.query<{ id: string | number }>(
      `
        UPDATE merchant_review_queue
        SET occurrence_count = COALESCE(occurrence_count, 0) + 1,
            suggested_category = COALESCE($2, suggested_category),
            confidence = COALESCE($3, confidence),
            suggested_merchant_name = COALESCE($4, suggested_merchant_name)
        WHERE lower(merchant_name) = lower($1)
        RETURNING id
      `,
      [
        input.merchantName,
        input.suggestedCategory,
        input.confidence,
        input.suggestedMerchantName,
      ],
    );

    if (updated.rows[0]) return;

    await this.database.query(
      `
        INSERT INTO merchant_review_queue (
          merchant_name,
          suggested_category,
          confidence,
          suggested_merchant_name
        )
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (merchant_name) DO UPDATE SET
          occurrence_count = COALESCE(merchant_review_queue.occurrence_count, 0) + 1,
          suggested_category = COALESCE(EXCLUDED.suggested_category, merchant_review_queue.suggested_category),
          confidence = COALESCE(EXCLUDED.confidence, merchant_review_queue.confidence),
          suggested_merchant_name = COALESCE(EXCLUDED.suggested_merchant_name, merchant_review_queue.suggested_merchant_name)
      `,
      [
        input.merchantName,
        input.suggestedCategory,
        input.confidence,
        input.suggestedMerchantName,
      ],
    );
  } catch (error) {
    this.logger.error(
      `Failed to queue merchant review ${input.merchantName}`,
      error instanceof Error ? error.stack : undefined,
    );
  }
}
```

- [ ] **Step 4: Call the helper only on the missing-alias branch**

Before returning the deterministic review, call:

```ts
await this.recordMerchantReviewCandidate({
  merchantName: merchant,
  suggestedCategory: null,
  confidence: parsed.confidence ?? null,
  suggestedMerchantName:
    this.cleanString(parsed.merchantNormalized ?? undefined) ?? merchant,
});
```

The existing import deduplication check must remain before parsing/queueing so a duplicate message does not increment the queue.

- [ ] **Step 5: Add a queue-update test for a repeated merchant**

Add a second test whose queue `UPDATE ... RETURNING` fake returns `{ id: "queue-1" }`. Assert no `INSERT INTO merchant_review_queue` call occurs and the pending transaction is still created.

```ts
assert.equal(
  calls.some(({ text }) => /INSERT INTO merchant_review_queue/.test(text)),
  false,
);
```

- [ ] **Step 6: Prove queue failure and duplicate delivery do not add side effects**

Add a test whose queue update returns `new Error("queue unavailable")`, followed
by the normal pending-import fake rows. Assert the handler still returns
`needs_review` and creates the pending transaction.

Extend `returns duplicate for existing Gmail message import` with:

```ts
assert.equal(
  calls.some(({ text }) => /merchant_review_queue/.test(text)),
  false,
);
```

This proves the existing import lookup exits before merchant parsing and queue
incrementing.

- [ ] **Step 7: Run the queue tests**

```bash
npx tsc -p tsconfig.test.json && node --test --test-concurrency=1 --test-name-pattern="merchant alias is missing|increments an existing merchant review|queue failure still creates pending|returns duplicate for existing Gmail" dist-test/src/veyra/transactions/transaction.service.spec.js
```

Expected: all selected tests PASS.

- [ ] **Step 8: Commit the queue producer**

```bash
git add src/veyra/transactions/transaction.service.ts src/veyra/transactions/transaction.service.spec.ts
git commit -m "feat(veyra): queue unknown email merchants"
```

### Task 3: Learn Aliases After Any Bound Confirmed Email

**Files:**
- Modify: `src/veyra/transactions/transaction.service.spec.ts:6090-6450`
- Modify: `src/veyra/transactions/transaction.service.ts:6491-6608`

**Interfaces:**
- Consumes: the existing `learnConfirmedEmailTransaction(transaction: TransactionRow): Promise<void>` calls after winning confirmation and category transitions.
- Produces: idempotent alias insert, category-rule fallback learning, and queue approval for bound `hardcoded`, `learned`, and `ai` email transactions.

- [ ] **Step 1: Write a failing hard-coded-parser learning test**

Clone the existing confirmed AI learning fixture but set:

```ts
raw_payload: {
  parserSource: "hardcoded",
  email: {
    binding: { contentHash: "a".repeat(64) },
  },
},
merchant: "SHOPEE.CO.ID",
merchant_normalized: "SHOPEE.CO.ID",
category: "Shopping",
```

Confirm the pending transaction through `confirmTransaction()` and assert:

```ts
assert.equal(
  calls.filter(({ text }) => /INSERT INTO merchant_aliases/.test(text)).length,
  1,
);
assert.equal(
  calls.filter(({ text }) => /INSERT INTO category_rules/.test(text)).length,
  1,
);
assert.equal(
  calls.filter(({ text }) => /UPDATE merchant_review_queue/.test(text)).length,
  1,
);
```

- [ ] **Step 2: Run the hard-coded learning test and verify it fails**

```bash
npx tsc -p tsconfig.test.json && node --test --test-concurrency=1 --test-name-pattern="confirmed hard-coded email learns merchant" dist-test/src/veyra/transactions/transaction.service.spec.js
```

Expected: FAIL because `parserSource !== "ai"` returns before learning.

- [ ] **Step 3: Broaden the existing learning guard**

Replace the AI-only condition with an explicit accepted-source check:

```ts
const parserSource = this.cleanString(rawPayload.parserSource);

if (
  transaction.source !== "email" ||
  !parserSource ||
  !["hardcoded", "learned", "ai"].includes(parserSource) ||
  !this.hasStoredEmailContentBinding(rawPayload) ||
  !transaction.merchant ||
  !transaction.merchant_normalized ||
  !transaction.category ||
  transaction.category.toLowerCase() === "uncategorized"
) {
  return;
}
```

Keep the binding check and the existing call sites after winning transitions.

- [ ] **Step 4: Make global alias learning insert-only**

In `upsertMerchantAlias()`, return when a case-insensitive alias already exists. Delete the branch that updates `canonical_name`:

```ts
if (row) return;

await this.database.query(
  `
    INSERT INTO merchant_aliases (alias_name, canonical_name)
    VALUES ($1, $2)
    ON CONFLICT (alias_name) DO NOTHING
  `,
  [aliasName, canonicalName],
);
```

Add a test with an existing alias whose canonical name differs and assert no `UPDATE merchant_aliases` query occurs.

- [ ] **Step 5: Add and call the queue approval helper**

Add:

```ts
private async approveMerchantReviewCandidate(input: {
  merchantName: string;
  canonicalName: string;
  category: string;
}): Promise<void> {
  await this.database.query(
    `
      UPDATE merchant_review_queue
      SET status = 'approved',
          reviewed_category = $2,
          reviewed_at = now(),
          suggested_merchant_name = COALESCE(suggested_merchant_name, $3)
      WHERE lower(merchant_name) = lower($1)
    `,
    [input.merchantName, input.category, input.canonicalName],
  );
}
```

Call it after alias and category-rule learning:

```ts
await this.approveMerchantReviewCandidate({
  merchantName: transaction.merchant,
  canonicalName: transaction.merchant_normalized,
  category: transaction.category,
});
```

Keep all three writes inside the existing learning `try/catch` so a post-confirmation learning failure is logged without rolling back the confirmed transaction.

- [ ] **Step 6: Add negative learning tests**

Add table-driven cases for `status: "rejected"`, missing/invalid binding, and `category: "Uncategorized"`. Invoke the relevant public confirmation/cancellation path and assert none of these queries occur:

```ts
/INSERT INTO merchant_aliases/
/INSERT INTO category_rules/
/UPDATE merchant_review_queue/
```

- [ ] **Step 7: Run all focused learning tests**

```bash
npx tsc -p tsconfig.test.json && node --test --test-concurrency=1 --test-name-pattern="learns merchant|does not overwrite global alias|does not learn" dist-test/src/veyra/transactions/transaction.service.spec.js
```

Expected: all selected tests PASS.

- [ ] **Step 8: Commit confirmed-email learning**

```bash
git add src/veyra/transactions/transaction.service.ts src/veyra/transactions/transaction.service.spec.ts
git commit -m "feat(veyra): learn confirmed email merchants"
```

### Task 4: Resolve and Rank Categories from Confirmed History

**Files:**
- Modify: `src/veyra/transactions/transaction.service.ts:150-170`
- Modify: `src/veyra/transactions/transaction.service.ts:1012-1060`
- Modify: `src/veyra/transactions/transaction.service.ts:4023-4065`
- Modify: `src/veyra/transactions/transaction.service.ts:4800-4865`
- Modify: `src/veyra/transactions/transaction.service.spec.ts:5380-5480`
- Modify: `src/veyra/transactions/transaction.service.spec.ts:7860-7905`
- Modify: `README.md:1540-1665`

**Interfaces:**
- Produces: `EmailCategoryHistoryRow`, `EmailCategoryResolution`, `findEmailCategoryHistory(userId, merchantNormalized, merchant)`, and `resolveEmailCategory(...)` returning a resolved category or tied choices.
- Consumes: active user categories from `categories`, confirmed expense history from `transactions`, and the existing category-rule fallback.

- [ ] **Step 1: Add failing tests for a unique winner, a tie, and rule fallback**

Add tests around the deterministic email handler with history query rows shaped as:

```ts
[{ category: "Shopping", usage_count: 8 }, { category: "Groceries", usage_count: 2 }]
```

Assert the unique winner is passed to `resolveExpenseAssignment()` and the email confirms as `Shopping`.

Add a tie fixture:

```ts
[{ category: "Groceries", usage_count: 3 }, { category: "Shopping", usage_count: 3 }]
```

Assert:

```ts
assert.equal(result.status, "needs_review");
assert.equal(result.reason, "category choice is ambiguous");
assert.equal(result.transaction?.status, "pending");
```

Add an empty-history fixture followed by `{ category: "Food" }` from
`category_rules`; assert the existing rule still confirms as `Food`.

- [ ] **Step 2: Run the three resolution tests and verify they fail**

```bash
npx tsc -p tsconfig.test.json && node --test --test-concurrency=1 --test-name-pattern="most-used category|category history tie|no category history falls back" dist-test/src/veyra/transactions/transaction.service.spec.js
```

Expected: FAIL because the service queries only `category_rules` and cannot represent ambiguity.

- [ ] **Step 3: Add the private history and resolution types**

Near `CategoryRuleRow`, add:

```ts
interface EmailCategoryHistoryRow extends QueryResultRow {
  category: string;
  usage_count: string | number;
}

type EmailCategoryResolution =
  | { kind: "resolved"; category: string }
  | { kind: "ambiguous"; categories: string[] }
  | { kind: "none" };
```

- [ ] **Step 4: Query active, user-scoped confirmed category history**

Add:

```ts
private async findEmailCategoryHistory(
  userId: string,
  merchantNormalized: string,
  merchant: string,
): Promise<EmailCategoryHistoryRow[]> {
  const result = await this.database.query<EmailCategoryHistoryRow>(
    `
      SELECT c.name AS category,
             COUNT(*)::int AS usage_count
      FROM transactions t
      JOIN categories c
        ON c.user_id = t.user_id
       AND c.is_active = true
       AND lower(c.name) = lower(t.category)
      WHERE t.user_id = $1
        AND t.status = 'confirmed'
        AND t.transaction_type = 'expense'
        AND lower(c.name) <> 'uncategorized'
        AND (
          lower(COALESCE(NULLIF(t.merchant_normalized, ''), t.merchant)) = lower($2)
          OR lower(COALESCE(NULLIF(t.merchant_normalized, ''), t.merchant)) = lower($3)
        )
      GROUP BY c.id, c.name
      ORDER BY usage_count DESC, lower(c.name)
    `,
    [userId, merchantNormalized, merchant],
  );

  return result.rows;
}
```

This query excludes other users, pending/rejected rows, income, inactive
categories, and `Uncategorized` without application-side counters.

- [ ] **Step 5: Return a discriminated category resolution**

Change `resolveEmailCategory()` to call history first:

```ts
const history = await this.findEmailCategoryHistory(
  input.userId,
  input.merchantNormalized,
  input.merchant,
);

if (history.length > 0) {
  const highest = Number(history[0].usage_count);
  const winners = history
    .filter((row) => Number(row.usage_count) === highest)
    .map((row) => row.category);

  return winners.length === 1
    ? { kind: "resolved", category: winners[0] }
    : { kind: "ambiguous", categories: winners };
}
```

Run the existing category-rule query only after empty history, returning
`{ kind: "resolved", category }` when found. Preserve template fallback
categories through `findExistingBudgetCategory()`. Return `{ kind: "none" }`
when no source resolves.

- [ ] **Step 6: Branch the handler on resolved, ambiguous, and absent results**

Replace the nullable category handling with:

```ts
const categoryResolution = await this.resolveEmailCategory({
  userId: validated.userId,
  merchant,
  merchantNormalized,
  templateKey: parsed.templateKey,
});

if (categoryResolution.kind !== "resolved") {
  return this.recordDeterministicEmailReview({
    request: validated,
    provider: parsed.provider,
    templateKey: parsed.templateKey,
    reason:
      categoryResolution.kind === "ambiguous"
        ? "category choice is ambiguous"
        : "category could not be resolved",
    parsed,
    detection,
    merchant,
    merchantNormalized,
    category: "Uncategorized",
  });
}

const category = categoryResolution.category;
```

- [ ] **Step 7: Run the resolution tests**

```bash
npx tsc -p tsconfig.test.json && node --test --test-concurrency=1 --test-name-pattern="most-used category|category history tie|no category history falls back" dist-test/src/veyra/transactions/transaction.service.spec.js
```

Expected: all selected tests PASS.

- [ ] **Step 8: Add a failing category-option ordering test**

Extend `production category options use active user categories` with a pending
SHOPEE transaction, active categories `Food`, `Shopping`, and `Groceries`, and
history rows ordered `Shopping`, `Groceries`. Flatten the returned keyboard
labels and assert:

```ts
assert.deepEqual(labels.slice(0, 3), ["Shopping", "Groceries", "Food"]);
```

- [ ] **Step 9: Reorder active category options from the same history helper**

In the production category-options branch, load history for the transaction's
merchant and create a rank map:

```ts
const history = transaction
  ? await this.findEmailCategoryHistory(
      userId,
      transaction.merchant_normalized ?? transaction.merchant ?? "",
      transaction.merchant ?? transaction.merchant_normalized ?? "",
    )
  : [];
const historyRank = new Map(
  history.map((row, index) => [row.category.toLowerCase(), index]),
);
const activeCategories = await this.requireCategoryService().listActive(userId);
activeCategories.sort((left, right) => {
  const leftRank = historyRank.get(left.name.toLowerCase());
  const rightRank = historyRank.get(right.name.toLowerCase());
  if (leftRank === undefined && rightRank === undefined) return 0;
  if (leftRank === undefined) return 1;
  if (rightRank === undefined) return -1;
  return leftRank - rightRank;
});
```

Map the sorted categories through the existing callback option shape. Do not
change callback data or DTOs.

- [ ] **Step 10: Run category resolution and option tests together**

```bash
npx tsc -p tsconfig.test.json && node --test --test-concurrency=1 --test-name-pattern="most-used category|category history tie|no category history falls back|production category options" dist-test/src/veyra/transactions/transaction.service.spec.js
```

Expected: all selected tests PASS.

- [ ] **Step 11: Document the changed Core and n8n behavior**

In the existing README email-handler section, add:

```markdown
Unknown deterministic merchants are added to `merchant_review_queue` and stay
pending. After a user selects a category and confirms, Core learns the global
merchant alias and the user's category preference. Later emails use the user's
confirmed category history; a unique highest count auto-resolves, while tied
counts return `needs_review` with `reason = "category choice is ambiguous"`.

An email expense whose category assignment returns `needsCategoryReview` or
`Uncategorized` never auto-saves. Core returns a pending transaction with
`reason = "category must be selected before confirmation"` and n8n sends the
existing category-selection buttons.
```

Document that n8n's trigger, HTTP request payload, Telegram send, and callback
routing remain unchanged. Note that any old n8n queue-upsert side effect should
remain until a separately approved production workflow change removes it.

- [ ] **Step 12: Run the complete transaction suite, lint, and diff checks**

Run:

```bash
npx tsc -p tsconfig.test.json && node --test --test-concurrency=1 dist-test/src/veyra/transactions/transaction.service.spec.js
npm run lint
git diff --check
```

Expected: transaction tests PASS, lint exits 0, and `git diff --check` produces no output. Do not run the local build.

- [ ] **Step 13: Commit category history and documentation**

```bash
git add src/veyra/transactions/transaction.service.ts src/veyra/transactions/transaction.service.spec.ts README.md
git commit -m "feat(veyra): resolve repeat merchant categories"
```

## Final Verification

- [ ] Confirm `git status --short` contains no uncommitted files from this implementation; preserve any pre-existing unrelated user changes.
- [ ] Confirm no migration, Prisma schema, controller, DTO, dependency, n8n workflow, or deployment file changed.
- [ ] Confirm the implementation commits contain only the files listed by their tasks.
- [ ] Confirm the final response names the n8n nodes that stay: Gmail trigger, HTTP request orchestration, Telegram sending, and callback routing.
