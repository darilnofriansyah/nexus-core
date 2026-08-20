# Budget Categories and Pockets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Decouple user categories from budget pockets so every confirmed expense records an independent category and top-level pocket, with optional child category caps.

**Architecture:** Keep `budgets` as storage for top-level pockets and optional child caps. Extend the existing `categories` table into a template-backed user catalog, add `transactions.pocket_id`, and centralize category/default-pocket resolution in `BudgetService` through focused repositories. Roll out additive writes first, then pocket-based reads with a null-pocket legacy fallback.

**Tech Stack:** NestJS 10, TypeScript 5.7, PostgreSQL, `pg`, Node test runner

**Spec:** `docs/superpowers/specs/2026-08-20-budget-categories-pockets-design.md`

## Global Constraints

- Preserve existing PostgreSQL data and current n8n trigger/orchestration responsibilities.
- Use `telegram_users.cycle_start_day`; never replace financial cycles with calendar months.
- Budget spend counts only confirmed expense transactions.
- Do not modify or deploy production n8n workflows.
- Do not apply schema SQL to production; this repository stores manual migration SQL.
- Do not extend the experimental `pending_transactions` path because it is absent from the current schema source of truth.
- Keep `catid:{id}:{transactionId}` on the wire; reinterpret `id` as a user-category ID only after the category catalog exists.
- Keep `transactions.pocket_id` nullable until backfill residuals are audited and explicitly approved.
- Add no dependencies.

## File Structure

### Create

- `docs/migration/2026-08-20-budget-categories-pockets-schema.sql`: additive schema and default category templates.
- `docs/migration/2026-08-20-budget-categories-pockets-backfill.sql`: separately applied safe historical assignment.
- `src/veyra/budgets/budget-categories-pockets.migration.spec.ts`: static contracts for both SQL files.
- `src/veyra/categories/categories.module.ts`: category feature wiring.
- `src/veyra/categories/category.repository.ts`: category SQL and row mapping.
- `src/veyra/categories/category.repository.spec.ts`: category SQL contract tests.
- `src/veyra/categories/category.service.ts`: category validation and save-time resolution.
- `src/veyra/categories/category.service.spec.ts`: category business-rule tests.
- `src/veyra/categories/dto/category.dto.ts`: category request/response contracts.
- `src/veyra/budgets/budget.repository.ts`: pocket setup, lookup, mutation, and pocket-based budget queries.
- `src/veyra/budgets/budget.repository.spec.ts`: pocket and budget-query SQL tests.
- `src/veyra/budgets/dto/pocket.dto.ts`: pocket API and expense-assignment contracts.

### Modify

- `docs/veyra-database-schema.md`: source-of-truth schema definitions.
- `src/veyra/budgets/budgets.module.ts`: register repository and import category feature.
- `src/veyra/budgets/budget.service.ts`: setup orchestration, pocket/category operations, status, overview, and watchdog rules.
- `src/veyra/budgets/budget.service.spec.ts`: setup, pocket math, legacy fallback, and watchdog tests.
- `src/veyra/budgets/dto/budget-status.dto.ts`: pocket-aware status request/response.
- `src/veyra/budgets/dto/overspending-check.dto.ts`: parent-pocket and child-cap alert facts.
- `src/veyra/veyra.module.ts`: import `CategoriesModule`.
- `src/veyra/veyra.controller.ts`: category and pocket routes.
- `src/veyra/veyra.controller.spec.ts`: public route payload tests.
- `src/veyra/transactions/transaction.service.ts`: pocket assignment, Uncategorized fallback, callback reinterpretation, and confirmed reclassification.
- `src/veyra/transactions/transaction.service.spec.ts`: manual, email, callback, response, and risk tests.
- `src/veyra/transactions/dto/handle-transaction.dto.ts`: optional pocket input and awaiting-pocket response.
- `src/veyra/transactions/dto/email-transaction.dto.ts`: pocket-aware email confirmation/review contracts.
- `src/veyra/transactions/dto/confirmation-payload.dto.ts`: pocket summary fields.
- `src/veyra/transactions/dto/confirm-transaction.dto.ts`: pocket summary fields.
- `src/veyra/transactions/dto/category-callback.dto.ts`: category-ID semantics and statuses.
- `src/veyra/transactions/dto/transaction-callback-handle.dto.ts`: rename parsed callback identity internally.
- `src/veyra/conversational/conversational.repository.ts`: pocket-based budget forecast totals with legacy fallback.
- `src/veyra/conversational/conversational.repository.spec.ts`: pocket forecast SQL behavior.
- `README.md`: exact n8n HTTP Request payloads and callback semantics.

---

### Task 1: Add Additive Schema Contract

**Files:**
- Create: `docs/migration/2026-08-20-budget-categories-pockets-schema.sql`
- Create: `src/veyra/budgets/budget-categories-pockets.migration.spec.ts`
- Modify: `docs/veyra-database-schema.md`

**Interfaces:**
- Produces: nullable `categories.user_id`, `categories.is_active`, `budgets.is_default`, and `transactions.pocket_id`.
- Produces: default category templates and uniqueness constraints used by Tasks 2–8.

- [ ] **Step 1: Write the failing migration contract test**

```ts
import * as assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const migration = readFileSync(
  join(process.cwd(), "docs/migration/2026-08-20-budget-categories-pockets-schema.sql"),
  "utf8",
);

test("budget pockets migration adds only additive ownership and assignment fields", () => {
  assert.match(migration, /ALTER TABLE public\.categories[\s\S]*user_id bigint NULL/);
  assert.match(migration, /is_active boolean NOT NULL DEFAULT true/);
  assert.match(migration, /categories_unique_user_name_ci/);
  assert.match(migration, /ALTER TABLE public\.budgets[\s\S]*is_default boolean NOT NULL DEFAULT false/);
  assert.match(migration, /budgets_unique_default_active_top_level_per_user/);
  assert.match(migration, /ALTER TABLE public\.transactions[\s\S]*pocket_id bigint NULL/);
  assert.match(migration, /ON DELETE SET NULL/);
  assert.match(migration, /'Uncategorized'/);
  assert.doesNotMatch(migration, /DELETE FROM|DROP TABLE|ALTER COLUMN category/);
});
```

- [ ] **Step 2: Run the focused test and verify failure**

Run:

```bash
npx tsc -p tsconfig.test.json && node --test --test-name-pattern="budget pockets migration" dist-test/src/veyra/budgets/budget-categories-pockets.migration.spec.js
```

Expected: FAIL because the schema SQL file does not exist.

- [ ] **Step 3: Add the additive schema SQL**

