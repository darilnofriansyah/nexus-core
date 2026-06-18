# Veyra/Aegis n8n -> NestJS Parity Audit

## Summary

This is a read-only parity audit between the active production n8n workflows inspected through n8n MCP and the current NestJS Core API implementation in `core-api`.

The migrated NestJS endpoints preserve some isolated calculations, especially budget cycle calculation, budget threshold selection, and parts of transaction type normalization. They do not yet preserve several production n8n integration contracts. The highest-risk gaps are callback data incompatibility, transaction confirmation using a different persistence model, budget SQL column mismatches, missing alert insertion/message building in the overspending endpoint, and an intent classifier that is deterministic/rule-based rather than equivalent to the production LLM classifier.

Overall, only Aegis formatting and simple budget status/upsert pieces are close enough to pilot behind n8n with careful payload mapping. Transaction confirmation/category flows and intent classification are not safe to replace yet.

## Audited Sources

- Production n8n MCP, read-only:
  - `Aegis Error Watchdog` (`6f2d9eViYKJpQ0vb`)
  - `Message Workflow` (`Hgg3O0fZx8XsmMfM`)
  - `Callback Workflow` (`oXuLf0DvtlinpcvK`)
  - `Veyra Email Workflow` (`G9s1zlDJSVS2PlQK`)
  - `Overspend Check` (`iiRUnIadevhz1rGz`)
  - `Normalizer and Categorizer` (`6He4UcrKDLZS4rCP`)
  - `Transaction Resolver` (`qRPbUCd98R1thz3T`)
  - `Veyra Conversational Agent` (`kcr7sHYgmvouoVuF`)
  - `Veyra Analytics Conversation Workflow` (`bcSWi07JdiXkfbBW`)
- Local workflow JSON fallback/reference:
  - `veyra-n8n-workflows/workflows/aegis/error-watchdog-reliable.json`
  - `veyra-n8n-workflows/workflows/veyra/email-workflow-reliable-telegram.json`
  - `veyra-n8n-workflows/workflows/veyra/conversational-agent-reliable-telegram.canvas-paste.json`
- NestJS Core API:
  - `core-api/src/aegis/aegis-alert-formatter.service.ts`
  - `core-api/src/aegis/aegis.controller.ts`
  - `core-api/src/veyra/veyra.controller.ts`
  - `core-api/src/veyra/budgets/budget.service.ts`
  - `core-api/src/veyra/transactions/transaction.service.ts`
  - `core-api/src/veyra/intents/intents.service.ts`

## Overall Findings

- Callback data is not compatible. Production uses `save_transaction:{id}`, `cancel_transaction:{id}`, `change_categories:{id}`, `catid:{budget_id}:{transaction_id}`, `save_edit_transaction`, `cancel_edit_transaction`, and `select_transaction:{id}`. NestJS emits `tx_confirm:{pendingTransactionId}`, `tx_category:{pendingTransactionId}`, `tx_reject:{pendingTransactionId}`, and `tx_set_category:{pendingTransactionId}:{slug}`.
- Telegram message text is not compatible for Aegis, transaction confirmation, category selection, and overspending alerts. NestJS usually returns structured data or new text; production n8n sends exact user-facing copy through reliable sender/editor workflows.
- SQL filters partly match for confirmed expense spending, but several details differ: `budgets.amount` vs `budgets.budget_amount`, `is_active = true` filtering, `merchant_aliases.alias_name/canonical_name` vs `alias/merchant_normalized`, and exact/LIKE matching differences.
- Monthly cycle calculation mostly matches the n8n cycle-start-day logic for normal dates. NestJS uses UTC date arithmetic and clamps impossible cycle days to the last day of month; n8n SQL `make_date(..., cycle_start_day)` can fail for invalid days in short months unless data is already constrained.
- Transaction status handling differs. Production writes directly into `transactions` with `status = 'pending'`, later updates that row to `confirmed` or `rejected`. NestJS confirms from `pending_transactions`, inserts a new `transactions` row, and marks the pending row resolved.
- Pending transaction handling is incompatible with production n8n because the active normalizer inserts pending records into `transactions`, despite node names saying "pending transaction".
- Budget parent/child behavior is only partially preserved. NestJS budget status aggregates selected budget plus children, but active n8n status has different shapes for single-budget vs all-budget queries, and overspend checks only the direct category budget.
- Duplicate alert prevention is only partially preserved. NestJS checks `budget_alerts` but does not insert the alert row, while n8n inserts a row before sending.
- Error response behavior changed from workflow-failure behavior in n8n to Nest exceptions (`400`, `404`) in NestJS. This is appropriate for an API but requires n8n HTTP Request error branches before switching.

