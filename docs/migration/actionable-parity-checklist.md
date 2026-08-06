# Veyra/Aegis Actionable Parity Checklist

This checklist turns the parity audit into reviewable migration work. Its checkboxes are the authoritative record of completed and remaining work.

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
  - Decision: when active children exist, parent budget totals aggregate active child budget amounts and child spending; `child_breakdown` contains active child categories only.
- [x] Document the exact n8n HTTP Request payload for direct category and parent category lookup.
- [x] Replace only budget lookup/status SQL after fixture comparison; keep Telegram trigger, intent routing, message rendering, and send nodes in n8n.

### 3. Budget Upsert

- [x] Match production parent creation semantics:
  - [x] create missing parent budget when `parentCategory` is provided, or
  - Not selected: explicitly document that n8n must create/resolve parent first.
  - Decision: Core API creates a missing exact-case parent budget as an active parent row with no amount when `parentCategory` is provided.
- [x] Add tests for single-category create, single-category update, existing-parent child create, amount-only child update, and missing-parent behavior.
- [x] Confirm case-sensitivity behavior against the production unique index and active workflow.
  - Decision: budget upsert uses exact category matching; child rows follow the existing `(parent_budget_id, category)` unique constraint, and top-level rows are matched in code by user/category because `parent_budget_id` is nullable.
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
- [x] Add bank email parser endpoint only if explicitly migrating email parsing.
  - Phase 1 endpoint: `POST /api/veyra/transactions/email/handle` for deterministic BCA credit-card, Mandiri e-money, and Krom transfer/QRIS templates.
  - [x] Add user-scoped learned templates after hard-coded parsing, with safe literal-anchor validation and sender-authentication gating.
  - [x] Return `needs_ai` for likely transaction emails that neither deterministic parser can handle; Core API never invokes an AI model.
  - [x] Accept n8n's structured AI result as a pending confirmation, and activate only its validated template after user confirmation.
  - [x] Support correction through `transactionId`, regenerated structured AI output, and the n8n-only `edit_email_details:*` interception contract.
  - [x] Record an n8n AI failure as `needs_review` / `ai_failed` without inserting a transaction or template.
- [ ] Invoke the existing n8n AI node for `needs_ai` and submit its structured result to `POST /api/veyra/transactions/email/resolve-review`.
- [ ] Apply `docs/migration/2026-07-27-email-parser-templates.sql` after review and approval.
- [ ] Prepare, fixture-test, approve, and only then activate the production n8n Gmail/AI/callback workflow changes.
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
