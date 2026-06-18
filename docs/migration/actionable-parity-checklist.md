# Veyra/Aegis Actionable Parity Checklist

This checklist turns the parity audit into reviewable migration work. It reflects the current Core API code and README after the latest local changes, so some items are marked improved compared with `parity-audit.md`.

## Current Change Summary

### Changed in Core API

- Aegis has `POST /aegis/n8n-error` and a formatter service that accepts raw-ish n8n error payloads and returns structured alert fields plus `chatText`.
- Veyra budget status has `POST /veyra/budgets/status`, cycle-start-day calculation, confirmed expense spending, inactive budget filtering, parent/child budget scope, and production `budgets.amount` usage.
- Veyra budget upsert has `POST /veyra/budgets/upsert`, writes `budgets.amount`, inserts new rows as active, updates existing rows by `(user_id, category)`, and preserves parent links unless a parent category is explicitly supplied.
- Veyra overspending has `POST /veyra/budgets/overspending-check`, threshold classification at 80/100/120, and duplicate-alert read checks.
- Transaction normalization has `POST /veyra/transactions/normalize`, type normalization, amount normalization, merchant alias lookup, category rule lookup, confidence, and warnings.
- Transaction confirmation payloads now default to production callback names: `save_transaction:{transactionId}`, `cancel_transaction:{transactionId}`, and `change_categories:{transactionId}`.
- Transaction confirm/cancel now target production `transactions` rows by `transactionId` and `userId`, updating `status` to `confirmed` or `rejected`.
- Transaction category options can emit production-style `catid:{budgetId}:{transactionId}` callbacks when matching active budgets exist.
- Intent classification exists as a deterministic helper endpoint at `POST /veyra/intents/classify`.
- README documents current n8n HTTP Request payload examples for the migrated endpoints.

### Not Covered Yet

- Aegis does not yet emit the exact production reliable-sender payload, HTML layout, escaping, truncation, `parse_mode`, `disable_web_page_preview`, `bot_token_env`, or fixed chat id.
- Budget status still does not return the production child breakdown/message shape and may not match all parent-budget display paths.
- Budget upsert still does not auto-create a missing parent budget like production n8n.
- Overspending does not insert `budget_alerts`, uses `YYYY-MM` period keys instead of the production full cycle-start date shape, and does not build the production Telegram HTML alert.
- Transaction normalization does not parse bank email bodies, does not perform production `LIKE` alias matching, does not implement LLM categorization fallback, does not insert pending transactions, and does not upsert `merchant_review_queue`.
- Confirmation payload text still differs from production Telegram copy even though callback names are closer.
- Category options still read from `pending_transactions`, use a fixed category list as the display base, and do not fully implement production leaf-budget SQL, parent/child labels, 32-character label truncation, or default fallback category parity.
- Category selection still updates `pending_transactions`; it does not confirm the production `transactions` row after category selection.
- Intent classification does not match the production LLM schema, supported intent list, conversation-state priority rules, analytics routing, or cycle-aware period resolver.
- n8n HTTP Request error branches are not documented per workflow for expected Core API `400`/`404` responses.

## Production Switch Readiness

| Area | Current status | Switch readiness |
|---|---|---|
| Aegis formatting | Implemented, not exact payload parity | Pilot only with n8n mapping |
| Budget status | Implemented, schema gap improved | Pilot for calculations after fixture check |
| Budget upsert | Implemented, missing parent auto-create | Pilot only for existing-parent/single-category paths |
| Overspending check | Implemented as read-only classifier | Not safe as full workflow replacement |
| Transaction normalization | Implemented as normalization helper | Not safe as full normalizer replacement |
| Confirmation payload | Production callbacks improved, text differs | Not drop-in until text fixtures pass |
| Confirm/cancel | Production transaction status model improved | Candidate after callback payload tests |
| Category options/set-category | Partial production callback support | Not safe as full category flow replacement |
| Intent classifier | Deterministic helper | Not safe to replace LLM classifier |

## Actionable Checklist

### 1. Aegis Error Formatter

