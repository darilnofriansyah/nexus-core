# Web Transactions API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provide authenticated-server-facing Core query and PATCH endpoints for finalized Veyra transactions, including optimistic edits and atomic eligible credit-card usage corrections.

**Architecture:** Add a focused web-transactions controller, service, repository, and DTO boundary under `src/veyra/transactions`. The service resolves an active Telegram user before all reads/writes, validates and normalizes the public contract, and delegates SQL to the repository. Extract the existing cycle-usage SQL into a shared transaction helper so ingestion confirmation and web amount corrections use exactly one financial-cycle implementation.

**Tech Stack:** NestJS 10, TypeScript 5, PostgreSQL via `pg`, Node built-in test runner, existing `DatabaseService`.

## Global Constraints

- Do not add dependencies, alter database schema, run migrations, or change n8n workflows.
- Core remains protected by global `x-core-api-key`; Veyra server supplies the session-verified `telegramUserId`. Never add browser authentication or return raw payload / ownership fields.
- Query only `status = 'confirmed'` plus `transaction_type IN ('income', 'expense')`, newest-first by `(transaction_date DESC, id DESC)`, fixed caller limit `50` maximum.
- Query supports only validated `cycle`, `asOfDate`, `type`, exact `category`, `merchantQuery`, opaque keyset cursor, and `next|previous` direction. Core resolves the local-date `[startDate, endDate)` internally from the active user's `cycle_start_day`.
- PATCH only changes `amount`, `merchant`, and `category`; date, type, source, status, notes, and raw payload remain immutable.
- Amount is a positive safe whole-IDR integer. Text is trimmed, at most 200 characters; expense merchant/category must remain non-empty; income merchant/category may be `null`.
- Merchant/category/search inputs are at most 200 characters; opaque cursor input is at most 512 characters.
- Query and PATCH expose PostgreSQL UTC timestamp text with microsecond precision. Preserve `transactionDate` and `updatedAt` strings exactly; do not parse/serialize them through JavaScript `Date`.
- Missing, inactive, and foreign resources return identical `404`. `expectedUpdatedAt` mismatch returns `409`. No changed fields returns `400`.
- Eligible confirmed email-card amount corrections atomically adjust only `credit_used`; never modify `credit_limit` or `statement_balance`.
- Preserve unrelated worktree changes. Core deployment precedes Veyra deployment.

---

## File Structure

- Create `src/veyra/transactions/dto/web-transactions.dto.ts`: public request/response interfaces and normalized repository filter/change types.
- Create `src/veyra/transactions/credit-card-cycle-usage.ts`: one shared, parameterized financial-cycle upsert for signed credit usage deltas.
- Create `src/veyra/transactions/web-transactions.repository.ts`: user-scoped SQL, category query, keyset pagination, row locking, and one transaction for PATCH plus card delta.
- Create `src/veyra/transactions/web-transactions.service.ts`: public validation, cursor codec, active-user resolution, error mapping, and DTO mapping.
- Create `src/veyra/transactions/web-transactions.controller.ts`: `POST query` delegation; Task 4 adds `PATCH :id` with its real service implementation.
- Modify `src/veyra/transactions/transaction.service.ts`: replace local credit-card SQL/helper with shared helper; preserve confirmation behavior.
- Modify `src/veyra/veyra.module.ts`: register the new controller and repository/service providers.
- Create focused `*.spec.ts` files beside every new Core unit; modify `transaction.service.spec.ts` only to prove confirmation keeps using shared cycle behavior.
- Modify `README.md`: document both endpoints, server-only identity/API-key boundary, cursor opacity, errors, and card delta behavior.

## Shared Interfaces