```sql
ALTER TABLE public.categories
  ADD COLUMN user_id bigint NULL REFERENCES public.telegram_users(id) ON DELETE CASCADE,
  ADD COLUMN is_active boolean NOT NULL DEFAULT true;

ALTER TABLE public.categories DROP CONSTRAINT categories_name_key;

CREATE UNIQUE INDEX categories_unique_template_name_ci
  ON public.categories (lower(name))
  WHERE user_id IS NULL;

CREATE UNIQUE INDEX categories_unique_user_name_ci
  ON public.categories (user_id, lower(name))
  WHERE user_id IS NOT NULL;

INSERT INTO public.categories (name)
VALUES
  ('Food'), ('Transport'), ('Groceries'), ('Bills'),
  ('Health & Beauty'), ('Shopping'), ('Entertainment'),
  ('Transfer'), ('Other'), ('Uncategorized')
ON CONFLICT (lower(name)) WHERE user_id IS NULL DO NOTHING;

ALTER TABLE public.budgets
  ADD COLUMN is_default boolean NOT NULL DEFAULT false;

CREATE UNIQUE INDEX budgets_unique_default_active_top_level_per_user
  ON public.budgets (user_id)
  WHERE is_default AND is_active AND parent_budget_id IS NULL;

ALTER TABLE public.transactions
  ADD COLUMN pocket_id bigint NULL
  CONSTRAINT transactions_pocket_id_fkey
  REFERENCES public.budgets(id) ON DELETE SET NULL;

CREATE INDEX idx_transactions_user_pocket_date
  ON public.transactions (user_id, pocket_id, transaction_date);
```

- [ ] **Step 4: Document preflight query above the migration body**

```sql
-- Preflight; migration must stop if this returns rows. Resolve duplicates only
-- with explicit data approval.
-- SELECT lower(name), count(*)
-- FROM public.categories
-- WHERE user_id IS NULL
-- GROUP BY lower(name)
-- HAVING count(*) > 1;
```

- [ ] **Step 5: Update schema source of truth**

Update the three table definitions and index lists in `docs/veyra-database-schema.md`. State explicitly:

```md
* `categories.user_id IS NULL` identifies a default template.
* User category uniqueness is case-insensitive per user.
* `budgets.is_default` is valid only for one active top-level budget per user.
* `transactions.pocket_id` is nullable during rollout and references a top-level budget by application rule.
```

- [ ] **Step 6: Run focused and full static checks**

Run:

```bash
npx tsc -p tsconfig.test.json && node --test dist-test/src/veyra/budgets/budget-categories-pockets.migration.spec.js
npm run build
git diff --check
```

Expected: PASS. Do not apply the SQL.

- [ ] **Step 7: Commit schema slice**

```bash
git add docs/migration/2026-08-20-budget-categories-pockets-schema.sql docs/veyra-database-schema.md src/veyra/budgets/budget-categories-pockets.migration.spec.ts
git commit -m "feat(budgets): add pocket schema contract"
```

---

### Task 2: Add User Category Catalog

**Files:**
- Create: `src/veyra/categories/dto/category.dto.ts`
- Create: `src/veyra/categories/category.repository.ts`
- Create: `src/veyra/categories/category.repository.spec.ts`
- Create: `src/veyra/categories/category.service.ts`
- Create: `src/veyra/categories/category.service.spec.ts`
- Create: `src/veyra/categories/categories.module.ts`
- Modify: `src/veyra/veyra.module.ts`

**Interfaces:**
- Produces: `CategoryDto { id, name }` and category list/create/archive requests.
- Produces: `CategoryService.ensureDefaults(userId)`, `listActive(userId)`, `resolveForSave(userId, suggested)`, `findActiveById(userId, categoryId)`, `create(request)`, and `archive(request)`.
- Consumes: Task 1 category columns and indexes.

- [ ] **Step 1: Define category contracts**

```ts
export interface CategoryDto {
  id: string;
  name: string;
}

export interface CategoryListRequestDto { userId: string | number; }
export interface CategoryCreateRequestDto { userId: string | number; name: string; }
export interface CategoryArchiveRequestDto { userId: string | number; categoryId: string; }
export interface CategoryListResponseDto { status: "ok"; categories: CategoryDto[]; }
```

- [ ] **Step 2: Write failing repository tests**

Cover these SQL contracts in `category.repository.spec.ts`:

```ts
test("copies templates without reactivating archived categories", async () => {
  const { calls, repository } = createRepository();
  await repository.ensureDefaults("1");
  assert.match(calls[0].text, /INSERT INTO categories/);
  assert.match(calls[0].text, /WHERE template\.user_id IS NULL/);
  assert.match(calls[0].text, /DO NOTHING/);
});

test("lists only active categories owned by the user", async () => {
  const { calls, repository } = createRepository([]);
  await repository.listActive("1");
  assert.match(calls[0].text, /user_id = \$1/);
  assert.match(calls[0].text, /is_active = true/);
});
```

- [ ] **Step 3: Run repository tests and verify failure**

Run:

```bash
npx tsc -p tsconfig.test.json && node --test dist-test/src/veyra/categories/category.repository.spec.js
```

Expected: FAIL because repository does not exist.

- [ ] **Step 4: Implement parameterized category repository methods**

Use this idempotent copy query:

```sql
INSERT INTO categories (user_id, name, is_active)
SELECT $1::bigint, template.name, true
FROM categories template
WHERE template.user_id IS NULL
  AND template.is_active = true
ON CONFLICT (user_id, lower(name)) WHERE user_id IS NOT NULL DO NOTHING
```

Add predictable methods:

```ts
ensureDefaults(userId: string): Promise<void>;
listActive(userId: string): Promise<CategoryDto[]>;
findActiveById(userId: string, categoryId: string): Promise<CategoryDto | null>;
findActiveByName(userId: string, name: string): Promise<CategoryDto | null>;
create(userId: string, name: string): Promise<CategoryDto>;
archive(userId: string, categoryId: string): Promise<boolean>;
```

- [ ] **Step 5: Write failing category service tests**

```ts
test("unknown category resolves to reserved Uncategorized", async () => {
  const result = await service.resolveForSave("1", "Toys");
  assert.deepEqual(result, { category: "Uncategorized", needsReview: true });
});

test("reserved Uncategorized cannot be archived", async () => {
  await assert.rejects(
    () => service.archive({ userId: "1", categoryId: "10" }),
    BadRequestException,
  );
});
```

- [ ] **Step 6: Implement minimal category rules and module**

`resolveForSave()` must call `ensureDefaults()`, use a case-insensitive active-name lookup, and return:

```ts
export interface ResolvedCategory {
  category: string;
  needsReview: boolean;
}

// Known
{ category: matched.name, needsReview: false }

// Missing, unknown, or archived
{ category: "Uncategorized", needsReview: true }
```

Register and export `CategoryRepository` and `CategoryService` from `CategoriesModule`; import that module in `VeyraModule`.

