# Watchdog Risk Button Route Coverage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve Watchdog risk-review keyboards on every Telegram confirmation/edit path found by the route audit.

**Architecture:** Reuse the existing `notifications[]` contract and add one private selector in `TransactionService`. Callback and managed-edit delivery fields receive the selected markup; local manual/email workflow exports keep their existing combined text and attach the same markup.

**Tech Stack:** NestJS 10, TypeScript 5.7, Node test runner, n8n workflow JSON

## Global Constraints

- Preserve `risk_review.reply_markup` unchanged.
- Preserve null markup when no risk review exists.
- Do not add dependencies, database changes, or live n8n mutations.
- Preserve unrelated dirty worktree changes.

---

### Task 1: Cover Core callback delivery

**Files:**
- Modify: `src/veyra/transactions/transaction.service.spec.ts`
- Modify: `src/veyra/transactions/transaction.service.ts`

**Interfaces:**
- Consumes: `TransactionWatchdogNotificationDto[] | undefined`.
- Produces: the first `risk_review.reply_markup`, otherwise `null`.

- [x] Add a `catid` regression whose Watchdog result contains the recorded four-button risk keyboard and assert `result.telegram.reply_markup` equals it.
- [x] Run the focused test and verify it fails because the callback currently returns `null`.
- [x] Add `riskReviewReplyMarkup(notifications)` and use it in both `save_transaction` and `catid` callback responses.
- [x] Run the focused callback tests and verify they pass.

### Task 2: Cover managed-edit delivery

**Files:**
- Modify: `src/veyra/transactions/transaction.service.spec.ts`
- Modify: `src/veyra/transactions/transaction.service.ts`

**Interfaces:**
- Consumes: the same Watchdog result from `handleManageConfirmation()`.
- Produces: `TransactionManageHandleResponseDto.reply_markup` containing the selected risk keyboard.

- [x] Extend the managed-edit regression with a literal risk notification and assert the public `reply_markup` field.
- [x] Run the focused test and verify it fails with actual `null`.
- [x] Pass `riskReviewReplyMarkup(watchdog.notifications)` to `manageResponse()`.
- [x] Run focused managed service and callback-controller tests.

### Task 3: Synchronize local n8n delivery exports

**Files:**
- Modify: `/home/unmeii/apps/veyra-n8n-workflows/workflows/veyra/manual-transaction-handle.json`
- Modify: `/home/unmeii/apps/veyra-n8n-workflows/workflows/veyra/email-transaction-ingestion-core-api.json`

**Interfaces:**
- Consumes: manual `data.message`/`data.notifications` and email `coreApi.telegram.text`/`coreApi.notifications`.
- Produces: the existing single sender item with the first risk notification's original `reply_markup`.

- [x] Change each existing payload Code node to select the first risk notification markup.
- [x] Preserve pending confirmation/review keyboards and fallback behavior.
- [x] Validate both JSON files with `jq` and statically inspect their sender connections.

### Task 4: Verify the complete fix

**Files:**
- Verify only: all changed files

- [x] Run focused transaction tests, full `npm test`, `npm run build`, `npm run lint`, and `git diff --check`.
- [x] Confirm unrelated parser/README changes are unchanged and not staged.
- [x] Review the final diff for all audited route mutations: save, category, manage, manual, email, and intentional risk-action keyboard removal.