```ts
// src/veyra/transactions/dto/web-transactions.dto.ts
export type WebTransactionType = 'income' | 'expense';
export type WebTransactionDirection = 'next' | 'previous';

export interface WebTransactionsQueryRequestDto {
  telegramUserId: string | number;
  cursor?: string | null;
  direction?: WebTransactionDirection | null;
  limit?: number | null;
  type?: WebTransactionType | null;
  cycle?: 'current' | 'previous' | null;
  category?: string | null;
  merchantQuery?: string | null;
  asOfDate?: string | null;
  timezone?: string | null;
}

export interface WebTransactionUpdateRequestDto {
  telegramUserId: string | number;
  amount?: number | null;
  merchant?: string | null;
  category?: string | null;
  expectedUpdatedAt: string;
}

export interface WebTransactionDto {
  id: string;
  amount: number;
  merchant: string | null;
  category: string | null;
  type: WebTransactionType;
  source: 'telegram' | 'email' | 'manual' | 'import';
  transactionDate: string;
  updatedAt: string;
  creditCard: boolean;
}

export interface WebTransactionsQueryResponseDto {
  items: WebTransactionDto[];
  previousCursor: string | null;
  nextCursor: string | null;
  categories: string[];
}

export interface WebTransactionCursor { transactionDate: string; id: string; }
export interface WebTransactionsFilter {
  cursor: WebTransactionCursor | null;
  direction: WebTransactionDirection;
  limit: number;
  type: WebTransactionType | null;
  category: string | null;
  merchantQuery: string | null;
  cycle: 'current' | 'previous' | null;
  asOfDate: string;
  startDate: string | null;
  endDate: string | null;
  timezone: string;
}
```

```ts
// src/veyra/transactions/credit-card-cycle-usage.ts
export type CreditCardCycleQuery = (
  text: string,
  values?: unknown[],
) => Promise<unknown>;

export async function applyCreditCardCycleUsageDelta(input: {
  userId: string;
  transactionDate: string;
  delta: number;
  query: CreditCardCycleQuery;
}): Promise<void>;
```

```ts
// src/veyra/transactions/web-transactions.repository.ts
export interface WebTransactionsUser { id: string; telegramUserId: string; cycleStartDay: number; }
export type WebTransactionUpdateResult =
  | { kind: 'not_found' }
  | { kind: 'conflict' }
  | { kind: 'invalid'; message: 'expense merchant and category are required' }
  | { kind: 'no_change' }
  | { kind: 'updated'; transaction: WebTransactionRow };

findActiveUserByTelegramId(telegramUserId: string): Promise<WebTransactionsUser | null>;
findTransactions(userId: string, filter: WebTransactionsFilter): Promise<WebTransactionRow[]>;
findCategories(userId: string, filter: Omit<WebTransactionsFilter, 'category' | 'cursor' | 'direction' | 'limit'>): Promise<string[]>;
updateTransaction(input: { userId: string; transactionId: string; expectedUpdatedAt: string; changes: { amount?: number; merchant?: string | null; category?: string | null; }; }): Promise<WebTransactionUpdateResult>;
```

### Task 1: Extract signed credit-card cycle helper without behavior change

**Files:**

- Create: `src/veyra/transactions/credit-card-cycle-usage.ts`
- Create: `src/veyra/transactions/credit-card-cycle-usage.spec.ts`
- Modify: `src/veyra/transactions/transaction.service.ts:150-206,6566-6600`
- Modify: `src/veyra/transactions/transaction.service.spec.ts:1942-2000,4745-4780`

**Interfaces:**

- Produces `applyCreditCardCycleUsageDelta(input)` for Tasks 3 and 4.
- `TransactionService` continues to identify qualifying email rows, calculate `expense ? amount : -amount`, then calls the shared helper.

- [ ] **Step 1: Write failing shared-helper tests**

```ts
test('upserts positive signed delta in user financial cycle', async () => {
  const calls: Array<{ text: string; values?: unknown[] }> = [];
  await applyCreditCardCycleUsageDelta({
    userId: '1', transactionDate: '2026-08-13T03:00:00.000Z', delta: 25000,
    query: async (text, values) => { calls.push({ text, values }); return {}; },
  });
  assert.deepEqual(calls[0]?.values, ['1', '2026-08-13T03:00:00.000Z', 25000, 25000]);
  assert.match(calls[0]?.text ?? '', /ON CONFLICT \(user_id, cycle_start\)/);
});

test('creates zero usage then applies a negative delta without negative total', async () => {
  const calls: Array<{ text: string; values?: unknown[] }> = [];
  await applyCreditCardCycleUsageDelta({ userId: '1', transactionDate: '2026-08-13T03:00:00.000Z', delta: -25000, query: async (text, values) => { calls.push({ text, values }); return {}; } });
  assert.deepEqual(calls[0]?.values, ['1', '2026-08-13T03:00:00.000Z', 0, -25000]);
  assert.match(calls[0]?.text ?? '', /GREATEST\(\s*0,/);
});

test('rejects a non-safe-integer delta', async () => {
  await assert.rejects(() => applyCreditCardCycleUsageDelta({
    userId: '1', transactionDate: '2026-08-13T03:00:00.000Z', delta: 1.5,
    query: async () => ({}),
  }), BadRequestException);
});
```