- [ ] **Step 7: Run category checks**

```bash
npx tsc -p tsconfig.test.json && node --test "dist-test/src/veyra/categories/*.spec.js"
npm run lint
```

Expected: PASS.

- [ ] **Step 8: Commit category slice**

```bash
git add src/veyra/categories src/veyra/veyra.module.ts
git commit -m "feat(categories): add user category catalog"
```

---

### Task 3: Add Pocket Setup and Management

**Files:**
- Create: `src/veyra/budgets/budget.repository.ts`
- Create: `src/veyra/budgets/budget.repository.spec.ts`
- Create: `src/veyra/budgets/dto/pocket.dto.ts`
- Modify: `src/veyra/budgets/budgets.module.ts`
- Modify: `src/veyra/budgets/budget.service.ts`
- Modify: `src/veyra/budgets/budget.service.spec.ts`
- Modify: `src/veyra/veyra.controller.ts`
- Modify: `src/veyra/veyra.controller.spec.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: `CategoryService` from Task 2.
- Produces: `BudgetService.ensureFinancialSetup(userId)` and `resolveExpenseAssignment(request)`.
- Produces: list/rename/default pocket operations and category list/create/archive controller operations.

- [ ] **Step 1: Define pocket and assignment contracts**

```ts
export interface PocketDto {
  id: string;
  name: string;
  amount: number | null;
  isDefault: boolean;
}

export interface PocketListRequestDto { userId: string | number; }
export interface PocketRenameRequestDto { userId: string | number; pocketId: string; name: string; }
export interface PocketDefaultRequestDto { userId: string | number; pocketId: string; }

export type ExpenseAssignment =
  | {
      status: "resolved";
      category: string;
      needsCategoryReview: boolean;
      pocketId: string;
      pocketName: string;
    }
  | {
      status: "awaiting_pocket";
      category: string;
      needsCategoryReview: boolean;
      pockets: PocketDto[];
    };

export interface ResolveExpenseAssignmentRequest {
  userId: string | number;
  pocketId?: string | null;
  category?: string | null;
}
```

- [ ] **Step 2: Write failing repository tests for first-use setup**

```ts
test("creates Main Pocket only when user has no top-level pocket", async () => {
  const { calls, repository } = createRepository();
  await repository.ensureDefaultPocket("1");
  assert.match(calls[0].text, /INSERT INTO budgets/);
  assert.match(calls[0].text, /'Main Pocket'/);
  assert.match(calls[0].text, /parent_budget_id IS NULL/);
});

test("explicit pocket lookup requires active top-level ownership", async () => {
  const { calls, repository } = createRepository();
  await repository.findPocket("1", "20");
  assert.match(calls[0].text, /user_id = \$1/);
  assert.match(calls[0].text, /id = \$2/);
  assert.match(calls[0].text, /parent_budget_id IS NULL/);
  assert.match(calls[0].text, /is_active = true/);
});
```

- [ ] **Step 3: Implement focused pocket repository**

Add these methods:

```ts
ensureDefaultPocket(userId: string): Promise<void>;
findPocket(userId: string, pocketId: string): Promise<PocketDto | null>;
findDefaultPocket(userId: string): Promise<PocketDto | null>;
listPockets(userId: string): Promise<PocketDto[]>;
renamePocket(userId: string, pocketId: string, name: string): Promise<PocketDto | null>;
setDefaultPocket(userId: string, pocketId: string): Promise<PocketDto | null>;
```

`setDefaultPocket()` first locks and validates the target as an active owned top-level row, then clears the old default and sets the target within one `DatabaseService.withTransaction()` callback. Add a repository test asserting query order `SELECT ... FOR UPDATE`, `UPDATE ... is_default = false`, then `UPDATE ... is_default = true`.

`ensureDefaultPocket()` must run atomically and follow this order:

```sql
INSERT INTO budgets (user_id, category, amount, parent_budget_id, period_type, is_active, is_default)
SELECT $1::bigint, 'Main Pocket', NULL, NULL, 'monthly', true, true
WHERE NOT EXISTS (
  SELECT 1 FROM budgets WHERE user_id = $1 AND parent_budget_id IS NULL AND is_active = true
)
ON CONFLICT (user_id, lower(category)) WHERE parent_budget_id IS NULL DO NOTHING;

UPDATE budgets candidate
SET is_default = true
WHERE candidate.id = (
  SELECT min(id)
  FROM budgets
  WHERE user_id = $1 AND parent_budget_id IS NULL AND is_active = true
  HAVING count(*) = 1
)
AND NOT EXISTS (
  SELECT 1 FROM budgets
  WHERE user_id = $1 AND parent_budget_id IS NULL AND is_active = true AND is_default = true
);
```

- [ ] **Step 4: Write failing BudgetService setup and assignment tests**

Extend the existing `createService()` helper to accept mocked `CategoryService` and `BudgetRepository`, then add:

```ts
test("setup ensures categories before default pocket", async () => {
  const events: string[] = [];
  const { service } = createService({
    categoryService: { ensureDefaults: async () => events.push("categories") },
    repository: { ensureDefaultPocket: async () => events.push("pocket") },
  });
  await service.ensureFinancialSetup("1");
  assert.deepEqual(events, ["categories", "pocket"]);
});

test("explicit cross-user pocket throws NotFoundException", async () => {
  const { service } = createService({ repository: { findPocket: async () => null } });
  await assert.rejects(
    () => service.resolveExpenseAssignment({ userId: "1", pocketId: "99", category: "Food" }),
    NotFoundException,
  );
});

test("missing default returns awaiting_pocket with active choices", async () => {
  const pockets = [{ id: "10", name: "Main", amount: null, isDefault: false }];
  const { service } = createService({
    repository: { findDefaultPocket: async () => null, listPockets: async () => pockets },
  });
  const result = await service.resolveExpenseAssignment({ userId: "1", category: "Food" });
  assert.deepEqual(result, {
    status: "awaiting_pocket",
    category: "Food",
    needsCategoryReview: false,
    pockets,
  });
});