## Area-by-Area Comparison

### 1. Aegis Error Formatter
- n8n behavior: `Aegis Error Watchdog` builds an incident object from the Error Trigger, then formats an HTML Telegram payload with header `<b>AEGIS INCIDENT</b>`, separator lines, severity, hard-coded `Service: Veyra`, workflow, node, execution number, mode, error message, execution URL, `parse_mode: HTML`, `disable_web_page_preview: true`, `bot_token_env: AEGIS_TOKEN`, and a fixed Aegis chat id. It escapes HTML and truncates text over 3900 characters.
- NestJS behavior: `POST /aegis/n8n-error` returns `{ chatText, severity, workflowId, executionId, executionUrl }`. It accepts several raw n8n shapes and normalizes workflow/execution/error references. Text is plain, starts with `Aegis ERROR alert`, includes workflow id in parentheses, error, node, execution, URL, and timestamp if present.
- Match status: Partial.
- Gaps: NestJS does not produce the reliable sender payload fields, does not use the same HTML text, does not escape as HTML, does not truncate at 3900 characters, does not include `parse_mode`, `disable_web_page_preview`, `bot_token_env`, or `chat_id`, and does not preserve the exact `AEGIS INCIDENT` layout.
- Risk: Medium.
- Recommendation: Add an n8n-compatible response mode or formatter that returns the exact production reliable-sender payload, including HTML escaping and truncation. Keep the current structured fields if useful, but do not replace the n8n formatter until text/payload compatibility is explicit.

### 2. Budget Status
- n8n behavior: `Message Workflow` has budget status SQL that calculates the user cycle from `telegram_users.cycle_start_day`, filters `transactions` by `transaction_type = 'expense'`, `status = 'confirmed'`, and cycle range, and supports parent budgets by summing child budget amounts/spending. Category lookup is case-insensitive. Messages render `Spent`, `Remaining`, percent, and optional child breakdown.
- NestJS behavior: `POST /veyra/budgets/status` accepts `userId` or `telegramUserId`, resolves cycle start day, calculates cycle start/end in UTC, selects a matching budget case-insensitively, includes direct children in `budget_scope`, sums confirmed expense spending, and returns numeric status fields.
- Match status: Partial.
- Gaps: NestJS queries `b.budget_amount`, but active n8n production SQL uses `budgets.amount`. If production schema is still `amount`, the endpoint will fail. NestJS does not filter `COALESCE(is_active, true)`, does not return child breakdown, and does not format Telegram status messages. Parent budget aggregation is simpler than n8n's all-budget query and may over-include parent self category plus child categories when n8n sometimes treats parent amount/children differently.
- Risk: High if production schema uses `amount`; Medium otherwise.
- Recommendation: Align the budget column names with production before switching. Add `is_active` handling and child breakdown fields if this endpoint replaces status display, or document that n8n remains responsible for rendering and child detail.

### 3. Budget Upsert
- n8n behavior: `Message Workflow` handles set-budget intents through budget agent parsing. Single-category upsert checks exact `user_id` + `category`, updates `amount` if found, or inserts with `user_id`, `category`, `amount`, `is_active: true`, and a static `created_at` value in the current active workflow. Parent/child creation searches parent budgets, creates a parent if missing, then upserts a child category under it. Matching appears case-sensitive in the exact found check.
- NestJS behavior: `POST /veyra/budgets/upsert` validates `userId`, `category`, positive `amount`, monthly `periodType`, optionally resolves an existing `parentCategory`, and performs `INSERT ... ON CONFLICT (user_id, category) DO UPDATE`, setting `budget_amount`, `period_type`, and optionally `parent_budget_id`.
- Match status: Partial.
- Gaps: Same `amount` vs `budget_amount` schema risk. NestJS requires the parent budget to already exist and throws `404`; production n8n creates the parent if missing. NestJS does not set `is_active`. It preserves `parent_budget_id` on amount-only updates, which is a useful behavior but not clearly identical to n8n for all branches. Case-sensitivity may differ depending on DB constraints.
- Risk: High if production schema uses `amount`; Medium otherwise.
- Recommendation: Match production column names and parent creation semantics, or split endpoints into `upsertSingleBudget` and `upsertChildBudget` with documented n8n call patterns. Add `is_active` preservation/default behavior.