- [ ] **Step 2: Run focused test and verify failure**

Run: `npm test -- --test-name-pattern="credit-card cycle helper"`

Expected: FAIL because `credit-card-cycle-usage.ts` does not exist.

- [ ] **Step 3: Implement helper and refactor existing caller**

```ts
export async function applyCreditCardCycleUsageDelta({ userId, transactionDate, delta, query }: {...}) {
  if (!Number.isSafeInteger(delta)) throw new BadRequestException('credit-card delta must be a safe integer');
  await query(CREDIT_CARD_CYCLE_USAGE_UPSERT, [userId, transactionDate, Math.max(delta, 0), delta]);
}
```

Move the exact existing timezone/cycle SQL constant from `transaction.service.ts` into this file. Keep `TransactionService.updateCreditCardCycleUsage` as eligibility guard only: validate positive transaction amount, derive signed expense/reversal delta, call shared helper. Do not change its call sites.

- [ ] **Step 4: Run focused regression tests**

Run: `npm test -- --test-name-pattern="credit-card"`

Expected: PASS; existing confirmation tests still show positive expense and negative reversal values.

- [ ] **Step 5: Commit extraction**

```bash
git add src/veyra/transactions/credit-card-cycle-usage.ts src/veyra/transactions/credit-card-cycle-usage.spec.ts src/veyra/transactions/transaction.service.ts src/veyra/transactions/transaction.service.spec.ts
git commit -m "refactor(transactions): share credit-card cycle usage"
```

### Task 2: Define DTO contract

**Files:**

- Create: `src/veyra/transactions/dto/web-transactions.dto.ts`
- Create: `src/veyra/transactions/dto/web-transactions.dto.spec.ts`

**Interfaces:**

- Produces the DTOs and repository types consumed by Tasks 3 and 4.

- [ ] **Step 1: Write failing DTO compile-time contract test**

```ts
test('web transaction DTOs represent only approved public fields', () => {
  const query: WebTransactionsQueryRequestDto = { telegramUserId: '976684739', cycle: 'current', asOfDate: '2026-08-13', limit: 50 };
  const update: WebTransactionUpdateRequestDto = { telegramUserId: '976684739', amount: 30000, expectedUpdatedAt: '2026-08-13T03:01:00.123456Z' };
  assert.equal(query.cycle, 'current');
  assert.equal(update.amount, 30000);
});
```

- [ ] **Step 2: Run DTO test and verify failure**

Run: `npm test -- --test-name-pattern="web transaction DTOs"`

Expected: FAIL because DTO imports do not exist.

- [ ] **Step 3: Add exact DTO interfaces and test**

```ts
export interface WebTransactionUpdateRequestDto {
  telegramUserId: string | number;
  amount?: number | null;
  merchant?: string | null;
  category?: string | null;
  expectedUpdatedAt: string;
}
```

Define all Shared Interfaces exactly, including `WebTransactionUpdateResult` kinds `not_found`, `conflict`, `invalid`, `no_change`, and `updated`. Do not create controller/module references before Task 3 produces `WebTransactionsService`.

- [ ] **Step 4: Run DTO test and TypeScript compile**

Run: `npm test -- --test-name-pattern="web transaction DTOs" && npx tsc -p tsconfig.test.json --noEmit`

Expected: PASS.

- [ ] **Step 5: Commit DTO contract**

```bash
git add src/veyra/transactions/dto/web-transactions.dto.ts src/veyra/transactions/dto/web-transactions.dto.spec.ts
git commit -m "feat(transactions): add web transaction contract"
```

