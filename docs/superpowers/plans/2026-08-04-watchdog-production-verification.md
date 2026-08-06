# Watchdog Production Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add sanitized Watchdog mapping fixtures, executable Core contract checks, and an evidence-backed production verification record.

**Architecture:** Reuse the existing transaction service spec and fakes; add no production mapper or dependency. Store one JSON contract shared by ordering and callback assertions, then document the observed read-only database and n8n state separately from future rollout work.

**Tech Stack:** NestJS 10, TypeScript 5.7, Node.js test runner, JSON fixtures, PostgreSQL 16, n8n read-only evidence.

## Global Constraints

- Do not change, test-execute, publish, unpublish, or activate n8n workflows.
- Do not write to the database or apply migrations.
- Do not send production Telegram messages.
- Preserve unrelated staged and unstaged changes.
- Add no dependency or production abstraction.
- Do not commit unless the user asks.

---

### Task 1: Add the Watchdog mapping fixture and executable contract

**Files:**
- Create: `src/veyra/transactions/test/fixtures/watchdog/n8n-mapping.json`
- Modify: `src/veyra/transactions/transaction.service.spec.ts:1-25`
- Modify: `src/veyra/transactions/transaction.service.spec.ts:2635-2805`
- Modify: `src/veyra/transactions/transaction.service.spec.ts:6920-7030`

**Interfaces:**
- Consumes: `TransactionService.evaluateTransactionWatchdog()`, `TransactionService.handleTransactionCallback()`, and existing service/repository/state-store fakes.
- Produces: one sanitized fixture whose `notifications.orderedTypes` is `['risk_review', 'budget_alert', 'burn_rate']` and whose callbacks cover `planned`, `necessary`, `regret`, and `ignore`.

- [ ] **Step 1: Create the sanitized fixture**

Create `n8n-mapping.json` with synthetic IDs and no credentials:

```json
{
  "evidence": {
    "inspectedAt": "2026-08-04",
    "callbackWorkflowId": "oXuLf0DvtlinpcvK",
    "callbackWorkflowVersionId": "52e35cf5-b3cd-43e2-a332-9a09d52fe272",
    "manualWorkflowId": "rbKbj56pSbMU5vTp",
    "manualWorkflowVersionId": "0a3be7fe-09ca-4c34-a362-272c6f856dcb",
    "emailWorkflowId": "li32iEVL1omy7bJb",
    "emailWorkflowVersionId": "e1f38c5e-d6d1-4fe1-84fc-c7ec0eb9b446"
  },
  "notifications": {
    "orderedTypes": ["risk_review", "budget_alert", "burn_rate"],
    "priorities": [1, 2, 3],
    "riskCallbackData": [
      "veyra_risk:55:planned",
      "veyra_risk:55:necessary",
      "veyra_risk:55:regret",
      "veyra_risk:55:ignore"
    ]
  },
  "callbackContext": {
    "telegramUserId": "900000001",
    "userId": 1,
    "chatId": "-100000001",
    "messageId": 42
  },
  "expectedTelegram": {
    "method": "editMessageText",
    "parse_mode": "HTML",
    "reply_markup": null
  },
  "callbacks": [
    {
      "action": "planned",
      "callbackData": "veyra_risk:7:planned",
      "expectedText": "Noted. This purchase was planned.",
      "resolvesImmediately": true
    },
    {
      "action": "necessary",
      "callbackData": "veyra_risk:7:necessary",
      "expectedText": "Noted. This purchase was necessary.",
      "resolvesImmediately": true
    },
    {
      "action": "regret",
      "callbackData": "veyra_risk:7:regret",
      "expectedText": "What note should I add?",
      "resolvesImmediately": false
    },
    {
      "action": "ignore",
      "callbackData": "veyra_risk:7:ignore",
      "expectedText": "Ignored.",
      "resolvesImmediately": true
    }
  ]
}
```

- [ ] **Step 2: Load the fixture in the existing spec**

Add Node standard-library imports and one typed fixture constant:

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";

const watchdogN8nFixture = JSON.parse(
  readFileSync(
    join(
      process.cwd(),
      "src/veyra/transactions/test/fixtures/watchdog/n8n-mapping.json",
    ),
    "utf8",
  ),
) as {
  notifications: {
    orderedTypes: string[];
    priorities: number[];
    riskCallbackData: string[];
  };
  callbackContext: {
    telegramUserId: string;
    userId: number;
    chatId: string;
    messageId: number;
  };
  expectedTelegram: {
    method: "editMessageText";
    parse_mode: "HTML";
    reply_markup: null;
  };
  callbacks: Array<{
    action: "planned" | "necessary" | "regret" | "ignore";
    callbackData: string;
    expectedText: string;
    resolvesImmediately: boolean;
  }>;
};
```

- [ ] **Step 3: Make the existing all-notification ordering test fail**

Rename `budget alert and risk review can return together` to
`watchdog preserves n8n fixture order for all notifications`. First add the
fixture comparisons without changing the existing transaction date or cycle
rows:

```ts
assert.deepEqual(
  result.notifications.map(({ type }) => type),
  watchdogN8nFixture.notifications.orderedTypes,
);
assert.deepEqual(
  result.notifications.map(({ priority }) => priority),
  watchdogN8nFixture.notifications.priorities,
);
assert.deepEqual(
  result.notifications[0].reply_markup?.inline_keyboard
    .flat()
    .map(({ callback_data }) => callback_data),
  watchdogN8nFixture.notifications.riskCallbackData,
);
```

- [ ] **Step 4: Run the focused ordering test and confirm initial failure**

Run:

```bash
npx tsc -p tsconfig.test.json && node --test --test-name-pattern="fixture order" dist-test/src/veyra/transactions/transaction.service.spec.js
```

Expected before adjusting both cycle rows/date: FAIL because output lacks
`burn_rate`.

- [ ] **Step 5: Apply the minimal date/cycle test setup**

Use `today.toISOString()` for the transaction and
`{ cycle_start_day: cycleStartDay }` for both cycle queries. Do not change
production ordering code.

```ts
const today = new Date();
const cycleStartDay = today.getUTCDate();

