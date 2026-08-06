# Watchdog Regret and Test Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect the Watchdog regret callback to note collection and make plain `npm test` discover every recursive spec.

**Architecture:** Reuse the existing `veyra_regret_note` state and note handler instead of adding a new flow. Reuse the quoted Node test-runner glob already proven by `test:ci`.

**Tech Stack:** NestJS 10, TypeScript 5.7, Node.js test runner.

## Global Constraints

- Preserve unrelated staged and unstaged changes.
- Do not change database schema or add dependencies.
- Keep Telegram delivery and callback orchestration in n8n.
- Do not commit unless the user asks.

---

### Task 1: Connect the regret callback to the existing note state

**Files:**
- Modify: `src/veyra/transactions/transaction.service.ts:4361`
- Test: `src/veyra/transactions/transaction.service.spec.ts:2686`
- Modify: `README.md:1889`

**Interfaces:**
- Consumes: `TransactionHandleStateStore.upsertState()` and the existing `veyra_regret_note` handling in `handleManualTransaction()`.
- Produces: `veyra_risk:<reviewId>:regret` stores `{ review_id, transaction_id }`, asks for a note, and leaves the risk review pending until the note is received.

- [x] **Step 1: Write the failing callback test**

Add a focused test that calls `handleTransactionCallback()` with `veyra_risk:7:regret` and a real state-store fake, then asserts the response text is `What note should I add?`, the stored state is `veyra_regret_note` with review and transaction IDs, and the repository did not resolve the review.

- [x] **Step 2: Run the focused test to verify it fails**

Run: `npx tsc -p tsconfig.test.json && node --test --test-name-pattern="regret callback" dist-test/src/veyra/transactions/transaction.service.spec.js`

Expected: FAIL because no state is created and the review is resolved immediately.

- [x] **Step 3: Implement the minimal state transition**

Pass the existing state store into `handleRiskCallback()`. For `regret`, require `upsertState`, store `veyra_regret_note` with `{ review_id: String(review.id), transaction_id: String(review.transactionId) }`, and return the existing note prompt without resolving. Leave planned, necessary, ignore, missing-review, and duplicate behavior unchanged.

- [x] **Step 4: Update the HTTP contract example**

Change the README regret callback response to `What note should I add?` and state that the review resolves only after the routed reply records the note.

- [x] **Step 5: Run the focused test to verify it passes**

Run: `npx tsc -p tsconfig.test.json && node --test --test-name-pattern="risk|regret note" dist-test/src/veyra/transactions/transaction.service.spec.js`

Expected: PASS.

### Task 2: Make plain npm test discover recursive specs

**Files:**
- Modify: `package.json:10`

**Interfaces:**
- Consumes: Node.js `--test` custom glob handling.
- Produces: `npm test` discovers the same 19 recursive spec files as `npm run test:ci`.

- [x] **Step 1: Record the failing discovery behavior**

Run: `npm test`

Expected before the fix: PASS with only 3 files because the shell expands the unquoted glob.

- [x] **Step 2: Apply the minimal script fix**

Quote `dist-test/src/**/*.spec.js` in the `test` script, matching `test:ci`; add no Jest config or dependency.

- [x] **Step 3: Verify recursive discovery**

Run: `npm test`

Expected: PASS with 19 files.

- [x] **Step 4: Verify project health**

Run: `npm run test:ci && npm run build && npm run lint`

Expected: all commands pass.