### Task 3: Implement user-scoped query repository and service

**Files:**

- Create: `src/veyra/transactions/web-transactions.repository.ts`
- Create: `src/veyra/transactions/web-transactions.repository.spec.ts`
- Create: `src/veyra/transactions/web-transactions.service.ts`
- Create: `src/veyra/transactions/web-transactions.service.spec.ts`
- Create: `src/veyra/transactions/web-transactions.controller.ts`
- Create: `src/veyra/transactions/web-transactions.controller.spec.ts`
- Modify: `src/veyra/veyra.module.ts:24-31`

**Interfaces:**

- Consumes DTOs from Task 2.
- Produces `queryTransactions(request): Promise<WebTransactionsQueryResponseDto>` used by controller.
- Repository returns only internal rows; service maps to public DTO and creates/reads opaque cursors.
- Registers only `POST /api/veyra/transactions/query`; PATCH remains absent until Task 4 creates its real service behavior.

- [ ] **Step 1: Write failing repository tests for scope, filters, and pagination SQL**

```ts
test('findTransactions scopes confirmed income/expense rows to resolved internal user and keyset', async () => {
  const rows = await repository.findTransactions('1', filter({
    type: 'expense', category: 'Dining', merchantQuery: 'tuku',
    cycle: 'current', asOfDate: '2026-08-13',
    cursor: { transactionDate: '2026-08-13T03:00:00.000Z', id: '123' }, direction: 'next',
  }));
  assert.match(calls[0].text, /user_id = \$1/);
  assert.match(calls[0].text, /status = 'confirmed'/);
  assert.match(calls[0].text, /transaction_type IN \('income', 'expense'\)/);
  assert.match(calls[0].text, /\(transaction_date, id\) < \(\$.*::timestamptz, \$.*::bigint\)/);
  assert.match(calls[0].text, /ORDER BY transaction_date DESC, id DESC/);
});

test('previous cursor queries newer rows ascending then repository reverses result', async () => {
  const rows = await repository.findTransactions('1', filter({ cursor: { transactionDate: '2026-08-13T03:00:00.000Z', id: '123' }, direction: 'previous' }));
  assert.match(calls[0].text, /\(transaction_date, id\) > \(\$.*::timestamptz, \$.*::bigint\)/);
  assert.match(calls[0].text, /ORDER BY transaction_date ASC, id ASC/);
  assert.deepEqual(rows.map((row) => row.id), ['125', '124']);
});

test('findCategories retains type/date/search scope but excludes category and cursor', async () => {
  await repository.findCategories('1', { ...filter({ type: 'expense', merchantQuery: 'tuku', startDate: '2026-08-01', endDate: '2026-09-01' }), category: undefined, cursor: undefined, direction: undefined, limit: undefined });
  assert.match(calls[0].text, /GROUP BY category/);
  assert.match(calls[0].text, /user_id = \$1/);
  assert.doesNotMatch(calls[0].text, /category = \$\d+/);
});
```

- [ ] **Step 2: Run repository tests and verify failure**

Run: `npm test -- --test-name-pattern="web transactions repository"`

Expected: FAIL because repository does not exist.

- [ ] **Step 3: Implement repository SQL and row mapping**

Use `findActiveUserByTelegramId` with `telegram_users.telegram_id`, `is_active IS TRUE`, `LIMIT 1`; it returns `id`, Telegram ID strings, and `cycle_start_day` clamped to `1..31`. Build query predicates from bound positional values only:

```sql
WHERE user_id = $1
  AND status = 'confirmed'
  AND transaction_type IN ('income', 'expense')
  AND ($type filter)
  AND ($exact category filter)
  AND (COALESCE(merchant_normalized, merchant, '') ILIKE '%' || $merchant || '%')
  AND transaction_date >= ($resolvedStartDate::date AT TIME ZONE $timezone)
  AND transaction_date < ($resolvedEndDate::date AT TIME ZONE $timezone)
```