### 4. Overspending Check
- n8n behavior: `Overspend Check` loads `telegram_users` by `id`, calculates cycle start from `cycle_start_day`, selects active direct category budget with `b.amount AS budget_amount`, sums confirmed expense transactions for the same direct category, computes rounded one-decimal `spent_percent`, resolves alert types at 80/100/120, checks `budget_alerts` by `budget_id`, `alert_type`, and `period_key`, inserts a `budget_alerts` row when missing, and sends an HTML Telegram alert.
- NestJS behavior: `POST /veyra/budgets/overspending-check` calls `getBudgetStatus`, resolves alert type at 80/100/120, derives `periodKey` as `YYYY-MM` from `cycle_start`, checks `budget_alerts` by `user_id`, `budget_id`, `alert_type`, and `period_key`, and returns `shouldAlert` plus budget numbers.
- Match status: Partial.
- Gaps: NestJS does not insert `budget_alerts`, so duplicate prevention is not durable if n8n sends the alert. Period key differs: n8n stores full cycle start date (`YYYY-MM-DD`) despite naming it `period_key`; NestJS uses `YYYY-MM`. NestJS includes `user_id` in alert lookup but n8n's active check does not. NestJS aggregates child categories through `getBudgetStatus`, while n8n checks only direct category spending. NestJS does not build/send the production HTML alert text.
- Risk: High.
- Recommendation: Decide endpoint responsibility. If NestJS owns duplicate prevention, insert the alert in the same operation and use the same `period_key` shape as production or migrate existing data deliberately. If n8n remains responsible for alert insertion/sending, return enough data to preserve the current message exactly.

### 5. Transaction Normalization
- n8n behavior: `Veyra Email Workflow` parses BCA/Mandiri/Krom emails into `{ email_id, merchant, amount, transaction_date, bank, payment_type, type, confidence, is_transaction }`. `Normalizer and Categorizer` requires non-zero amount, normalizes merchant by `merchant_aliases` using `LOWER($merchant) LIKE '%' || alias_name || '%'`, maps category by exact `category_rules.merchant_pattern`, auto-inserts high-confidence known categories into `transactions`, otherwise uses an LLM categorizer, inserts pending `transactions` rows with `status: pending`, and upserts `merchant_review_queue`.
- NestJS behavior: `POST /veyra/transactions/normalize` accepts already-parsed transaction data, normalizes transaction type to lowercase constrained values, maps reversal/void/chargeback to `reversal`, maps refund/cashback to `income`, normalizes amount, resolves merchant aliases by exact lower-case `alias`, resolves category rules by exact `merchant_normalized` or `merchant_pattern`, calculates confidence, and returns normalized data without inserting.
- Match status: Partial.
- Gaps: NestJS does not parse email bodies or bank-specific formats. Alias/rule column names and matching semantics differ (`alias_name/canonical_name` LIKE vs `alias/merchant_normalized` exact). It does not implement the LLM categorizer fallback, merchant review queue upsert, high-confidence direct insert, or pending transaction insert. Confidence scale differs: n8n commonly uses `0.95`/`0.98` and LLM `0-100`; NestJS returns `0-95`.
- Risk: Medium for normalization-only use; High if replacing the full n8n normalizer.
- Recommendation: Scope this endpoint as normalization-only, or add a separate email parser/categorizer endpoint that preserves the active workflow's DB lookup semantics, confidence scale, pending behavior, and review queue side effect.

### 6. Transaction Confirmation Payload Builder
- n8n behavior: Manual transaction confirmation in `Message Workflow` sends `Um- I think I understood this correctly...` with `Type`, `Amount`, `Merchant`, `Category`, `Wallet`, `Notes`, and buttons `save_transaction:{id}` and `cancel_transaction:{id}`. Email pending confirmations in `Normalizer and Categorizer` send similar HTML text with `Save`, `Cancel`, and `Change Category` buttons using `save_transaction:{id}`, `cancel_transaction:{id}`, and `change_categories:{id}`.
- NestJS behavior: `POST /veyra/transactions/confirmation-payload` returns text headed `Confirm transaction`, includes `Type`, `Merchant`, `Amount`, `Category`, `Date`, `Source`, optional confidence/warnings, and reply markup with `Approve` (`tx_confirm:*`), `Change Category` (`tx_category:*`), and `Reject` (`tx_reject:*`).
- Match status: No.
- Gaps: Telegram text, button labels, callback data, and field set differ. NestJS omits wallet/notes in the main summary. Production n8n uses transaction row ids; NestJS expects pending transaction ids.
- Risk: High.
- Recommendation: Add production-compatible payload builders for manual and email confirmation, preserving `save_transaction`, `cancel_transaction`, and `change_categories` callback data unless the callback workflow is migrated at the same time.