test("known category and default pocket resolve independently", async () => {
  const { service } = createService({
    categoryService: { resolveForSave: async () => ({ category: "Food", needsReview: false }) },
    repository: {
      findDefaultPocket: async () => ({ id: "10", name: "Main Pocket", amount: null, isDefault: true }),
    },
  });
  const result = await service.resolveExpenseAssignment({ userId: "1", category: "Food" });
  assert.equal(result.status, "resolved");
  if (result.status === "resolved") assert.equal(result.pocketId, "10");
});
```

- [ ] **Step 5: Implement setup and assignment orchestration**

```ts
async ensureFinancialSetup(userId: string | number): Promise<void> {
  const normalizedUserId = this.requireUserId(userId);
  await this.categoryService.ensureDefaults(normalizedUserId);
  await this.repository.ensureDefaultPocket(normalizedUserId);
}
```

`resolveExpenseAssignment()` must resolve category and pocket independently. An explicit invalid pocket throws `NotFoundException`; absent default returns `awaiting_pocket`.

Add these delegating `BudgetService` methods so every public operation runs full setup before reading:

```ts
listUserCategories(request: CategoryListRequestDto): Promise<CategoryListResponseDto>;
createUserCategory(request: CategoryCreateRequestDto): Promise<CategoryDto>;
archiveUserCategory(request: CategoryArchiveRequestDto): Promise<{ status: "archived" }>;
listPockets(request: PocketListRequestDto): Promise<{ status: "ok"; pockets: PocketDto[] }>;
renamePocket(request: PocketRenameRequestDto): Promise<PocketDto>;
setDefaultPocket(request: PocketDefaultRequestDto): Promise<PocketDto>;
```

`listUserCategories()` and `listPockets()` call `ensureFinancialSetup()` first. Define the validation helper used above:

```ts
private requireUserId(value: string | number): string {
  const userId = this.cleanString(String(value ?? ""));
  if (!userId) throw new BadRequestException("userId is required");
  return userId;
}
```

Import `CategoriesModule` and register `BudgetRepository` in `BudgetsModule`; keep exporting `BudgetService` for `TransactionService`.

- [ ] **Step 6: Add management routes without changing old budget routes**

```txt
POST /api/veyra/categories/list
POST /api/veyra/categories/create
POST /api/veyra/categories/archive
POST /api/veyra/budgets/pockets/list
POST /api/veyra/budgets/pockets/rename
POST /api/veyra/budgets/pockets/default
```

Controller methods call `BudgetService`; controller contains no SQL or business rules.

- [ ] **Step 7: Add controller contract tests**

Verify each route forwards one typed body and returns the service result. Include cross-user and child-pocket rejection in service tests, not controller tests.

- [ ] **Step 8: Document exact n8n payloads**

Add at least these bodies to `README.md`:

```json
{ "userId": 1 }
```

```json
{ "userId": 1, "name": "Toys" }
```

```json
{ "userId": 1, "categoryId": "17" }
```

```json
{ "userId": 1, "pocketId": "42", "name": "Monthly Transactions" }
```

```json
{ "userId": 1, "pocketId": "42" }
```

State that n8n sends HTTP requests and Telegram messages; Core performs validation and writes.

- [ ] **Step 9: Run pocket and API checks**

```bash
npx tsc -p tsconfig.test.json && node --test dist-test/src/veyra/budgets/budget.repository.spec.js dist-test/src/veyra/budgets/budget.service.spec.js dist-test/src/veyra/veyra.controller.spec.js
npm run lint
```

Expected: PASS.

- [ ] **Step 10: Commit pocket slice**

```bash
git add src/veyra/budgets src/veyra/veyra.controller.ts src/veyra/veyra.controller.spec.ts README.md
git commit -m "feat(budgets): add pocket setup and management"
```

---

### Task 4: Assign Pockets to Manual Expenses

**Files:**
- Modify: `src/veyra/transactions/dto/handle-transaction.dto.ts`
- Modify: `src/veyra/transactions/dto/confirmation-payload.dto.ts`
- Modify: `src/veyra/transactions/dto/confirm-transaction.dto.ts`
- Modify: `src/veyra/transactions/transaction.service.ts`
- Modify: `src/veyra/transactions/transaction.service.spec.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: `BudgetService.resolveExpenseAssignment()` from Task 3.
- Produces: optional `TransactionHandleRequestDto.pocketId`.
- Produces: `awaiting_pocket` response plus `pocket_id` and `pocket_name` in saved/confirmation summaries.

- [ ] **Step 1: Extend typed contracts**

```ts
export interface TransactionHandleRequestDto {
  pocketId?: string;
}

export interface SaveTransactionInputDto {
  pocketId: string | null;
  pocketName: string | null;
}

// Add to response status union
"awaiting_pocket"
```

Add nullable `pocket_id` and `pocket_name` to `SavedTransactionDto`, confirmation summaries, and confirmation payload summaries.

- [ ] **Step 2: Write failing manual transaction tests**

```ts
test("saves Toys under default Monthly Transactions without Toys budget", async () => {
  const budgetService = createBudgetService({
    status: "resolved",
    category: "Uncategorized",
    needsCategoryReview: true,
    pocketId: "42",
    pocketName: "Monthly Transactions",
  });
  const { calls, service } = createService([[{ id: "101" }]], budgetService);
  const result = await service.handleManualTransaction(manualExpense({ category: "Toys" }));
  assert.equal(result.status, "confirmed");
  assert.match(calls[0].text, /category,\s*pocket_id/);
  assert.ok(calls[0].values.includes("42"));
  assert.match(result.confirmationPayload?.reply_markup.inline_keyboard.flat()[0].text ?? "", /Review Category/);
});

test("explicit pocket overrides default", async () => {
  const { calls: assignmentCalls, service: budgetService } = createBudgetServiceWithCalls();
  const { service } = createService([[{ id: "101" }]], budgetService);
  await service.handleManualTransaction({ ...manualExpense(), pocketId: "77" });
  assert.equal(assignmentCalls[0].pocketId, "77");
});

test("multiple pockets without default returns awaiting_pocket without INSERT", async () => {
  const { calls, service } = createService([], createAwaitingPocketBudgetService());
  const result = await service.handleManualTransaction(manualExpense());
  assert.equal(result.status, "awaiting_pocket");
  assert.equal(calls.some(({ text }) => /INSERT INTO transactions/.test(text)), false);
});

test("income keeps null category and null pocket", async () => {
  const { calls, service } = createService([[{ id: "101" }]]);
  const result = await service.handleManualTransaction(manualIncome());
  assert.equal(result.status, "confirmed");
  assert.equal(result.confirmationPayload?.text.includes("Pocket:"), false);
  assert.equal(calls[0].values.includes("42"), false);
});
```

Define `manualExpense()`, `manualIncome()`, and the small budget-service fakes beside existing `createService()`; each returns the complete request/mock object used above.

- [ ] **Step 3: Run focused tests and verify failure**

```bash
npx tsc -p tsconfig.test.json && node --test --test-name-pattern="default Monthly Transactions|explicit pocket|awaiting_pocket|income keeps null" dist-test/src/veyra/transactions/transaction.service.spec.js
```

Expected: FAIL because request and persistence do not carry pocket assignment.

- [ ] **Step 4: Resolve expense assignment before manual persistence**

In `handleManualTransaction()`, after normalization and before `saveTransaction()`:

