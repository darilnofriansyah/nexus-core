# Email Source Reference Lookup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a user-scoped Core API endpoint that returns the Gmail message ID linked to a pending email transaction.

**Architecture:** Add request/response DTOs to the existing email transaction contract, then expose one `TransactionService` query through `VeyraController`. Query joins `transactions` to `transaction_imports`, requires matching ownership plus pending email status on both rows, and returns one generic `404` for every absent mapping.

**Tech Stack:** NestJS 10, TypeScript 5.7, PostgreSQL, Node test runner

## Global Constraints

- Preserve existing PostgreSQL schema; add no migration.
- Add no dependency.
- Modify no n8n workflow.
- Do not deploy.
- Keep Gmail trigger, refetch, AI invocation, Telegram callbacks, and workflow activation in n8n.
- Accept positive integer strings or numbers for `telegramUserId` and `transactionId`.
- Return normalized string fields `{ transactionId, messageId }`.
- Return `400 Bad Request` for invalid identifiers.
- Return one generic `404 Not Found` for unknown users or missing, foreign-owned, non-email, non-pending, or unlinked transactions.

---

### Task 1: DTO and service lookup

**Files:**
- Modify: `src/veyra/transactions/dto/email-transaction.dto.ts`
- Modify: `src/veyra/transactions/transaction.service.ts`
- Test: `src/veyra/transactions/transaction.service.spec.ts`

**Interfaces:**
- Consumes: `DatabaseService`, `TransactionService.findTelegramUserByTelegramId()`, `TransactionService.isPositiveBigintId()`
- Produces: `EmailSourceReferenceRequestDto`, `EmailSourceReferenceResponseDto`, `TransactionService.getEmailSourceReference(request)`

- [ ] **Step 1: Add failing service tests**

Add `NotFoundException` to NestJS test imports, add DTO imports, then add tests:

```typescript
test("returns Gmail message ID for an owned pending email transaction", async () => {
  const { calls, service } = createService([
    [{ id: "1", telegram_id: "976684739" }],
    [{ transaction_id: "123", source_reference: "gmail-message-id" }],
  ]);

  const result = await service.getEmailSourceReference({
    telegramUserId: "976684739",
    transactionId: 123,
  });

  assert.deepEqual(result, {
    transactionId: "123",
    messageId: "gmail-message-id",
  });
  assert.deepEqual(calls[1]?.values, ["123", "1"]);
  assert.match(calls[1]?.text ?? "", /transaction\\.source = 'email'/);
  assert.match(calls[1]?.text ?? "", /transaction\\.status = 'pending'/);
  assert.match(calls[1]?.text ?? "", /email_import\\.source = 'email'/);
  assert.match(calls[1]?.text ?? "", /email_import\\.status = 'pending'/);
  assert.match(
    calls[1]?.text ?? "",
    /email_import\\.user_id = transaction\\.user_id/,
  );
});

test("rejects invalid email source reference identifiers", async () => {
  const { calls, service } = createService();

  await assert.rejects(
    () =>
      service.getEmailSourceReference({
        telegramUserId: "invalid",
        transactionId: "123",
      }),
    (error: unknown) =>
      error instanceof BadRequestException &&
      error.message === "telegramUserId must be a positive integer",
  );
  await assert.rejects(
    () =>
      service.getEmailSourceReference({
        telegramUserId: "976684739",
        transactionId: "0",
      }),
    (error: unknown) =>
      error instanceof BadRequestException &&
      error.message === "transactionId must be a positive integer",
  );

  assert.equal(calls.length, 0);
});

test("hides unknown users and missing email source mappings behind one 404", async () => {
  const unknownUser = createService([[]]);

  await assert.rejects(
    () =>
      unknownUser.service.getEmailSourceReference({
        telegramUserId: "976684739",
        transactionId: "123",
      }),
    (error: unknown) =>
      error instanceof NotFoundException &&
      error.message === "email source reference was not found",
  );

  const missingMapping = createService([
    [{ id: "1", telegram_id: "976684739" }],
    [],
  ]);

  await assert.rejects(
    () =>
      missingMapping.service.getEmailSourceReference({
        telegramUserId: "976684739",
        transactionId: "123",
      }),
    (error: unknown) =>
      error instanceof NotFoundException &&
      error.message === "email source reference was not found",
  );
});
```

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
npm test
```

Expected: TypeScript compilation fails because `getEmailSourceReference` and its DTOs do not exist.

- [ ] **Step 3: Add DTOs**

Append to `email-transaction.dto.ts`:

```typescript
export interface EmailSourceReferenceRequestDto {
  telegramUserId: string | number;
  transactionId: string | number;
}