### 7. Transaction Confirm/Insert
- n8n behavior: `Callback Workflow` handles `save_transaction:*` by updating the existing `transactions.id` row to `status = confirmed` and `updated_at = now`, then edits the Telegram message and calls overspend check. `cancel_transaction:*` updates the same row to `status = rejected`.
- NestJS behavior: `POST /veyra/transactions/confirm` locks a row in `pending_transactions`, inserts a new row into `transactions` with `status = confirmed`, then marks `pending_transactions.resolved = true`. It returns `confirmed`, `not_found`, or `already_resolved`.
- Match status: No.
- Gaps: Different source table, different write pattern, no reject/cancel endpoint, no update of existing `transactions.status`, no Telegram edit payload, and no overspend-check orchestration. It will not find production n8n pending rows because active n8n stores them in `transactions` with `status = pending`.
- Risk: High.
- Recommendation: Either migrate production to a real `pending_transactions` table as a separate approved schema/data migration, or change NestJS confirm/cancel endpoints to operate on existing `transactions` pending rows and preserve status transitions exactly.

### 8. Transaction Change-Category Flow
- n8n behavior: `Callback Workflow` handles `change_categories:{transaction_id}` by loading active user budgets that are leaf categories only, excludes parent budgets with active children, falls back to default categories when no custom categories exist, labels children as `Parent / Child`, truncates labels to 32 characters, and emits `catid:{budget_id}:{transaction_id}` for custom budget categories. It parses only `catid:*` in the current active `Parse Category Choice` node, resolves the budget id against the transaction user, updates `transactions.category`, sets `status = confirmed`, edits the message, and triggers overspend check.
- NestJS behavior: `POST /veyra/transactions/category-options` loads a `pending_transactions` row and returns fixed hard-coded category options (`Food`, `Transport`, `Groceries`, `Bills`, `Health & Beauty`, `Shopping`, `Entertainment`, `Transfer`, `Other`) with `tx_set_category:{pendingTransactionId}:{slug}`. `POST /veyra/transactions/set-category` updates `pending_transactions.category_suggested` and returns a confirmation payload.
- Match status: No.
- Gaps: Different callback data, different category source, no budget leaf-category loading, no parent/child labels, no fallback list parity (`Others` vs `Other`, missing `Education` and `Travel`, extra `Health & Beauty` vs production `Health` fallback), different persistence table, does not confirm the transaction when category is chosen, and does not call overspend check.
- Risk: High.
- Recommendation: Do not replace this n8n flow yet. Implement category options from the production SQL and callback contract, or migrate callback routing and pending storage together as one reviewed change.

### 9. Intent Classifier
- n8n behavior: `Veyra Conversational Agent` uses an LLM (`gpt-5-mini`) with a large schema and intent list: analytics intents, `budget_status`, transaction management (`edit_transaction`, `delete_transaction`), conversation control (`select_transaction`, `confirm_action`, `cancel_action`), and `unknown`. It returns `{ intent, period, merchant, category, limit, target: { type, value }, changes, selection, confidence }`, normalizes confidence, resolves periods with cycle-day-aware dates, routes edit/delete through `Transaction Resolver`, and routes analytics to the analytics workflow.
- NestJS behavior: `POST /veyra/intents/classify` is a deterministic regex classifier. It returns a different interface with `target` as a string, `transactionId`, `budgetParent`, `requiresConfirmation`, missing-field lists, and warnings. It does not support `select_transaction`, `confirm_action`, `cancel_action`, `daily_average_spending`, `most_frequent_merchant`, `spending_by_day`, `weekday_analysis`, `category_comparison`, `merchant_comparison`, or `budget_status` output shape parity with the LLM schema.
- Match status: No.
- Gaps: Different output contract, different intent list, no conversation-state priority, no target object, no selection field, no cycle period resolver output, and no analytics routing parity. It is useful as an early heuristic but not a production classifier replacement.
- Risk: High.
- Recommendation: Treat this as an experimental helper only. To migrate classifier behavior, match the production JSON schema and state-priority rules first, then compare against a fixture set from real n8n classifier examples.

