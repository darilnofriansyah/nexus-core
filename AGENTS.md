Scope

This repository contains the NestJS Core API for Veyra and Aegis.

Veyra is a Telegram personal finance assistant.
Aegis is a monitoring/admin bot for n8n workflow errors.

n8n remains the trigger/orchestration layer for now.
NestJS Core is the reusable business-logic layer.

Core Rule

Do not rewrite everything at once.

Port n8n behavior into NestJS incrementally, one logic unit at a time.

For each migration task:

1. Identify the current n8n workflow behavior.
2. Extract only the business logic into NestJS.
3. Keep n8n responsible for triggers, scheduling, Gmail triggers, Telegram webhook intake, and basic orchestration unless explicitly told otherwise.
4. Preserve existing database behavior.
5. Add tests for the migrated logic.
6. Document how n8n should call the new NestJS endpoint.
7. Do not deploy to production unless explicitly asked.

What Belongs in NestJS

Move these into NestJS Core:

* transaction parsing and normalization
* budget create/update/delete logic
* budget spending calculation
* overspending threshold calculation
* conversational intent routing
* analytics query services
* Telegram reply formatting
* Aegis error message formatting
* reusable PostgreSQL queries
* validation and DTOs
* tests

What Stays in n8n For Now

Keep these in n8n:

* Telegram Trigger nodes
* Gmail Trigger nodes
* scheduled workflow triggers
* simple HTTP Request orchestration
* callback routing until explicitly migrated
* production workflow activation/deactivation
* credentials stored in n8n
* experimental workflow drafts

Production Safety Rules

Codex must not:

* modify production n8n workflows unless explicitly instructed
* call n8n MCP unless explicitly instructed
* delete workflows
* alter production database schema without approval
* run destructive SQL
* commit secrets
* create fake sample workflows when the user asked for real migration work

Migration Style

Prefer small, reviewable changes.

Each migration should produce:

* NestJS service/controller/DTO changes
* tests
* README or docs update
* example n8n HTTP Request payload
* clear notes on what existing n8n nodes can be replaced

Suggested Migration Order

1. Aegis error alert formatter
2. Aegis Telegram send payload builder
3. Veyra budget lookup/status calculation
4. Veyra budget upsert logic
5. Veyra overspending alert logic
6. Veyra transaction normalization
7. Veyra transaction confirmation payload builder
8. Veyra conversational analytics queries
9. Veyra intent routing
10. Telegram callback handling

Database Rules

Use the existing PostgreSQL schema.

Important tables:

* telegram_users
* transactions
* budgets
* budget_alerts
* merchant_aliases
* category_rules
* merchant_review_queue
* conversation_states
* pending_transactions

Budget rules:

* budgets.category is currently unique per user.
* parent_budget_id may be null.
* parent budgets may aggregate child budgets.
* monthly cycle must respect telegram_users.cycle_start_day.
* current period should be calculated using the user’s cycle start day, not calendar month only.

Transaction rules:

* transaction_type must match the database constraint.
* valid types include expense, income, transfer, reversal.
* status may be pending or confirmed.
* never assume imported data is clean.

n8n Integration Pattern

n8n should call NestJS with HTTP Request nodes.

Example:

POST /aegis/n8n-error
Input: raw n8n error trigger payload
Output: formatted Telegram alert payload

POST /veyra/telegram/message
Input: Telegram message payload or normalized message object
Output: reply text and optional actions

POST /veyra/budgets/status
Input: user id and category
Output: budget status, spent, remaining, threshold state

NestJS should return structured JSON. n8n remains responsible for sending the Telegram message unless explicitly migrated.

Review Requirement

Before large changes, Codex should show:

* proposed file changes
* migration target
* behavior being preserved
* risks
* test plan

Do not proceed with broad rewrites.
