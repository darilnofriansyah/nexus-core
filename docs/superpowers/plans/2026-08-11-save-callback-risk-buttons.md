# Save Callback Risk Buttons Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Attach the existing Watchdog risk-review keyboard to the combined Telegram message returned after `save_transaction:{transactionId}` succeeds.

**Architecture:** Keep the current confirmation, Watchdog evaluation, aggregated text, and single-message n8n delivery unchanged. At the Core callback boundary, select the pending `risk_review` notification returned by `confirmTransaction()` and pass its existing `reply_markup` through `transactionCallbackOk()`; fall back to null when no risk-review keyboard exists.

**Tech Stack:** NestJS 10, TypeScript 5.7, Node.js test runner, Telegram inline keyboard payloads

## Global Constraints

- Preserve the current combined confirmation/risk/budget text.
- Edit the original Telegram confirmation message; do not send a second message.
- Preserve Watchdog callback data without reconstruction or sorting.
- Keep `reply_markup` null when no pending risk review is returned.
- Do not change DTOs, database schema, dependencies, or n8n workflows.
- Do not deploy or modify production.
- Preserve the unrelated existing `PROJECT_REVIEW.md` working-tree change.

---

### Task 1: Propagate the Risk-Review Keyboard Through Save Callback

**Files:**
- Modify: `src/veyra/transactions/transaction.service.ts:4482-4500`
- Test: `src/veyra/transactions/transaction.service.spec.ts:2566-2593`
- Modify: `README.md:1781-1832`

**Interfaces:**
- Consumes: `ConfirmTransactionResponseDto.notifications?: TransactionWatchdogNotificationDto[]`, where a pending risk review has `type: "risk_review"` and an optional `reply_markup`.
- Produces: the existing `TransactionCallbackHandleResponseDto.telegram.reply_markup: object | null`, populated with the unmodified risk-review keyboard for successful `save_transaction` callbacks.

- [ ] **Step 1: Add a failing save-callback keyboard test**

Add this focused test immediately after `handles save_transaction callback with Telegram edit payload` in `src/veyra/transactions/transaction.service.spec.ts`:

```ts
test("handles save_transaction callback with risk-review keyboard", async () => {
  const { service } = createService([
    [{ ...transaction, id: "123", user_id: "1" }],
    [],
  ]);
  const riskReplyMarkup = watchdogN8nFixture.notifications.riskReplyMarkup;

  spyOnWatchdog(service, {
    notifications: [
      {
        type: "risk_review",
        priority: 1,
        severity: "high",
        review_id: 55,
        message: watchdogN8nFixture.notifications.messages[0],
        reply_markup: riskReplyMarkup,
      },
    ],
  });

  const result = await service.handleTransactionCallback({
    telegramUserId: "976684739",
    userId: 1,
    callbackData: "save_transaction:123",
    chatId: "chat-1",
    messageId: 42,
  });

  assert.equal(result.status, "ok");
  assert.equal(result.action, "save_transaction");
  assert.match(result.telegram.text, /Large transaction detected/);
  assert.deepEqual(result.telegram.reply_markup, riskReplyMarkup);
});
```

Retain the existing `handles save_transaction callback with Telegram edit payload` assertion that ordinary confirmations return `reply_markup: null`. Together, the two tests cover both branches of the contract.

- [ ] **Step 2: Compile and run the focused tests to verify the new test fails**

Run:

```bash
npx tsc -p tsconfig.test.json
node --test \
  --test-name-pattern="handles save_transaction callback" \
  dist-test/src/veyra/transactions/transaction.service.spec.js
```

Expected: TypeScript compilation succeeds; the new risk-review test fails because `result.telegram.reply_markup` is `null`, while the existing ordinary-confirmation test passes.

- [ ] **Step 3: Implement the minimal callback propagation**

In the successful `save_transaction` branch of `handleTransactionCallback()`, select the existing risk-review markup after `confirmTransaction()` returns:

```ts
const riskReplyMarkup =
  result.notifications?.find(
    (notification) =>
      notification.type === "risk_review" && notification.reply_markup,
  )?.reply_markup ?? null;
```

Then replace the hard-coded `replyMarkup: null` in that successful branch with:

```ts
replyMarkup: riskReplyMarkup,
```

Do not change the cancel, category, risk-action, error, or already-answered callback branches. Do not reconstruct the four buttons; reuse the Watchdog payload unchanged.

- [ ] **Step 4: Run the focused tests to verify both keyboard branches pass**

Run:

```bash
npx tsc -p tsconfig.test.json
node --test \
  --test-name-pattern="handles save_transaction callback" \
  dist-test/src/veyra/transactions/transaction.service.spec.js
```

Expected: exit code `0`; both the ordinary null-markup case and the pending risk-review keyboard case pass.

- [ ] **Step 5: Document the save-callback behavior**

In `README.md`, directly after the paragraph beginning `For change_categories:{transactionId}` in the transaction callback section, add:

```markdown
For a successful `save_transaction:{transactionId}`, Core runs Watchdog and
keeps the existing aggregated confirmation text. When Watchdog returns a
pending `risk_review`, `telegram.reply_markup` contains that review's existing
`planned`, `necessary`, `regret`, and `ignore` keyboard; otherwise it is null.
n8n should pass this field through unchanged when editing the original
confirmation message. Clicking a risk action replaces the combined message
with the existing acknowledgement or regret-note prompt and removes the
keyboard.
```

- [ ] **Step 6: Run complete verification**

Run each command separately and require exit code `0`:

```bash
npm test
npm run build
npm run lint
git diff --check
```

Confirm the diff contains changes only to:

```text
README.md
src/veyra/transactions/transaction.service.ts
src/veyra/transactions/transaction.service.spec.ts
```

Ignore but do not alter the pre-existing `PROJECT_REVIEW.md` modification.

- [ ] **Step 7: Commit the implementation**

```bash
git add README.md \
  src/veyra/transactions/transaction.service.ts \
  src/veyra/transactions/transaction.service.spec.ts
git commit -m "fix(transactions): show risk buttons after save"
```

Do not deploy or modify any n8n workflow after committing.