## Compatibility Matrix

| Area | Match | Risk | Action Needed |
|---|---|---|---|
| Aegis error formatter | Partial | Medium | Return production reliable-sender payload and exact HTML/truncation behavior. |
| Budget status | Partial | High | Resolve `amount`/`budget_amount`, `is_active`, and child breakdown parity. |
| Budget upsert | Partial | High | Resolve schema column mismatch and parent auto-create behavior. |
| Overspending check | Partial | High | Align period key, alert insertion, direct-vs-child spending, and Telegram alert payload. |
| Transaction normalization | Partial | Medium/High | Preserve alias/rule SQL semantics, pending insert behavior, LLM fallback, and review queue if replacing full workflow. |
| Confirmation payload builder | No | High | Preserve text and callback data or migrate callback workflow simultaneously. |
| Transaction confirm/insert | No | High | Use production `transactions.status` model or migrate storage deliberately. |
| Change-category flow | No | High | Preserve category SQL, parent/child behavior, callback data, and confirm side effect. |
| Intent classifier | No | High | Match production LLM schema, intent list, and state-priority rules. |
| Callback data compatibility | No | High | Add legacy callback data support before switch. |
| Telegram message text compatibility | Partial/No | High | Add exact text builders where n8n messages are user-visible. |
| SQL filter compatibility | Partial | High | Audit production schema names and filter semantics before routing traffic. |
| Monthly cycle calculation | Mostly | Low/Medium | Confirm timezone and invalid cycle-day behavior. |
| Transaction status handling | No | High | Align `pending`/`confirmed`/`rejected` transitions. |
| Pending transaction handling | No | High | Align `transactions` pending rows vs `pending_transactions`. |
| Budget parent/child behavior | Partial | Medium | Preserve parent aggregation and leaf-category rules per flow. |
| Duplicate alert prevention | Partial | High | Insert/check alerts consistently with same `period_key`. |
| Error response behavior | Changed | Medium | Add n8n HTTP error branches before replacement. |

## Required Fixes Before Production Switch

1. Confirm the production budget schema column name and update NestJS or n8n payloads so `amount`/`budget_amount` is consistent.
2. Preserve legacy callback data or migrate every callback route atomically: `save_transaction:*`, `cancel_transaction:*`, `change_categories:*`, `catid:*`, `save_edit_transaction`, `cancel_edit_transaction`, and `select_transaction:*`.
3. Align transaction confirmation with production storage. Current production pending rows live in `transactions`; NestJS expects `pending_transactions`.
4. Add cancel/reject support to NestJS if transaction confirmation is migrated.
5. Align change-category category source with active budget leaf-category SQL and parent/child label behavior.
6. Decide overspending endpoint ownership. If NestJS owns duplicate prevention, it must insert `budget_alerts` and use the production `period_key` shape.
7. Add production-compatible Telegram text/payload builders for Aegis, transaction confirmation, category selection, confirmation saved/cancelled, and overspending alerts.
8. Match merchant alias/category rule SQL semantics before replacing `Normalizer and Categorizer`.
9. Match the production intent classifier schema and state-priority rules before replacing conversational routing.
10. Add n8n HTTP Request error branches for expected NestJS `400`/`404` responses.

## Safe to Replace in n8n

- Aegis error formatting can be piloted only if n8n maps the current `chatText` into the reliable sender payload and accepts changed message text. It is not a drop-in replacement for the active Aegis payload builder.
- Budget status calculation can be piloted for direct API responses after resolving the budget amount column mismatch. It is not yet a drop-in replacement for Telegram budget status messages or all parent/child display paths.
- Transaction type/amount normalization can be used as a helper for already-parsed transaction payloads. It is not a replacement for bank email parsing or the active normalizer/categorizer workflow.

## Not Safe to Replace Yet

- Overspend Check, because alert insertion, period key, parent/child scope, and Telegram alert payload are not compatible.
- Budget upsert, until schema and parent auto-create behavior are aligned.
- Transaction confirmation payload builder, because callback data and text are incompatible.
- Transaction confirm/cancel, because the persistence model differs from production.
- Transaction change-category flow, because callback data, category source, parent/child behavior, and status side effects differ.
- Intent classifier, because the output schema, supported intents, conversation-state handling, and period resolution do not match production.