```ts
const assignment = normalized.transactionType === "expense"
  ? await this.requireBudgetService().resolveExpenseAssignment({
      userId: normalized.userId,
      pocketId: request.pocketId,
      category: normalized.category,
    })
  : null;

if (assignment?.status === "awaiting_pocket") {
  return this.awaitingPocketResponse(llmResult, assignment.pockets);
}
```

Use resolved `category`, `pocketId`, and `pocketName` for expenses. Preserve null pocket/category for income and existing handling for transfer/reversal.

Define the dependency guard and awaiting response used by this branch:

```ts
private requireBudgetService(): BudgetService {
  if (!this.budgetService) {
    throw new ServiceUnavailableException("Budget service is unavailable");
  }
  return this.budgetService;
}

private awaitingPocketResponse(
  llmResult: ManualTransactionLlmResultDto,
  pockets: PocketDto[],
): TransactionHandleResponseDto {
  return {
    status: "awaiting_pocket",
    transactionId: null,
    message: "Choose a pocket for this expense.",
    state: {
      nextState: "record_transaction_state",
      payload: llmResult,
    },
    pockets,
  };
}
```

Add `pockets?: PocketDto[]` to `TransactionHandleResponseDto`.

- [ ] **Step 5: Add `pocket_id` to manual INSERT and returned model**

```sql
INSERT INTO transactions (
  user_id, transaction_type, amount, merchant, merchant_normalized,
  category, pocket_id, transaction_date, source, notes, status,
  confidence, raw_payload
)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'manual', $9, $10, $11, $12)
```

- [ ] **Step 6: Add category-review confirmation behavior**

When `needsCategoryReview` is true, keep transaction saving behavior and include existing `change_categories:{transactionId}` action labeled `Review Category`. Do not create a category row from AI output.

- [ ] **Step 7: Document manual n8n contract**

```json
{
  "userId": 1,
  "telegramUserId": "976684739",
  "source": "manual",
  "text": "Bought a toy for 500000",
  "pocketId": "42",
  "llmResult": {
    "intent": "record_transaction",
    "transaction_type": "expense",
    "amount": 500000,
    "merchant": "Toy Store",
    "category": "Toys",
    "confidence": 95,
    "missing_fields": []
  }
}
```

Document that omitted `pocketId` uses default; unresolved multi-pocket input returns `awaiting_pocket`.

- [ ] **Step 8: Run checks and commit**

```bash
npx tsc -p tsconfig.test.json && node --test dist-test/src/veyra/transactions/transaction.service.spec.js
npm run lint
git add src/veyra/transactions README.md
git commit -m "feat(transactions): assign manual expense pockets"
```

---

### Task 5: Assign Pockets Across Email Confirmation Paths

**Files:**
- Modify: `src/veyra/transactions/dto/email-transaction.dto.ts`
- Modify: `src/veyra/transactions/transaction.service.ts`
- Modify: `src/veyra/transactions/transaction.service.spec.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: expense assignment from Task 3 and pocket-aware summaries from Task 4.
- Produces: optional `pocketId` on email review confirmation requests.
- Produces: `ConfirmTransactionStatus` value `awaiting_pocket` with active pocket choices when confirmation cannot resolve a default.
- Preserves: pending email storage, import binding, parser-template activation, credit-card cycle usage, and idempotency.

- [ ] **Step 1: Write failing direct-confirmed email tests**

Cover:

```ts
test("confirmed email expense writes default pocket_id", async () => {
  const { calls, service } = createService(emailRows(), createResolvedBudgetService("42", "Main Pocket"));
  const result = await service.handleEmailTransaction(kromQrisRequest());
  const insert = calls.find(({ text }) => /INSERT INTO transactions/.test(text));
  assert.ok(insert);
  assert.match(insert.text, /category,\s*pocket_id/);
  assert.ok(insert.values.includes("42"));
  assert.equal(result.transaction?.pocket_id, "42");
});

test("confirmed email with unknown category uses Uncategorized", async () => {
  const { calls, service } = createService(emailRows(), createResolvedBudgetService("42", "Main Pocket", "Uncategorized"));
  await service.handleEmailTransaction(kromQrisRequest());
  const insert = calls.find(({ text }) => /INSERT INTO transactions/.test(text));
  assert.ok(insert?.values.includes("Uncategorized"));
});

test("email expense without resolvable default stays pending for pocket review", async () => {
  const { calls, service } = createService(emailRows(), createAwaitingPocketBudgetService());
  const result = await service.handleEmailTransaction(kromQrisRequest());
  assert.equal(result.status, "needs_review");
  assert.equal(calls.some(({ text }) => /'confirmed'/.test(text) && /INSERT INTO transactions/.test(text)), false);
});
```

Define `emailRows()` and `kromQrisRequest()` by extracting the existing setup from `hard-coded parser handles confirmed Krom QRIS email without learned lookup`; define the resolved budget fake beside the Task 4 fakes.

- [ ] **Step 2: Write failing pending-confirmation tests**

```ts
test("confirming pending email fills missing pocket_id from default", async () => {
  const { transactionCalls, service } = createPendingEmailService(createResolvedBudgetService("42", "Main Pocket"));
  const result = await service.confirmTransaction({ transactionId: "101", userId: "1" });
  assert.equal(result.status, "confirmed");
  const update = transactionCalls.find(({ text }) => /UPDATE transactions/.test(text));
  assert.match(update?.text ?? "", /pocket_id/);
  assert.ok(update?.values.includes("42"));
});

test("explicit review pocket overrides default", async () => {
  const { assignmentCalls, service } = createPendingEmailService(createBudgetServiceWithCalls());
  await service.resolveEmailTransactionReview({ ...emailReviewRequest(), pocketId: "77" });
  assert.equal(assignmentCalls[0].pocketId, "77");
});