export interface EmailSourceReferenceResponseDto {
  transactionId: string;
  messageId: string;
}
```

- [ ] **Step 4: Add minimal service implementation**

Import `NotFoundException`, add:

```typescript
interface EmailSourceReferenceRow {
  transaction_id: string | number;
  source_reference: string;
}
```

Implement:

```typescript
async getEmailSourceReference(
  request: EmailSourceReferenceRequestDto,
): Promise<EmailSourceReferenceResponseDto> {
  const telegramUserId = this.cleanString(String(request.telegramUserId ?? ""));
  const transactionId = this.cleanString(String(request.transactionId ?? ""));

  if (!telegramUserId || !this.isPositiveBigintId(telegramUserId)) {
    throw new BadRequestException(
      "telegramUserId must be a positive integer",
    );
  }
  if (!transactionId || !this.isPositiveBigintId(transactionId)) {
    throw new BadRequestException("transactionId must be a positive integer");
  }

  const user = await this.findTelegramUserByTelegramId(telegramUserId);

  if (!user) {
    throw new NotFoundException("email source reference was not found");
  }

  const result = await this.database.query<EmailSourceReferenceRow>(
    `
      SELECT transaction.id AS transaction_id,
             email_import.source_reference
      FROM transactions AS transaction
      JOIN transaction_imports AS email_import
        ON email_import.transaction_id = transaction.id
       AND email_import.user_id = transaction.user_id
      WHERE transaction.id = $1
        AND transaction.user_id = $2
        AND transaction.source = 'email'
        AND transaction.status = 'pending'
        AND email_import.source = 'email'
        AND email_import.status = 'pending'
      LIMIT 1
    `,
    [transactionId, String(user.id)],
  );
  const row = result.rows[0];
  const messageId = this.cleanString(row?.source_reference);

  if (!row || !messageId) {
    throw new NotFoundException("email source reference was not found");
  }

  return {
    transactionId: String(row.transaction_id),
    messageId,
  };
}
```

- [ ] **Step 5: Run tests and verify GREEN**

Run:

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 6: Commit service contract**

```bash
git add src/veyra/transactions/dto/email-transaction.dto.ts src/veyra/transactions/transaction.service.ts src/veyra/transactions/transaction.service.spec.ts
git commit -m "feat: add email source lookup service"
```

### Task 2: Controller route

**Files:**
- Modify: `src/veyra/veyra.controller.ts`
- Test: `src/veyra/veyra.controller.spec.ts`

**Interfaces:**
- Consumes: `EmailSourceReferenceRequestDto`, `EmailSourceReferenceResponseDto`, `TransactionService.getEmailSourceReference(request)`
- Produces: `POST /api/veyra/transactions/email/source-reference`

- [ ] **Step 1: Add failing controller delegation test**

Extend `createController()` transaction service fake:

```typescript
getEmailSourceReference: async (request: unknown) => {
  calls.push({ method: "getEmailSourceReference", request });
  return { transactionId: "123", messageId: "gmail-message-id" };
},
```

Add:

```typescript
test("/transactions/email/source-reference delegates lookup", async () => {
  const { calls, controller } = createController();
  const request = {
    telegramUserId: "976684739",
    transactionId: "123",
  };

  const result = await controller.getEmailSourceReference(request);

  assert.deepEqual(result, {
    transactionId: "123",
    messageId: "gmail-message-id",
  });
  assert.deepEqual(calls.at(-1), {
    method: "getEmailSourceReference",
    request,
  });
});
```

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
npm test
```

Expected: TypeScript compilation fails because controller method does not exist.

- [ ] **Step 3: Add controller route**

Import DTOs and add beside existing email routes:

```typescript
@Post("transactions/email/source-reference")
getEmailSourceReference(
  @Body() body: EmailSourceReferenceRequestDto,
): Promise<EmailSourceReferenceResponseDto> {
  return this.transactionService.getEmailSourceReference(body);
}
```

- [ ] **Step 4: Run tests and verify GREEN**

Run:

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 5: Commit route**

```bash
git add src/veyra/veyra.controller.ts src/veyra/veyra.controller.spec.ts
git commit -m "feat: expose email source lookup"
```

### Task 3: n8n contract documentation and verification

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-07-28-email-source-reference-lookup-design.md`

**Interfaces:**
- Consumes: `POST /api/veyra/transactions/email/source-reference`
- Produces: documented n8n HTTP Request payload and workflow boundary

- [ ] **Step 1: Document endpoint**

Add before `POST /api/veyra/transactions/email/resolve-review`:

````markdown
### `POST /api/veyra/transactions/email/source-reference`

Resolves the Gmail message ID linked to one user-owned pending email
transaction. This endpoint exists only for the n8n
`edit_email_details:{transactionId}` branch so Gmail can refetch the original
message before AI correction.

Request:

```json
{
  "telegramUserId": "976684739",
  "transactionId": "123"
}
```

Response:

```json
{
  "transactionId": "123",
  "messageId": "gmail-message-id"
}
```

Invalid identifiers return `400`. Unknown users and missing, foreign-owned,
non-email, non-pending, or unlinked transactions return the same `404`.
Core API performs no Gmail request. Gmail refetch, AI regeneration, callback
interception, Telegram handling, and workflow activation remain in n8n.
````

- [ ] **Step 2: Run formatter**

Run:

```bash
npx prettier --write src/veyra/transactions/dto/email-transaction.dto.ts src/veyra/transactions/transaction.service.ts src/veyra/transactions/transaction.service.spec.ts src/veyra/veyra.controller.ts src/veyra/veyra.controller.spec.ts
```

Expected: formatter exits `0`.

- [ ] **Step 3: Run full verification**

Run:

```bash
npm test
npm run lint
npm run build
git diff --check
```

Expected: every command exits `0`.

- [ ] **Step 4: Commit docs and formatting**

```bash
git add README.md docs/superpowers/specs/2026-07-28-email-source-reference-lookup-design.md
git commit -m "docs: add email source lookup contract"
```