- [x] Add a production-compatible response shape for the reliable sender workflow:
  - [x] `chat_id`
  - [x] `text`
  - [x] `parse_mode: HTML`
  - [x] `disable_web_page_preview: true`
  - [x] `bot_token_env: AEGIS_TOKEN`
- [x] Match the production text layout beginning with `<b>AEGIS INCIDENT</b>`.
- [x] HTML-escape all interpolated workflow, node, execution, URL, and error fields.
- [x] Truncate generated text to the production-safe Telegram limit.
- [x] Add fixture tests from representative n8n Error Trigger payloads.
- [x] Document the exact n8n HTTP Request mapping and the reliable sender mapping.
- [x] Replace only the Aegis formatting Code/expression node; keep Error Trigger, routing, credentials, Telegram send, and retry behavior in n8n.

### 2. Budget Status

- [x] Add fixture tests for direct category, parent budget with children, missing category, inactive category, and custom cycle day.
- [x] Add child breakdown response fields if n8n budget status display needs to move to Core API.
- [x] Decide whether parent budget spending should include the parent category itself, child categories only, or both per production branch.
  - Decision: parent budget total spending includes the selected parent category itself plus active child budget categories; `child_breakdown` contains active child categories only.
- [x] Document the exact n8n HTTP Request payload for direct category and parent category lookup.
- [x] Replace only budget lookup/status SQL after fixture comparison; keep Telegram trigger, intent routing, message rendering, and send nodes in n8n.

### 3. Budget Upsert

- [x] Match production parent creation semantics:
  - [x] create missing parent budget when `parentCategory` is provided, or
  - Not selected: explicitly document that n8n must create/resolve parent first.
  - Decision: Core API creates a missing exact-case parent budget as an active parent row with no amount when `parentCategory` is provided.
- [x] Add tests for single-category create, single-category update, existing-parent child create, amount-only child update, and missing-parent behavior.
- [x] Confirm case-sensitivity behavior against the production unique index and active workflow.
  - Decision: budget upsert uses exact category matching and the existing `(user_id, category)` unique index behavior; it does not lower-case categories.
- [x] Document n8n payloads for single budget and child budget creation.
- [x] Replace only budget create/update DB logic for covered paths; keep parsing, Telegram messages, delete behavior, and orchestration in n8n.

### 4. Overspending Check

- [x] Decide ownership of duplicate prevention:
  - [ ] Core API inserts `budget_alerts` after deciding to alert, or
  - [x] n8n inserts `budget_alerts` only after successful Telegram delivery.
- [x] Align `period_key` with production data before switching. Production audit observed full cycle-start date shape; current Core API returns `YYYY-MM`.
- [x] Decide direct-category versus parent/child aggregate behavior for overspend checks.
- [x] Add tests for 79.9, 80, 100, 120, duplicate alert, and no budget cases.
- [x] Add production-compatible HTML Telegram alert builder if Core API owns message formatting.
- [x] Document n8n payload, alert insertion responsibility, and send mapping.
- [x] Keep schedule trigger, Telegram send, and delivery retry behavior in n8n.

### 5. Transaction Normalization

- [x] Scope the endpoint as normalization-only in n8n until parser/categorizer parity exists.
- [x] Add production-compatible merchant alias lookup using the active schema and matching semantics.
- [x] Add production-compatible category rule lookup using the active schema and priority behavior.
- [x] Decide confidence scale parity: current `0-95` number versus workflow values such as `0.95`, `0.98`, and LLM `0-100`.
  - Decision: keep the existing Core API `0-95` helper scale while this endpoint remains normalization-only and does not own LLM categorization.
- [ ] Add bank email parser endpoint only if explicitly migrating email parsing.
- [ ] Add LLM categorizer fallback only if explicitly migrating categorization.
- [ ] Add `merchant_review_queue` upsert only if replacing the normalizer/categorizer side effects.
- [x] Add tests for dirty amount strings, reversal/refund mapping, alias hit, alias miss, category rule hit, and missing merchant validation.
- [x] Keep Gmail trigger, email fetch, n8n orchestration, Telegram send, and credentials in n8n.

### 6. Transaction Confirmation Payload