Select `id, amount, merchant, category, transaction_type, source`, `to_char(transaction_date AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS transaction_date`, and the same microsecond UTC `to_char` expression as `updated_at`, plus boolean `source = 'email' AND lower(trim(COALESCE(raw_payload -> 'parsed' ->> 'paymentType', ''))) = 'credit card' AND transaction_type = 'expense' AS credit_card`. Never select or return `raw_payload`, `user_id`, or `merchant_normalized`. Fetch `limit + 1`; `previousCursor` exists only if request had a cursor and page has displayed rows; `nextCursor` exists only if the extra row proves older rows. Encode cursor timestamp text exactly as selected, and reverse previous-direction SQL results before mapping.

- [ ] **Step 4: Write failing service tests for validation, cursor codec, response, and isolation**

```ts
test('rejects invalid query identity, cursor, cycle, as-of date, type, limit, and timezone', async () => {
  await assert.rejects(() => service.queryTransactions({ telegramUserId: 'x' }), BadRequestException);
  await assert.rejects(() => service.queryTransactions({ telegramUserId: '1', cursor: 'not-base64' }), BadRequestException);
  await assert.rejects(() => service.queryTransactions({ telegramUserId: '1', cycle: 'future' as never }), BadRequestException);
  await assert.rejects(() => service.queryTransactions({ telegramUserId: '1', asOfDate: '2026-02-31' }), BadRequestException);
});

test('returns same not-found response for inactive or unknown Telegram identity', async () => {
  repository.user = null;
  await assert.rejects(() => service.queryTransactions({ telegramUserId: '976684739' }), NotFoundException);
});

test('resolves current and previous financial cycles after user lookup', async () => {
  repository.user = { id: '1', telegramUserId: '976684739', cycleStartDay: 15 };
  await service.queryTransactions({ telegramUserId: '976684739', cycle: 'current', asOfDate: '2026-08-13', timezone: 'Asia/Jakarta' });
  assert.equal(repository.filters[0]?.startDate, '2026-07-15');
  assert.equal(repository.filters[0]?.endDate, '2026-08-15');
  await service.queryTransactions({ telegramUserId: '976684739', cycle: 'previous', asOfDate: '2026-08-13', timezone: 'Asia/Jakarta' });
  assert.equal(repository.filters[1]?.startDate, '2026-06-15');
  assert.equal(repository.filters[1]?.endDate, '2026-07-15');
});

test('encodes opaque previous and next cursors and maps only public fields', async () => {
  const result = await service.queryTransactions({ telegramUserId: '976684739' });
  assert.deepEqual(JSON.parse(Buffer.from(result.nextCursor ?? '', 'base64url').toString('utf8')), { transactionDate: '2026-08-13T03:00:00.123456Z', id: '123' });
  assert.deepEqual(Object.keys(result.items[0] ?? {}).sort(), ['amount', 'category', 'creditCard', 'id', 'merchant', 'source', 'transactionDate', 'type', 'updatedAt']);
});
```

- [ ] **Step 5: Implement service normalization and query composition**

Accept only positive integer Telegram IDs, `direction` `next|previous`, `limit` `1..50` default `50`, `type` `income|expense`, optional `cycle` `current|previous`, valid `asOfDate` calendar date (`YYYY-MM-DD`, default current date in validated timezone), valid IANA timezone default `Asia/Jakarta`, trimmed category and merchant search `1..200` when supplied, and cursor length `1..512`. Do not accept browser-provided `startDate` or `endDate`. After resolving active user, calculate current cycle start/end from `asOfDate`, the user's clamped `cycleStartDay` (`1..31`), and timezone using the same month-boundary rule as `DashboardOverviewService`; for `previous`, use current start as exclusive end and calculate the preceding cycle start. Pass these internal bounds to both row and category queries. Cursor uses base64url JSON exactly `{ "transactionDate": microsecond UTC text, "id": positive integer string }`; decode must reject extra/missing keys, timestamp text outside `YYYY-MM-DDTHH:mm:ss.ffffffZ`, invalid date, or invalid ID. Preserve the timestamp string exactly: do not convert cursor, `transactionDate`, or `updatedAt` through JavaScript `Date`. Resolve active user once, query rows and category options in parallel using internal user ID, then map numeric amounts to safe whole IDR integers. Do not accept `status`, `source`, arbitrary sort fields, or date boundaries.

- [ ] **Step 6: Add controller only after service exists**