test("pending email remains pending when multiple pockets lack default", async () => {
  const { transactionCalls, service } = createPendingEmailService(createAwaitingPocketBudgetService());
  const result = await service.confirmTransaction({ transactionId: "101", userId: "1" });
  assert.equal(result.status, "awaiting_pocket");
  assert.equal(transactionCalls.some(({ text }) => /status = 'confirmed'/.test(text)), false);
});
```

Extract `createPendingEmailService()` and `emailReviewRequest()` from the existing pending-email confirmation fixtures so parser/import data stays unchanged.

- [ ] **Step 3: Run email subset and verify failure**

```bash
npx tsc -p tsconfig.test.json && node --test --test-name-pattern="email.*pocket|pocket.*email" dist-test/src/veyra/transactions/transaction.service.spec.js
```

Expected: FAIL because email writes do not resolve or store pockets.

- [ ] **Step 4: Extend email request and response contracts**

Add optional `pocketId` to the review-resolution request used for confirmation. Add nullable `pocket_id` and `pocket_name` to returned transaction summaries. Do not add fields to the absent `pending_transactions` schema.

Add `awaiting_pocket` to `ConfirmTransactionStatus` and add optional `pockets: PocketDto[]` to `ConfirmTransactionResponseDto`. Existing confirmed/rejected/not-found statuses remain unchanged.

- [ ] **Step 5: Update production-schema email INSERT paths**

Add `pocket_id` to:

- `saveLegacyEmailReviewTransaction()` pending insert.
- `saveEmailReviewTransaction()` pending insert and correction update.
- `recordDeterministicEmailReview()` pending insert.
- `saveConfirmedEmailTransaction()` confirmed insert.

Pending rows may retain null `pocket_id`. Confirmed expense rows may not proceed without a resolved assignment.

Extend `TransactionRow`, email transaction row interfaces, `findTransaction()`, `findTransactionById()`, and current-schema email SELECT/RETURNING lists with `pocket_id`. Join the owned top-level budget when a response needs `pocket_name`.

- [ ] **Step 6: Resolve assignment at transition time**

Extend `transitionPendingEmailTransaction()` input:

```ts
{
  transaction: TransactionRow;
  status: "confirmed" | "rejected";
  category?: string;
  pocketId?: string;
}
```

For confirmation, resolve the explicit/default pocket and save `category`, `pocket_id`, and `status = 'confirmed'` in the same database transaction. Rejection does not require a pocket.

- [ ] **Step 7: Preserve unrelated email behavior**

Run existing tests covering duplicate imports, learned templates, category learning, credit-card cycle usage, rejection, and concurrent confirmation. Fix only expectations changed by new `pocket_id` SQL/value positions.

- [ ] **Step 8: Update exact email n8n examples**

Document optional `pocketId` on review confirmation and the `awaiting_pocket` response. State that n8n keeps Gmail trigger, review buttons, callbacks, and Telegram delivery.

- [ ] **Step 9: Run checks and commit**

```bash
npx tsc -p tsconfig.test.json && node --test dist-test/src/veyra/transactions/transaction.service.spec.js dist-test/src/veyra/transactions/credit-card-cycle-usage.spec.js
npm run lint
git add src/veyra/transactions README.md
git commit -m "feat(transactions): assign email expense pockets"
```

---

### Task 6: Decouple Category Review from Budgets

**Files:**
- Modify: `src/veyra/transactions/dto/category-callback.dto.ts`
- Modify: `src/veyra/transactions/dto/transaction-callback-handle.dto.ts`
- Modify: `src/veyra/transactions/transaction.service.ts`
- Modify: `src/veyra/transactions/transaction.service.spec.ts`
- Modify: `src/veyra/veyra.controller.spec.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: user categories from Task 2 and pocket assignment from Task 3.
- Produces: `catid:{categoryId}:{transactionId}` with unchanged wire prefix.
- Produces: confirmed-expense category-only reclassification followed by watchdog reevaluation.

- [ ] **Step 1: Rename internal callback semantics**

```ts
interface ParsedTransactionCallback {
  action: TransactionCallbackHandleAction;
  transactionId?: number;
  categoryId?: number;
}
```

Retain `reviewId`, `riskAction`, and `error` members unchanged.

Change `TransactionSetCategoryRequestDto.budgetId` to `categoryId`; change status `unauthorized_budget` to `unauthorized_category`. The callback string remains `catid:*`.

- [ ] **Step 2: Write failing category option tests**

```ts
test("production category options use active user categories", async () => {
  const { service } = createService([[transaction]], createBudgetServiceWithCategories([
    { id: "10", name: "Food" },
    { id: "11", name: "Uncategorized" },
  ]));
  const result = await service.buildCategoryOptions({ transactionId: "101", userId: "1" });
  assert.deepEqual(
    result.replyMarkup?.inline_keyboard.flat().map(({ callback_data }) => callback_data),
    ["catid:10:101", "catid:11:101"],
  );
});

test("same category option is independent of pockets", async () => {
  const { service } = createService([[transaction]], createBudgetServiceWithCategories([{ id: "10", name: "Food" }]));
  const result = await service.buildCategoryOptions({ transactionId: "101", userId: "1" });
  assert.equal(result.replyMarkup?.inline_keyboard.length, 1);
});
```

- [ ] **Step 3: Write failing reclassification tests**

```ts
test("catid callback updates confirmed expense category without changing status", async () => {
  const { calls, service } = createService([[{ ...transaction, status: "confirmed" }]], createBudgetServiceWithCategory({ id: "10", name: "Food" }));
  const result = await service.setPendingTransactionCategory({ transactionId: "101", categoryId: "10", userId: "1" });
  const update = calls.find(({ text }) => /UPDATE transactions/.test(text));
  assert.equal(result.status, "updated");
  assert.match(update?.text ?? "", /SET category = \$1/);
  assert.doesNotMatch(update?.text ?? "", /status = 'confirmed'/);
});

test("cross-user or archived category callback is rejected", async () => {
  const { calls, service } = createService([[transaction]], createBudgetServiceWithCategory(null));
  const result = await service.setPendingTransactionCategory({ transactionId: "101", categoryId: "99", userId: "1" });
  assert.equal(result.status, "unauthorized_category");
  assert.equal(calls.some(({ text }) => /UPDATE transactions/.test(text)), false);
});

test("pending catid callback resolves pocket before confirmation", async () => {
  const { calls, service } = createService([[{ ...transaction, status: "pending" }]], createBudgetServiceWithCategory({ id: "10", name: "Food" }, "42"));
  const result = await service.setPendingTransactionCategory({ transactionId: "101", categoryId: "10", userId: "1" });
  assert.equal(result.status, "updated");
  const update = calls.find(({ text }) => /UPDATE transactions/.test(text));
  assert.match(update?.text ?? "", /pocket_id/);
  assert.match(update?.text ?? "", /status = 'confirmed'/);
});
```

Define the category-aware budget fakes beside the Task 4 assignment fakes; each records calls and returns the exact category/pocket values supplied above.

- [ ] **Step 4: Replace leaf-budget category lookup**

Delete `findCategoryOptions()` budget SQL, `findBudgetCategory()`, and hard-coded production fallback use. Read active user categories through `CategoryService`; first-use defaults guarantee a non-empty list.

- [ ] **Step 5: Split pending confirmation from confirmed review**

Implement two branches in `setTransactionCategory()`:

```ts
if (transaction.status === "confirmed") {
  await updateConfirmedCategoryOnly(transaction, category.name);
  return buildUpdatedResponse(await evaluateTransactionWatchdog(transaction.id));
}

// Existing pending path: resolve pocket, update category + pocket_id + status,
// then preserve email learning and watchdog behavior.
```

- [ ] **Step 6: Preserve callback routing contract**

Assert controller/callback outputs still emit and accept:

```txt
change_categories:123
catid:10:123
```

