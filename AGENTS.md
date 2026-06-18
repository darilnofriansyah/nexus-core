# AGENTS.md

## Scope

`nexus-core` is the NestJS Core API for Veyra and Aegis.

* Veyra: Telegram personal finance assistant.
* Aegis: n8n workflow error monitoring/admin bot.
* n8n remains the trigger/orchestration layer.
* NestJS Core contains reusable business logic.

## Prime Rule

Do not rewrite broadly.

Migrate one small n8n logic unit at a time.

For each task:

1. Preserve the current n8n behavior.
2. Move only the requested business logic into NestJS.
3. Keep n8n responsible for triggers, scheduling, Gmail triggers, Telegram intake/sending, and simple orchestration unless told otherwise.
4. Preserve existing PostgreSQL schema and behavior.
5. Add/update tests.
6. Document the n8n HTTP Request payload.
7. Do not deploy unless explicitly asked.

## Safety Rules

Codex must not:

* Modify production n8n workflows unless explicitly instructed.
* Call n8n MCP unless explicitly instructed.
* Create fake/sample workflow files when asked for real migration work.
* Delete, activate, or deactivate workflows.
* Alter production database schema without approval.
* Run destructive SQL.
* Commit secrets, tokens, credentials, `.env`, or private keys.
* Start broad rewrites without showing scope first.

## Migration Boundaries

Eligible NestJS migration areas, only when requested:

* Aegis error formatting.
* Telegram reply/send payload formatting.
* Budget lookup, status, upsert, delete, and overspending logic.
* Transaction parsing, normalization, and confirmation payloads.
* Conversational intent routing.
* Analytics query services.
* Reusable PostgreSQL queries.
* DTOs, validation, services, controllers, and tests.

Only implement the requested slice. Do not migrate adjacent features unless required.

Keep in n8n for now:

* Telegram Trigger nodes.
* Gmail Trigger nodes.
* Schedule triggers.
* HTTP Request orchestration.
* Telegram message sending.
* Callback routing.
* Production workflow management.
* Credentials.
* Experimental workflow drafts.

## Database Rules

Use the existing PostgreSQL schema.

Important tables:

* `telegram_users`
* `transactions`
* `budgets`
* `budget_alerts`
* `merchant_aliases`
* `category_rules`
* `merchant_review_queue`
* `conversation_states`
* `pending_transactions`

Budget rules:

* `budgets.category` is unique per user.
* `parent_budget_id` may be null.
* Parent budgets may aggregate child budgets.
* Monthly periods must respect `telegram_users.cycle_start_day`.
* Do not use calendar month only for current budget period.
* Do not assume parent budgets always have an amount.

Transaction rules:

* Valid `transaction_type`: `expense`, `income`, `transfer`, `reversal`.
* `status` may be `pending` or `confirmed`.
* Imported data may be dirty.
* Normalize and validate before persisting or calculating.

## n8n Integration

n8n calls NestJS through HTTP Request nodes.

NestJS returns structured JSON.

n8n sends Telegram messages unless explicitly migrated.

Example endpoints:

* `POST /aegis/n8n-error`
* `POST /veyra/telegram/message`
* `POST /veyra/budgets/status`

Each migrated endpoint should include an example n8n HTTP Request payload in docs.

## Output Expectations

Each migration should include:

* Service/controller/DTO changes as needed.
* Focused tests.
* README or docs update.
* Example n8n payload.
* Notes on which n8n nodes can be replaced.
* Notes on which n8n nodes stay.

Before broad or risky changes, show:

* Target behavior.
* Proposed files.
* Risks.
* Test plan.

## Coding Style

Prefer small, reviewable changes.

Use existing conventions.

Do not add libraries unless necessary.

Keep business logic testable outside controllers.