```ts
@Controller('veyra/transactions')
export class WebTransactionsController {
  constructor(private readonly service: WebTransactionsService) {}
  @Post('query') query(@Body() body: WebTransactionsQueryRequestDto) { return this.service.queryTransactions(body); }
}
```

Write the query controller delegation test, then register `WebTransactionsController`, `WebTransactionsService`, and `WebTransactionsRepository` in `VeyraModule`. Do not add this controller to `DashboardModule` or alter existing `VeyraController` routes.

- [ ] **Step 7: Run focused query and controller suite**

Run: `npm test -- --test-name-pattern="web transactions (repository|service|controller)"`

Expected: PASS, including duplicate-timestamp next/previous ordering and finalized-only scope.

- [ ] **Step 8: Commit query vertical slice**

```bash
git add src/veyra/transactions/web-transactions.repository.ts src/veyra/transactions/web-transactions.repository.spec.ts src/veyra/transactions/web-transactions.service.ts src/veyra/transactions/web-transactions.service.spec.ts src/veyra/transactions/web-transactions.controller.ts src/veyra/transactions/web-transactions.controller.spec.ts src/veyra/veyra.module.ts
git commit -m "feat(transactions): query finalized web transactions"
```

### Task 4: Implement optimistic PATCH and atomic card amount correction

**Files:**

- Modify: `src/veyra/transactions/web-transactions.repository.ts`
- Modify: `src/veyra/transactions/web-transactions.repository.spec.ts`
- Modify: `src/veyra/transactions/web-transactions.service.ts`
- Modify: `src/veyra/transactions/web-transactions.service.spec.ts`
- Modify: `src/veyra/transactions/web-transactions.controller.ts`
- Modify: `src/veyra/transactions/web-transactions.controller.spec.ts`

**Interfaces:**

- Consumes `applyCreditCardCycleUsageDelta` from Task 1 and update DTO from Task 2.
- Produces `updateTransaction({ transactionId, request }): Promise<WebTransactionDto>`.
- Adds `PATCH /api/veyra/transactions/:id` only after that real service method exists.

- [ ] **Step 1: Write failing service tests for accepted/rejected edit shapes**

```ts
test('requires a valid expectedUpdatedAt and at least one supplied changed field', async () => {
  await assert.rejects(() => service.updateTransaction({ transactionId: '123', request: {
    telegramUserId: '976684739', expectedUpdatedAt: 'not-a-date', amount: 25000,
  }}), BadRequestException);
});

test('requires non-empty merchant and category for expense but permits null values for income', async () => {
  repository.lockedRow = expenseRow({ merchant: 'TUKU', category: 'Dining' });
  await assert.rejects(() => service.updateTransaction({ transactionId: '123', request: { telegramUserId: '976684739', merchant: null, expectedUpdatedAt: oldTime } }), BadRequestException);
  repository.lockedRow = incomeRow({ merchant: 'Salary', category: 'Income' });
  await assert.doesNotReject(() => service.updateTransaction({ transactionId: '123', request: { telegramUserId: '976684739', merchant: null, expectedUpdatedAt: oldTime } }));
});

test('maps missing or foreign row to the same NotFoundException and stale row to ConflictException', async () => {
  repository.updateResult = { kind: 'not_found' };
  await assert.rejects(() => service.updateTransaction(updateRequest), NotFoundException);
  repository.updateResult = { kind: 'conflict' };
  await assert.rejects(() => service.updateTransaction(updateRequest), ConflictException);
});

test('maps locked final-state invalid and no-change results to BadRequestException', async () => {
  repository.updateResult = { kind: 'invalid', message: 'expense merchant and category are required' };
  await assert.rejects(() => service.updateTransaction(updateRequest), BadRequestException);
  repository.updateResult = { kind: 'no_change' };
  await assert.rejects(() => service.updateTransaction(updateRequest), BadRequestException);
});
```

- [ ] **Step 2: Write failing repository transaction tests**