n8n continues routing by prefix and forwarding the callback body unchanged.

- [ ] **Step 7: Update docs**

Replace every statement that `catid` carries a budget ID. Document category ownership validation and confirmed transaction review behavior. Keep n8n callback and Telegram edit nodes listed as unchanged.

- [ ] **Step 8: Run checks and commit**

```bash
npx tsc -p tsconfig.test.json && node --test --test-name-pattern="category options|catid|category callback|reclassification" dist-test/src/veyra/transactions/transaction.service.spec.js dist-test/src/veyra/veyra.controller.spec.js
npm run lint
git add src/veyra/transactions src/veyra/veyra.controller.spec.ts README.md
git commit -m "feat(transactions): decouple category review"
```

---

### Task 7: Switch Budget Math and Watchdog to Pockets

**Files:**
- Modify: `src/veyra/budgets/budget.repository.ts`
- Modify: `src/veyra/budgets/budget.repository.spec.ts`
- Modify: `src/veyra/budgets/budget.service.ts`
- Modify: `src/veyra/budgets/budget.service.spec.ts`
- Modify: `src/veyra/budgets/dto/budget-status.dto.ts`
- Modify: `src/veyra/budgets/dto/overspending-check.dto.ts`
- Modify: `src/veyra/transactions/transaction.service.ts`
- Modify: `src/veyra/transactions/transaction.service.spec.ts`
- Modify: `src/veyra/conversational/conversational.repository.ts`
- Modify: `src/veyra/conversational/conversational.repository.spec.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: `transactions.pocket_id` populated by Tasks 4–6.
- Produces: parent-pocket totals, optional child-cap totals, parent and child watchdog alerts, and null-pocket legacy compatibility.
- Preserves: status filters, financial cycles, alert dedupe, alert ordering, and risk-review ordering.

- [ ] **Step 1: Write failing parent-pocket status tests**

Cover exact SQL and mapped behavior:

```ts
test("parent pocket counts all assigned confirmed expenses regardless of category", async () => {
  const { calls, service } = createService([[{ cycle_start_day: 1 }], [pocketStatusRow("500000")]]);
  const result = await service.getBudgetStatus({ userId: "1", pocketId: "42", category: "Monthly Transactions" });
  assert.equal(result.spent_amount, 500000);
  assert.match(calls[1].text, /t\.pocket_id = pocket\.id/);
});

test("same category in another pocket is excluded", async () => {
  const { calls, service } = createService([[{ cycle_start_day: 1 }], [pocketStatusRow("0")]]);
  await service.getBudgetStatus({ userId: "1", pocketId: "42", category: "Monthly Transactions" });
  assert.match(calls[1].text, /t\.pocket_id = pocket\.id/);
  assert.doesNotMatch(calls[1].text, /lower\(t\.category\) = lower\(pocket\.category\)/);
});

test("pending rejected income and transfer rows are excluded", async () => {
  const { calls, service } = createService([[{ cycle_start_day: 1 }], [pocketStatusRow("0")]]);
  await service.getBudgetStatus({ userId: "1", pocketId: "42", category: "Monthly Transactions" });
  assert.match(calls[1].text, /t\.status = 'confirmed'/);
  assert.match(calls[1].text, /t\.transaction_type = 'expense'/);
});
```

- [ ] **Step 2: Write failing child-cap tests**

```ts
test("child cap requires parent pocket and matching category", async () => {
  const { calls, service } = createService([[{ cycle_start_day: 1 }], [pocketStatusRow("250000")]]);
  await service.getBudgetStatus({ userId: "1", pocketId: "42", category: "Monthly Transactions" });
  assert.match(calls[1].text, /t\.pocket_id = child\.parent_budget_id/);
  assert.match(calls[1].text, /lower\(t\.category\) = lower\(child\.category\)/);
});

test("Toys without child cap affects parent only", async () => {
  const result = await pocketStatusFor([{ category: "Toys", amount: 500000, pocket_id: "42" }]);
  assert.equal(result.spent_amount, 500000);
  assert.deepEqual(result.child_breakdown, []);
});

test("amount-less parent falls back to active child amount sum", async () => {
  const result = await amountLessPocketStatus([{ amount: 300000 }, { amount: 700000 }]);
  assert.equal(result.budget_amount, 1000000);
});
```

Extract `pocketStatusRow()`, `pocketStatusFor()`, and `amountLessPocketStatus()` from the existing direct/parent status fixtures, changing only pocket-aware row inputs.

- [ ] **Step 3: Implement pocket-first status SQL in repository**

Parent current-cycle predicate:

```sql
t.user_id = $1
AND t.status = 'confirmed'
AND t.transaction_type = 'expense'
AND t.transaction_date >= $3::date
AND t.transaction_date < $4::date
AND (
  t.pocket_id = pocket.id
  OR (t.pocket_id IS NULL AND lower(t.category) IN (SELECT lower(category) FROM legacy_pocket_categories))
)
```

Child predicate:

```sql
(
  t.pocket_id = child.parent_budget_id
  OR (t.pocket_id IS NULL AND lower(t.category) = lower(child.category))
)
AND lower(t.category) = lower(child.category)
```

Apply the fallback only when `t.pocket_id IS NULL`; never category-match a row already assigned to another pocket.

- [ ] **Step 4: Update status and overview mapping**

Change the request contract to:

```ts
export interface BudgetStatusRequestDto {
  userId?: string;
  telegramUserId?: string;
  pocketId?: string;
  category?: string;
  asOfDate?: string;
}
```

Identify a top-level pocket by `pocketId`; retain category/name lookup only as documented compatibility. Parent amount uses explicit `budgets.amount` when non-null, otherwise sum active child amounts. Update overview query and Telegram labels to say pocket where user-facing text changed.

- [ ] **Step 5: Write failing watchdog tests**

```ts
test("watchdog evaluates assigned amount-bearing parent pocket", async () => {
  const result = await evaluatePocketTransaction({ pocket_id: "42", category: "Toys" });
  assert.deepEqual(result.alerts.map(({ budgetId }) => budgetId), ["42"]);
});

test("watchdog also evaluates matching child cap", async () => {
  const result = await evaluatePocketTransaction({ pocket_id: "42", category: "Dining" });
  assert.deepEqual(result.alerts.map(({ budgetId }) => budgetId), ["42", "84"]);
});

test("Uncategorized evaluates parent only", async () => {
  const result = await evaluatePocketTransaction({ pocket_id: "42", category: "Uncategorized" });
  assert.deepEqual(result.alerts.map(({ budgetId }) => budgetId), ["42"]);
});