// In the queued transaction row:
transaction_date: today.toISOString(),

// In both queued cycle rows:
{ cycle_start_day: cycleStartDay }
```

- [ ] **Step 6: Drive callback assertions from the fixture**

Keep the existing dedicated regret-state test. Replace duplicated callback
strings/text for planned, necessary, and ignore with fixture lookups, then
assert each non-regret fixture case resolved with its fixture action. Use the
fixture regret case in the existing regret test and assert no repository
resolve call. Build each request from `callbackContext` plus `callbackData` and
assert returned `method`, `chat_id`, `message_id`, `parse_mode`, and
`reply_markup` against `expectedTelegram`.

```ts
const fixtures = watchdogN8nFixture.callbacks.filter(
  ({ action }) => action !== "regret",
);

for (const fixture of fixtures) {
  const result = await service.handleTransactionCallback({
    ...watchdogN8nFixture.callbackContext,
    callbackData: fixture.callbackData,
  });

  assert.equal(result.telegram.text, fixture.expectedText);
  assert.equal(result.telegram.method, watchdogN8nFixture.expectedTelegram.method);
  assert.equal(result.telegram.chat_id, watchdogN8nFixture.callbackContext.chatId);
  assert.equal(result.telegram.message_id, watchdogN8nFixture.callbackContext.messageId);
  assert.equal(result.telegram.parse_mode, watchdogN8nFixture.expectedTelegram.parse_mode);
  assert.equal(result.telegram.reply_markup, null);
}
```

- [ ] **Step 7: Run focused Watchdog tests**

Run:

```bash
npx tsc -p tsconfig.test.json && node --test --test-name-pattern="risk|regret|watchdog preserves" dist-test/src/veyra/transactions/transaction.service.spec.js
```

Expected: PASS.

---

### Task 2: Record production verification evidence

**Files:**
- Create: `docs/migration/watchdog-production-verification.md`
- Modify: `PROJECT_REVIEW.md:26-34`
- Modify: `README.md:1648`

**Interfaces:**
- Consumes: fixture from Task 1 plus read-only PostgreSQL catalog and n8n workflow evidence gathered on 2026-08-04.
- Produces: authoritative pass/fail record and later rollout criteria without changing production.

- [ ] **Step 1: Write the production verification record**

Record these exact outcomes:

- migration approval: `UNVERIFIED` because no approval or migration ledger exists;
- base table: `PRESENT BUT STALE`;
- `2026-07-12-large-transaction-risk-review-v1.sql`: `NOT APPLIED`;
- DB evidence: 27 reviews, 10 pending, zero non-null responses;
- callback workflow mapping: structurally compatible, no retained `veyra_risk:*` execution;
- notification delivery: `FAIL`, because inspected manual/email workflows do not consume `notifications`;
- production decision: `BLOCKED`, pending migration application and n8n mapping change approval.

Include the safe recheck commands as catalog-only SQL, not migration commands.

- [ ] **Step 2: Update project checklist truthfully**

In `PROJECT_REVIEW.md`, keep migration application and n8n mapping unchecked.
Add nested evidence lines stating the database mismatch, absent callback
execution evidence, and fixture path. Mark only local fixture creation as
complete.

- [ ] **Step 3: Correct stale README ordering text**

Change:

```text
notifications is ordered with risk_review before budget_alert
```

to:

```text
notifications is ordered as risk_review, budget_alert, then burn_rate when present
```

- [ ] **Step 4: Run documentation and focused checks**

Run:

```bash
rg -n "UNVERIFIED|PRESENT BUT STALE|NOT APPLIED|BLOCKED|risk_review.*budget_alert.*burn_rate" docs/migration/watchdog-production-verification.md PROJECT_REVIEW.md README.md
npm test
npm run build
npm run lint
```

Expected: evidence terms found; recursive tests, build, and lint pass.

- [ ] **Step 5: Review the final diff**

Run:

```bash
git diff -- src/veyra/transactions/test/fixtures/watchdog/n8n-mapping.json src/veyra/transactions/transaction.service.spec.ts docs/migration/watchdog-production-verification.md PROJECT_REVIEW.md README.md
```

Confirm no n8n export, credential, database write, migration application, or
unrelated change entered the diff.