```ts
test('locks finalized owned row, writes amount and matching positive email-card delta in one transaction', async () => {
  const result = await repository.updateTransaction({ userId: '1', transactionId: '123', expectedUpdatedAt: oldTime, changes: { amount: 30000 } });
  assert.equal(result.kind, 'updated');
  assert.match(calls[0].text, /FOR UPDATE/);
  assert.match(calls[1].text, /UPDATE transactions/);
  assert.match(calls[2].text, /INSERT INTO credit_card_cycle_summaries/);
  assert.deepEqual(calls[2].values, ['1', transactionDate, 5000, 5000]);
});

test('uses negative delta for eligible expense decrease and does not write summary for merchant-only/category-only/non-card changes', async () => {
  await repository.updateTransaction(eligibleExpenseAmountChange({ amount: 20000 }));
  assert.deepEqual(summaryCalls[0]?.values, ['1', transactionDate, 0, -5000]);
  await repository.updateTransaction(eligibleExpenseMerchantChange({ merchant: 'Tuku Kemang' }));
  await repository.updateTransaction(eligibleExpenseCategoryChange({ category: 'Dining' }));
  await repository.updateTransaction(nonCardAmountChange({ amount: 30000 }));
  assert.equal(summaryCalls.length, 1);
});

test('failed eligible expense summary query rejects the whole DatabaseService transaction', async () => {
  await assert.rejects(() => repository.updateTransaction(eligibleExpenseAmountChange({ amount: 30000 })), /summary write failed/);
  assert.deepEqual(summaryCalls[0]?.values, ['1', transactionDate, 5000, 5000]);
  assert.equal(transactionLifecycle.committed, false);
  assert.equal(transactionLifecycle.rolledBack, true);
});
```

- [ ] **Step 3: Run update tests and verify failure**

Run: `npm test -- --test-name-pattern="web transactions.*(update|credit-card|conflict)"`

Expected: FAIL because PATCH service/repository logic is absent.

- [ ] **Step 4: Implement service-level patch normalization**

Require positive bigint path ID and positive integer Telegram ID. Use own-property checks, so `{ merchant: null }` differs from omission. Reject non-safe/non-whole/`<= 0` amount; trim non-null merchant/category to `1..200`; require `expectedUpdatedAt` in exact microsecond UTC form `YYYY-MM-DDTHH:mm:ss.ffffffZ`; reject empty changes. Resolve active Telegram user first, pass normalized supplied changes and untouched version text to repository, and map `invalid` / `no_change` results to `BadRequestException`. Do not fetch or compose a transaction outside the repository lock.

- [ ] **Step 5: Implement repository transaction exactly once**

Within `database.withTransaction`:

```sql
SELECT id, user_id, transaction_type, amount, merchant, category,
       transaction_date, source, status,
       to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at,
       updated_at = $3::timestamptz AS version_matches,
       raw_payload
FROM transactions
WHERE id = $1 AND user_id = $2
  AND status = 'confirmed'
  AND transaction_type IN ('income', 'expense')
FOR UPDATE
```

Bind `$3` to the unmodified `expectedUpdatedAt` string. Return `{ kind: 'not_found' }` when absent and `{ kind: 'conflict' }` when locked row `version_matches` is false; this compares `updated_at` exactly to `$expectedUpdatedAt::timestamptz` inside PostgreSQL, never after a JavaScript timestamp round trip. While lock is held, compose existing values plus supplied changes; return `{ kind: 'invalid', message: 'expense merchant and category are required' }` if final expense merchant/category is null/empty and `{ kind: 'no_change' }` if no supplied normalized value differs. Update only supplied columns plus `updated_at = now()` with bound values and `RETURNING` public columns formatted as microsecond UTC text. Determine eligibility only from locked immutable values: `source === 'email'`, raw `parsed.paymentType` normalizes to `credit card`, and type is exactly `expense`. If amount changed and eligible, calculate `newAmount - oldAmount`; call `applyCreditCardCycleUsageDelta` using same transaction client. A thrown summary query rolls back both writes through existing `DatabaseService.withTransaction`. Do not alter `credit_limit` or `statement_balance`.

- [ ] **Step 6: Run focused update suite**

Run: `npm test -- --test-name-pattern="web transactions.*(update|credit-card|conflict)"`

Expected: PASS; check no summary query for non-card or non-amount patch and signed increase/decrease values for eligible expense.

- [ ] **Step 7: Add the PATCH route and commit the vertical slice**

