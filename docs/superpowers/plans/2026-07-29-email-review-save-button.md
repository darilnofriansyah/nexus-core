# Email Review Save Button Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hide Save from pending email reviews that cannot pass the existing expense confirmation guard.

**Architecture:** Extract the current email confirmation checks into one helper that returns the validation error, then reuse it in the throwing guard and email review keyboard builder. Pass the pending transaction to the keyboard builder at both deterministic and AI review response sites.

**Tech Stack:** NestJS, TypeScript, `node:test`, `node:assert/strict`

## Global Constraints

- Keep Save for confirmable expenses and income transactions.
- Hide Save for expenses with a missing or unknown merchant or category.
- Keep Edit Details, Change Category, and Cancel available.
- Preserve backend validation against stale callbacks.
- Do not change the database, endpoints, callback formats, n8n workflows, or dependencies.

---

### Task 1: Make Email Review Actions Match Confirmation Validation

**Files:**
- Modify: `src/veyra/transactions/transaction.service.ts:1140-1152`
- Modify: `src/veyra/transactions/transaction.service.ts:2751-2777`
- Modify: `src/veyra/transactions/transaction.service.ts:4045-4057`
- Modify: `src/veyra/transactions/transaction.service.ts:5868-5896`
- Test: `src/veyra/transactions/transaction.service.spec.ts:3255-3280`
- Test: `src/veyra/transactions/transaction.service.spec.ts:3954-3983`
- Test: `src/veyra/transactions/transaction.service.spec.ts:4150-4224`

**Interfaces:**
- Consumes: `EmailTransactionHandleResponseDto["transaction"]` and `TransactionRow`
- Produces: `emailTransactionConfirmationError(...)`, returning the existing error message or `null`
- Produces: `buildEmailReviewReplyMarkup(transaction)`, returning the existing keyboard without Save when the helper returns an error

- [x] **Step 1: Add failing keyboard assertions**

Extend the existing category-unresolved and merchant-alias-unresolved tests:

```ts
const callbacks =
  result.replyMarkup?.inline_keyboard
    .flat()
    .map((button) => button.callback_data) ?? [];

assert.equal(
  callbacks.some((callback) => callback.startsWith("save_transaction:")),
  false,
);
assert.ok(
  callbacks.some((callback) => callback.startsWith("change_categories:")),
);
assert.ok(
  callbacks.some((callback) => callback.startsWith("edit_email_details:")),
);
assert.ok(
  callbacks.some((callback) => callback.startsWith("cancel_transaction:")),
);
```

Extend a valid pending expense review and the existing income review with:

```ts
assert.ok(
  result.replyMarkup?.inline_keyboard
    .flat()
    .some((button) => button.callback_data.startsWith("save_transaction:")),
);
```

- [x] **Step 2: Run the focused tests and verify failure**

Run:

```bash
npx tsc -p tsconfig.test.json
node --test --test-name-pattern="merchant alias is missing|known template without category|keeps every AI result pending|preserves missing merchant behavior for a non-expense AI candidate" dist-test/src/veyra/transactions/transaction.service.spec.js
```

Expected: unresolved-review assertions fail because their keyboards still contain `save_transaction:*`; valid expense and income assertions pass.

- [x] **Step 3: Share the confirmability decision**

Add a helper beside the existing guard:

```ts
private emailTransactionConfirmationError(input: {
  transactionType: string | null | undefined;
  merchant: string | null | undefined;
  merchantNormalized: string | null | undefined;
  category: string | null | undefined;
}): string | null {
  if (this.cleanString(input.transactionType)?.toLowerCase() !== "expense") {
    return null;
  }

  const merchant = this.cleanString(
    input.merchantNormalized ?? input.merchant ?? undefined,
  );
  const category = this.cleanString(input.category ?? undefined);

  if (!merchant || this.isUnknownMerchant(merchant)) {
    return "email transaction merchant must be corrected before confirmation";
  }

  if (
    !category ||
    category.toLowerCase() === "uncategorized" ||
    category.toLowerCase() === "unknown"
  ) {
    return "email transaction category must be selected before confirmation";
  }

  return null;
}
```

Refactor the existing guard without changing its messages:

```ts
private assertConfirmableEmailTransaction(transaction: TransactionRow): void {
  const error = this.emailTransactionConfirmationError({
    transactionType: transaction.transaction_type,
    merchant: transaction.merchant,
    merchantNormalized: transaction.merchant_normalized,
    category: transaction.category,
  });

  if (error) {
    throw new BadRequestException(error);
  }
}
```

- [x] **Step 4: Hide Save in both email review response paths**

Change the keyboard builder to accept the pending transaction and conditionally
include Save:

```ts
private buildEmailReviewReplyMarkup(
  transaction: NonNullable<EmailTransactionHandleResponseDto["transaction"]>,
): TelegramReplyMarkupDto {
  const error = this.emailTransactionConfirmationError({
    transactionType: transaction.transactionType,
    merchant: transaction.merchant,
    merchantNormalized: transaction.merchantNormalized,
    category: transaction.category,
  });

  return {
    inline_keyboard: [
      [
        ...(!error
          ? [
              {
                text: "Save",
                callback_data: this.saveTransactionCallbackData(transaction.id),
              },
            ]
          : []),
        {
          text: "Edit Details",
          callback_data: `edit_email_details:${transaction.id}`,
        },
      ],
      [
        {
          text: "Change Category",
          callback_data: this.changeCategoriesCallbackData(transaction.id),
        },
        {
          text: "Cancel",
          callback_data: this.cancelTransactionCallbackData(transaction.id),
        },
      ],
    ],
  };
}
```

At the AI review response, replace:

```ts
replyMarkup: this.buildEmailReviewReplyMarkup(transaction.id),
```

with:

```ts
replyMarkup: this.buildEmailReviewReplyMarkup(transaction),
```

In `buildEmailResponse`, retain the pending transaction rather than only its ID:

```ts
const pendingReview =
  input.status === "needs_review" && input.transaction?.status === "pending"
    ? input.transaction
    : null;
```

Then build actions and markup with:

```ts
...(pendingReview
  ? {
      actions: this.buildEmailReviewActions(pendingReview.id),
      replyMarkup: this.buildEmailReviewReplyMarkup(pendingReview),
    }
  : {}),
```

- [x] **Step 5: Run focused and full verification**

Run:

```bash
npx tsc -p tsconfig.test.json
node --test dist-test/src/veyra/transactions/transaction.service.spec.js
npm run lint
git diff --check
```

Expected: transaction service tests pass, lint passes, and `git diff --check`
reports no errors.

- [x] **Step 6: Commit**

```bash
git add src/veyra/transactions/transaction.service.ts src/veyra/transactions/transaction.service.spec.ts docs/superpowers/plans/2026-07-29-email-review-save-button.md
git commit -m "fix: hide invalid email save action"
```
