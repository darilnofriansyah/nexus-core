# Watchdog Outbound Notification Delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver Core's ordered `risk_review`, `budget_alert`, and `burn_rate` notifications from the manual and email n8n workflows without duplicating their base Telegram response.

**Architecture:** Add a backward-compatible `baseMessage` field to the two Core response contracts while retaining the existing aggregated fields. In each authorized n8n workflow, reuse the existing payload Code node to emit base plus notification items in Core order, process them through a batch-size-one loop, and reuse Telegram Reliable Sender.

**Tech Stack:** NestJS 10, TypeScript 5.7, Node test runner, n8n Workflow SDK

## Global Constraints

- Scope only workflows `rbKbj56pSbMU5vTp` and `li32iEVL1omy7bJb`.
- Preserve `risk_review.reply_markup` unchanged.
- Do not sort or parse notification strings in n8n.
- Do not rerun the completed production database migration.
- Do not modify, publish, execute, or deploy production until separately authorized.
- Preserve unrelated dirty changes and add no dependency.

---

### Task 1: Add the backward-compatible Core base message

**Files:**
- Modify: `src/veyra/transactions/dto/handle-transaction.dto.ts`
- Modify: `src/veyra/transactions/dto/email-transaction.dto.ts`
- Modify: `src/veyra/transactions/transaction.service.ts`
- Test: `src/veyra/transactions/transaction.service.spec.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: existing aggregated manual `message`, email `telegram.text`, and ordered `notifications`.
- Produces: optional manual `baseMessage` and email `baseMessage`, containing only the existing base Telegram text.

- [x] **Step 1: Add failing service tests**

Add focused manual and confirmed-email assertions that `baseMessage` equals the literal base response while the existing aggregated field still contains the Watchdog section. Keep the fixture assertion that `risk_review.reply_markup` deep-equals the recorded mapping.

- [x] **Step 2: Verify the tests fail for the missing contract**

Run:

```bash
npx tsc -p tsconfig.test.json
```

Expected: fail because `baseMessage` is absent from both response DTOs.

- [x] **Step 3: Add the minimal DTO and service fields**

Add:

```ts
baseMessage?: string;
```

to both response interfaces. In `buildHandleResponse()`, return the unaggregated confirmed message as `baseMessage`. In `buildEmailResponse()`, calculate the base Telegram text once, expose it as `baseMessage`, and continue passing the same value through `appendWatchdogMessage()` for the legacy `telegram.text` field.

- [x] **Step 4: Verify focused and full Core behavior**

Run:

```bash
npx tsc -p tsconfig.test.json
node --test --test-name-pattern="base message|watchdog preserves n8n fixture order" dist-test/src/veyra/transactions/transaction.service.spec.js
npm test
npm run build
npm run lint
git diff --check
```

Expected: all commands exit `0`; the focused test reports no failures.

- [x] **Step 5: Document the n8n payload contract**

Document manual `data.baseMessage`/`data.notifications` and email `baseMessage`/`notifications`, including direct `reply_markup` passthrough and the required notification order.

---

### Task 2: Prepare the authorized n8n mapping

**Files:**
- Read-only source: workflow `rbKbj56pSbMU5vTp`, version `0a3be7fe-09ca-4c34-a362-272c6f856dcb`
- Read-only source: workflow `li32iEVL1omy7bJb`, version `e1f38c5e-d6d1-4fe1-84fc-c7ec0eb9b446`

**Interfaces:**
- Consumes: `baseMessage` plus ordered `notifications` from Task 1.
- Produces after separate authorization: base-first, serial Telegram Reliable Sender inputs with unchanged risk-review keyboard data.

- [x] **Step 1: Recheck version IDs before preparing any update**

Stop if either current or active version differs from the IDs above; inspect and report the drift without mutation.

- [x] **Step 2: Read the n8n SDK and exact node types**

Before writing workflow code, retrieve the SDK reference, suggested flow-control nodes, and exact types for Code, Loop Over Items, and Execute Sub-workflow.

- [x] **Step 3: Build and validate workflow code**

For each existing payload Code node, emit the base item first and then:

```js
...notifications.map((notification) => ({
  json: {
    chat_id,
    text: notification.message,
    parse_mode: 'HTML',
    reply_markup: notification.reply_markup ?? null,
    disable_web_page_preview: true,
    bot_token_env: 'VEYRA_TOKEN',
  },
}))
```

Use Loop Over Items with batch size `1`; route its done output to the email Gmail-label node so the label remains single-shot. Validate both workflows before saving the authorized drafts.

- [x] **Step 4: Request and receive draft-save authorization**

Report the validated node diff, version guard, rollback version, and test plan. Draft saves were authorized first; production deployment, publication, and controlled Telegram tests were authorized and completed afterward.

- Manual draft: `9599e670-a3f5-4a54-ac75-17f9ca1077e1`; active rollback version: `0a3be7fe-09ca-4c34-a362-272c6f856dcb`.
- Email draft: `ad909cad-4ccb-48f3-8219-aa588479455d`; active rollback version: `e1f38c5e-d6d1-4fe1-84fc-c7ec0eb9b446`.
- Core commit `7f18873` deployed successfully; both draft versions are active.
- Controlled executions `3949` and `3954` delivered base plus all three notifications in order.