test("reclassification can produce child alert without duplicating parent alert", async () => {
  const result = await evaluateReclassifiedTransaction({ pocket_id: "42", category: "Dining" }, ["42"]);
  assert.deepEqual(result.alerts.map(({ budgetId }) => budgetId), ["84"]);
});
```

Build `evaluatePocketTransaction()` and `evaluateReclassifiedTransaction()` from existing watchdog fixtures; supply repository rows for parent, optional child, and existing `budget_alerts` IDs exactly as asserted.

- [ ] **Step 6: Implement parent plus child watchdog evaluation**

Extend watchdog transaction selection with `pocket_id`. Resolve the active owned top-level pocket by ID, then optional child by `(parent_budget_id, lower(category))`. Evaluate each amount-bearing budget independently through existing threshold and `budget_alerts` dedupe helpers.

- [ ] **Step 7: Update large-transaction risk budget facts**

In `largeTransactionBudgetFacts()`, select parent by `transaction.pocket_id`, child by parent plus category, and calculate prior spend with the same pocket-first/null-legacy predicates. Keep total-spend, median, fingerprint, and risk thresholds unchanged.

- [ ] **Step 8: Update conversational forecast repository**

Change `activeBudgets()` and associated spend lookup so each top-level budget uses its pocket ID. Keep a null-pocket category fallback during rollout. Add repository tests proving rows assigned to another pocket are excluded even when category text matches.

- [ ] **Step 9: Update README n8n contracts and run focused checks**

Document pocket-aware `/budgets/status`, overview, overspending, and watchdog responses. Then run:

```bash
npx tsc -p tsconfig.test.json && node --test dist-test/src/veyra/budgets/budget.repository.spec.js dist-test/src/veyra/budgets/budget.service.spec.js dist-test/src/veyra/transactions/transaction.service.spec.js dist-test/src/veyra/conversational/conversational.repository.spec.js
npm run lint
```

Expected: PASS, including existing watchdog notification-order fixture.

- [ ] **Step 10: Commit budget-math slice**

```bash
git add src/veyra/budgets src/veyra/transactions/transaction.service.ts src/veyra/transactions/transaction.service.spec.ts src/veyra/conversational README.md
git commit -m "feat(budgets): calculate spending by pocket"
```

---

### Task 8: Add Safe Historical Backfill and Final Verification

**Files:**
- Create: `docs/migration/2026-08-20-budget-categories-pockets-backfill.sql`
- Modify: `src/veyra/budgets/budget-categories-pockets.migration.spec.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: Task 1 schema and active existing budgets.
- Produces: idempotent assignment only for unambiguous historical expense rows regardless of status; spending queries still count confirmed rows only.
- Preserves: null assignment for ambiguous multi-pocket rows and Task 7 legacy fallback.

- [ ] **Step 1: Add failing backfill contract test**

```ts
test("pocket backfill assigns only unambiguous null expense rows", () => {
  const backfill = readFileSync(
    join(process.cwd(), "docs/migration/2026-08-20-budget-categories-pockets-backfill.sql"),
    "utf8",
  );
  assert.match(backfill, /t\.pocket_id IS NULL/);
  assert.match(backfill, /t\.transaction_type = 'expense'/);
  assert.equal((backfill.match(/HAVING count\(\*\) = 1/g) ?? []).length, 3);
  assert.doesNotMatch(backfill, /DELETE FROM|SET category|SET status/);
});
```

- [ ] **Step 2: Run migration test and verify failure**

```bash
npx tsc -p tsconfig.test.json && node --test dist-test/src/veyra/budgets/budget-categories-pockets.migration.spec.js
```

Expected: FAIL because backfill SQL does not exist.

- [ ] **Step 3: Add safe backfill SQL**

```sql
WITH active_child_matches AS (
  SELECT child.user_id, lower(child.category) AS category_key,
         min(child.parent_budget_id) AS pocket_id
  FROM public.budgets child
  JOIN public.budgets parent
    ON parent.id = child.parent_budget_id
   AND parent.user_id = child.user_id
   AND parent.parent_budget_id IS NULL
   AND parent.is_active = true
  WHERE child.parent_budget_id IS NOT NULL AND child.is_active = true
  GROUP BY child.user_id, lower(child.category)
  HAVING count(*) = 1
), active_top_level_matches AS (
  SELECT user_id, lower(category) AS category_key, min(id) AS pocket_id
  FROM public.budgets
  WHERE parent_budget_id IS NULL AND is_active = true
  GROUP BY user_id, lower(category)
  HAVING count(*) = 1
), single_active_pockets AS (
  SELECT user_id, min(id) AS pocket_id
  FROM public.budgets
  WHERE parent_budget_id IS NULL AND is_active = true
  GROUP BY user_id
  HAVING count(*) = 1
), candidates AS (
  SELECT t.id,
         coalesce(child.pocket_id, top_level.pocket_id, single_pocket.pocket_id) AS pocket_id
  FROM public.transactions t
  LEFT JOIN active_child_matches child
    ON child.user_id = t.user_id AND child.category_key = lower(t.category)
  LEFT JOIN active_top_level_matches top_level
    ON top_level.user_id = t.user_id AND top_level.category_key = lower(t.category)
  LEFT JOIN single_active_pockets single_pocket ON single_pocket.user_id = t.user_id
  WHERE t.pocket_id IS NULL AND t.transaction_type = 'expense'
)
UPDATE public.transactions transaction
SET pocket_id = candidates.pocket_id
FROM candidates
WHERE transaction.id = candidates.id
  AND transaction.pocket_id IS NULL
  AND candidates.pocket_id IS NOT NULL;
```

- [ ] **Step 4: Document residual audit and rollback boundary**

Add to `README.md`:

```sql
SELECT
  count(*) FILTER (WHERE pocket_id IS NULL) AS residual_null_expenses,
  count(*) FILTER (WHERE pocket_id IS NOT NULL) AS assigned_expenses
FROM public.transactions
WHERE transaction_type = 'expense';
```

State that backfill remains unapplied, ambiguous rows stay null, and legacy fallback removal needs separate approval.

- [ ] **Step 5: Run complete verification**

```bash
npm test
npm run lint
npm run build
git diff --check
```

Expected: all commands PASS.

- [ ] **Step 6: Confirm migration safety without applying it**

```bash
rg -n "DELETE FROM|DROP TABLE|SET category|SET status" docs/migration/2026-08-20-budget-categories-pockets-*.sql
```

Expected: no destructive or unrelated data mutation matches.

- [ ] **Step 7: Commit backfill and verification docs**

```bash
git add docs/migration/2026-08-20-budget-categories-pockets-backfill.sql src/veyra/budgets/budget-categories-pockets.migration.spec.ts README.md
git commit -m "docs(budgets): add safe pocket backfill"
```

- [ ] **Step 8: Stop before external changes**

Report migration files, test results, and residual-audit query. Do not apply SQL, deploy Core, or edit production n8n workflows.