- [x] Match production manual confirmation copy exactly, including Type, Amount, Merchant, Category, Wallet, and Notes.
- [x] Match production email confirmation copy exactly, including HTML formatting if n8n currently sends HTML.
- [x] Keep production callback data as default:
  - [x] `save_transaction:{id}`
  - [x] `cancel_transaction:{id}`
  - [x] `change_categories:{id}`
- [x] Add snapshot tests for manual and email confirmation payloads.
- [x] Document n8n HTTP Request payloads for manual transaction and email pending transaction confirmation.
- [ ] Replace only confirmation payload building after callback workflow compatibility is verified.

### 7. Transaction Confirm/Cancel

- [x] Add tests for pending-to-confirmed, pending-to-rejected, already confirmed, already rejected, wrong user, and missing row.
- [x] Confirm production callback parser maps `save_transaction:*` to `/transactions/confirm` and `cancel_transaction:*` to `/transactions/cancel`.
- [x] Return enough data for n8n to edit the Telegram message with the current production success/cancel text.
- [x] Document n8n payloads for confirm and cancel.
- [x] Keep callback trigger/routing, Telegram edit/send, and overspend orchestration in n8n until explicitly migrated.

### 8. Transaction Category Flow

- [x] Replace fixed display categories with production leaf-budget SQL:
  - [x] active budgets only
  - [x] exclude parent budgets with active children
  - [x] label child categories as `Parent / Child`
  - [x] truncate button labels to Telegram-safe length
  - [x] fall back to the exact production default categories
- [x] Preserve `catid:{budgetId}:{transactionId}` callback data.
- [x] Add endpoint or behavior to update `transactions.category`, set `status = confirmed`, and return edit-message data after category selection.
- [x] Add tests for custom leaf budgets, parent/child labels, fallback categories, unauthorized budget id, and confirm-on-select.
- [x] Document n8n payloads for category options and category selection.
- [x] Keep callback routing and Telegram edit/send in n8n.

### 9. Intent Classifier

- [x] Treat the deterministic classifier as experimental until schema parity is implemented.
- [x] Match the production LLM output schema:
  - [x] `intent`
  - [x] `period`
  - [x] `merchant`
  - [x] `category`
  - [x] `limit`
  - [x] `target: { type, value }`
  - [x] `changes`
  - [x] `selection`
  - [x] `confidence`
- [x] Add missing production intents, especially conversation control and analytics intents.
- [x] Implement conversation-state priority rules before generic text classification.
- [ ] Add cycle-day-aware period resolver output if replacing n8n period logic.
- [ ] Build a fixture suite from real n8n classifier examples before switching.
- [ ] Keep the production LLM classifier and analytics routing in n8n until fixture parity is high.

### 10. n8n Error Handling

- [ ] For each HTTP Request node, document expected success and error response shapes.
- [ ] Add n8n branches for `400` validation errors.
- [ ] Add n8n branches for `404` missing user/budget/transaction cases.
- [ ] Add retry or fallback behavior for Core API network errors.
- [ ] Keep the old n8n branch restorable until the endpoint has fixture coverage and a pilot run.

## Suggested Execution Order

1. Aegis exact reliable-sender payload.
2. Budget status fixture parity.
3. Transaction confirm/cancel callback compatibility.
4. Transaction confirmation text snapshot parity.
5. Budget upsert parent behavior.
6. Overspending duplicate-prevention ownership.
7. Category flow leaf-budget parity.
8. Normalizer/categorizer side-effect parity.
9. Intent classifier schema parity.

## n8n Nodes That Can Be Considered for Replacement First

- Aegis error formatting Code/expression block, after exact payload mode is added.
- Budget status SQL/calculation block, after parent/child fixture comparison.
- Budget upsert SQL block for simple single-category paths, after parent behavior is clarified.
- Transaction confirm/cancel status update blocks, after callback mapping and edit-message data are covered.

## n8n Nodes That Stay For Now

- Telegram Trigger nodes.
- Gmail Trigger nodes.
- Schedule Trigger nodes.
- Callback trigger/routing nodes.
- Telegram send/edit nodes.
- Reliable sender workflows.
- Credentials.
- LLM classifier workflow.
- Analytics workflow routing.
- Workflow activation/deactivation and production workflow management.