Add `@Patch(':id')` controller delegation and its focused test in this task.
Call the real `WebTransactionsService.updateTransaction` directly; do not use a
type assertion or placeholder method.

```bash
git add src/veyra/transactions/web-transactions.repository.ts src/veyra/transactions/web-transactions.repository.spec.ts src/veyra/transactions/web-transactions.service.ts src/veyra/transactions/web-transactions.service.spec.ts src/veyra/transactions/web-transactions.controller.ts src/veyra/transactions/web-transactions.controller.spec.ts
git commit -m "feat(transactions): edit web transactions safely"
```

### Task 5: Document external boundary and verify complete Core slice

**Files:**

- Modify: `README.md:224-360` (add a standalone Transactions Web API section immediately after dashboard docs)
- Modify: `src/veyra/transactions/web-transactions.controller.spec.ts`

**Interfaces:**

- Documents final Task 2-4 endpoints without changing their types.

- [ ] **Step 1: Write failing endpoint-boundary documentation test**

```ts
test('web transaction routes are registered under the globally API-key-guarded app', () => {
  assert.equal(WebTransactionsController.name, 'WebTransactionsController');
  assert.match(readFileSync('src/app.module.ts', 'utf8'), /provide: APP_GUARD/);
  assert.match(readFileSync('src/app.module.ts', 'utf8'), /useClass: ApiKeyGuard/);
});
```

- [ ] **Step 2: Add README contracts**

Document `POST /api/veyra/transactions/query` and `PATCH /api/veyra/transactions/:id` with exact JSON examples from approved spec, response fields, opaque cursors, all status outcomes, confirmed-income/expense scope, server-verified Telegram identity, and `x-core-api-key`. State browser must not call Core, raw payload never returns, amount change on eligible confirmed email credit-card row atomically changes cycle `credit_used`, and limit/statement balance never change.

- [ ] **Step 3: Run full automated verification**

Run: `npm test`

Expected: PASS.

Run: `npm run lint && npm run build`

Expected: PASS with no TypeScript or ESLint errors.

- [ ] **Step 4: Review query and transaction safety manually**

Confirm SQL has no interpolated input; query and PATCH resolve active Telegram user before transaction access; list/update have matching finalized scope; cursor both directions returns UI-descending rows; repository locks before version check; card summary receives only amount delta; `credit_limit` / `statement_balance` never appear in UPDATE SQL.

- [ ] **Step 5: Commit docs and final tests**

```bash
git add README.md src/veyra/transactions/web-transactions.controller.spec.ts
git commit -m "docs(transactions): document web API boundary"
```

## Plan Self-Review

- Spec coverage: Task 2 supplies contract types before services; Task 3 then supplies service/controller/module registration and exact endpoints. Tasks 3-4 cover active-user scope, Core-owned cycle boundaries, finalized income/expense scope, URL-supporting filters, categories, opaque two-way keyset pagination, precise timestamp/version text, editable-only fields, locked final-state validation/no-op rejection, foreign/missing indistinguishability, conflicts, and eligible expense-card signed delta. Task 5 covers API-key/server ownership and full verification. No creation, deletion, schema migration, raw-payload exposure, date/type/source/status edits, web reversal edits, or per-card modeling is introduced.
- Placeholder scan: Plan contains no `TODO`, `TBD`, “implement later”, or unspecified error-handling steps. Each task includes failing test, command, implementation detail, passing command, and commit.
- Type consistency: Task 2 declares DTOs before Task 3 controller imports them; Task 3 creates service before registering controller/module. Controller consumes `queryTransactions` and `updateTransaction`; both are produced by Task 3/4 service. Repository result union includes all service-mapped `not_found`, `conflict`, `invalid`, `no_change`, and `updated` kinds. Shared helper signature is used by Task 1 extraction and Task 4 repository. Public response uses only `WebTransactionDto` fields and timestamp strings retain microseconds.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-13-web-transactions-api.md`. Two execution options:

1. Subagent-Driven (recommended) - dispatch a fresh subagent per task, review between tasks, fast iteration.
2. Inline Execution - execute tasks in this session using executing-plans, batch execution with checkpoints.
