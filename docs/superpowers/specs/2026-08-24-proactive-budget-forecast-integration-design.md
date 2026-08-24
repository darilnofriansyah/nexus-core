# Veyra Proactive Budget Forecast Integration Design

**Date:** 2026-08-24  
**Status:** Approved in conversation; awaiting written-spec review  
**Scope:** One proactive `budget_forecast_overrun` insight connecting confirmed transactions, Telegram chat, and the existing Veyra Mini App pocket view

## Goal

Warn a user once per pocket and financial cycle when current spending pace projects that the pocket will exceed its effective budget. The Telegram message explains the deterministic facts and opens the existing pocket detail in the Mini App. The dashboard independently shows every currently unresolved forecast risk.

This is an insight-to-action integration, not a new analytics dashboard or generic notification platform.

## Success Criteria

1. A confirmed expense evaluates only its affected pocket.
2. A projected overrun produces one deterministic Telegram notification contract with one `View <Pocket> pocket` URL button.
3. n8n records the alert only after Telegram delivery succeeds.
4. Normal processing produces no more than one Telegram forecast alert per pocket and cycle.
5. Opening the pocket does not dismiss or resolve the warning.
6. The dashboard shows up to three unresolved forecast warnings, ordered by projected overrun, with access to all remaining warnings.
7. A dashboard warning disappears only when the live projection returns within budget or the cycle changes.
8. Transaction saving and confirmation remain successful when forecasting, link generation, or notification delivery fails.

## Non-Goals

- A general-purpose insights engine, queue, or notification center.
- AI-generated alert copy or explanations.
- Scheduled scans across every user and pocket.
- Unusual-spend, duplicate-charge, cashflow, or weekly-review alerts.
- Read, dismissed, snoozed, or notification-preference state.
- A new Mini App insight screen.
- A new database table or production schema change.
- Production n8n workflow modification, activation, deployment, or Telegram sending during implementation without separate authorization.

## Current System

- Confirmed manual, email, callback, and web transaction paths already call `TransactionService.evaluateTransactionWatchdog(transactionId)`.
- `BudgetService.evaluateTransaction()` already calculates budget thresholds and a linear cycle projection.
- `budget_alerts` already enforces uniqueness on `(budget_id, alert_type, period_key)`.
- `POST /api/veyra/budgets/overspending/record` already records delivered alerts idempotently.
- `POST /api/veyra/dashboard/overview` already loads the current cycle's transactions and active budgets.
- n8n remains responsible for Telegram triggers, delivery, retries, and orchestration.

The current transaction watchdog inserts forecast alert records during evaluation, before Telegram delivery. This design moves only `budget_forecast_overrun` to the existing evaluate → send → record contract. Existing non-forecast threshold-alert behavior remains unchanged.

## User Experience

### Telegram

When a confirmed expense makes a pocket project over budget, Veyra sends one concise message:

```text
Food may exceed its budget by Rp420.000 this cycle.
Rp750.000 spent of Rp1.500.000.
Safe daily spend: Rp50.000.
Top driver: Dining (Rp610.000).

[View Food pocket]
```

The copy is deterministic and contains:

- pocket name;
- projected overrun;
- spent amount and effective limit;
- safe daily spend for the remaining cycle;
- largest spending category and amount;
- one Mini App URL button.

There is no `Explain`, `Dismiss`, or inline budget-mutation callback in v1.

### Mini App Dashboard

The dashboard keeps its existing overall cycle summary. When at least one pocket is currently projected over budget, a `Needs attention` section appears above the normal summary.

- Show at most three warnings on the dashboard.
- Order warnings by `projectedOverrun` descending, then pocket name.
- Do not replace an unresolved warning when another pocket becomes risky.
- Show `View all at-risk pockets` when more than three warnings exist.
- Each warning shows pocket name, projected spend, projected overrun, current spend and limit, safe daily spend, and top spending driver.
- Tapping `View pocket` navigates to the existing pocket detail.
- When no live risk exists, omit the entire section and start with the existing current-cycle summary.

Dashboard warning visibility is live financial state. It is not based on whether the Telegram alert was delivered, read, or opened.

### Pocket Detail

The existing pocket detail is opened already scoped to the requested pocket. It continues to own the existing transaction review and budget-management actions. Merely viewing it does not change forecast or notification state.

## Architecture and Ownership

### Core API

- Resolve the confirmed expense and affected pocket.
- Calculate deterministic forecast facts.
- Check whether the cycle's forecast alert has already been recorded.
- Return Telegram-safe text, Mini App URL button, and the exact alert-record payload.
- Extend dashboard overview with live attention data.
- Enforce user and pocket ownership on every existing pocket data request.

### n8n

- Keep the existing transaction workflow and watchdog response handling.
- Send the Core-provided Telegram message and reply markup.
- Retry delivery according to the current reliable sender behavior.
- Call the existing alert-record endpoint only after successful delivery.
- Retry only the idempotent record request when recording fails after delivery.

### Mini App and Its Server

- Accept `startapp=pocket_<budgetId>`.
- Validate Telegram `initData` and its age through the existing Mini App authentication path.
- Resolve the authenticated Telegram identity server-side.
- Treat the start parameter as untrusted navigation input.
- Request pocket data with the authenticated identity and pocket ID.
- Open the existing pocket detail when ownership succeeds.
- Fall back to the normal inaccessible-resource/dashboard behavior when it fails.

### PostgreSQL

- Reuse `budgets`, `transactions`, `telegram_users`, and `budget_alerts`.
- Keep `budget_alerts` uniqueness `(budget_id, alert_type, period_key)`.
- Keep the cycle-start date (`YYYY-MM-DD`) as `period_key`.
- Do not add notification, read-state, delivery-state, or outbox tables in v1.

## Core Data Flow

1. A transaction becomes `confirmed` through an existing transaction path.
2. `evaluateTransactionWatchdog(transactionId)` resolves the transaction.
3. Existing non-forecast watchdog checks continue unchanged.
4. The forecast evaluator checks only the affected top-level pocket.
5. If the live projection does not exceed the effective limit, Core returns no forecast notification.
6. If `(budget_id, budget_forecast_overrun, period_key)` already exists, Core returns no forecast notification.
7. Otherwise Core returns one enriched `budget_alert` notification without inserting `budget_alerts`.
8. n8n sends that notification through the existing Telegram sender.
9. After successful delivery, n8n posts `alertRecord` to `/api/veyra/budgets/overspending/record`.
10. The idempotent record endpoint inserts the unique `budget_alerts` row or reports it already exists.
11. The dashboard separately recalculates live attention items whenever `/api/veyra/dashboard/overview` is loaded.

No scheduled scan or additional transaction endpoint is introduced.

## Forecast Rules

Use one shared pure forecast calculation from both the transaction watchdog and dashboard overview. It accepts explicit cycle dates and an explicit reference date; it must not read the system clock internally.

### Eligible Data

- Confirmed `expense` transactions only.
- The transaction's explicit `pocket_id` takes precedence.
- Legacy transactions with `pocket_id IS NULL` use the existing category and child-budget fallback.
- The pocket must be active and top-level.
- The effective budget amount must be positive.
- A parent amount is used when present; otherwise the existing child-budget aggregation supplies the effective amount.
- Income, transfer, reversal, pending, rejected, missing-pocket, and amount-less pocket cases produce no forecast alert.

### Calculation

The current cycle is `[cycleStart, cycleEnd)`, respecting `telegram_users.cycle_start_day`.

```text
elapsedDays = max(1, days from cycleStart through referenceDate)
cycleDays = max(1, days from cycleStart to cycleEnd)
remainingDays = max(1, cycleDays - elapsedDays)

projectedSpend = round(spent / elapsedDays * cycleDays)
projectedOverrun = max(0, projectedSpend - effectiveLimit)
remainingAmount = max(0, effectiveLimit - spent)
safeDailySpend = floor(remainingAmount / remainingDays)
```

The transaction watchdog uses the transaction's local date as its reference date. Dashboard overview uses the request's validated `asOfDate` and timezone.

The top driver is the highest-spending category inside the pocket during the current cycle. Ties use category name for deterministic output. When no child/category breakdown is available, use the pocket name.

The existing linear projection remains intentionally simple. Historical smoothing, minimum-sample gates, and predictive models are deferred until observed false-positive rates justify them.

## Transaction Watchdog Contract

Extend the existing notification item; do not add a new endpoint:

```json
{
  "type": "budget_alert",
  "alertType": "budget_forecast_overrun",
  "budgetId": "42",
  "priority": 2,
  "severity": "warning",
  "message": "Food may exceed its budget by Rp420.000 this cycle.\nRp750.000 spent of Rp1.500.000.\nSafe daily spend: Rp50.000.\nTop driver: Dining (Rp610.000).",
  "reply_markup": {
    "inline_keyboard": [
      [
        {
          "text": "View Food pocket",
          "url": "https://t.me/veyra/app?startapp=pocket_42"
        }
      ]
    ]
  },
  "alertRecord": {
    "userId": "1",
    "budgetId": "42",
    "alertType": "budget_forecast_overrun",
    "thresholdPercent": 0,
    "periodKey": "2026-08-01"
  }
}
```

`VEYRA_MINI_APP_BASE_URL` supplies the configured `https://t.me/<bot>/<app>` base. Core appends the URL-safe `startapp=pocket_<budgetId>` value. The parameter contains no Telegram ID, internal user ID, or financial data.

When the base URL is absent or invalid, Core omits `reply_markup` and preserves the text notification. Configuration failure must not block transaction persistence.

## Dashboard Overview Contract

Add `current.attention`; keep existing fields backward compatible. `previous.attention` is not added because historical warnings are outside v1.

```json
{
  "current": {
    "attention": [
      {
        "type": "budget_forecast_overrun",
        "pocketId": "42",
        "pocketName": "Food",
        "limit": 1500000,
        "spent": 750000,
        "projectedSpend": 1920000,
        "projectedOverrun": 420000,
        "safeDailySpend": 50000,
        "topDriver": {
          "category": "Dining",
          "amount": 610000
        }
      }
    ]
  }
}
```

The API returns all live attention items in deterministic order. The Mini App displays the first three on the dashboard and uses the same response for `View all at-risk pockets`.

The existing dashboard transaction query must include `pocket_id`. Dashboard grouping uses explicit pocket ownership first and preserves the legacy category fallback for older rows.

## n8n HTTP Mapping

The existing transaction HTTP Request body does not change. n8n reads the returned `notifications` array.

For a forecast notification, map the existing Telegram sender input from Core:

```json
{
  "chat_id": "={{$json.chatId}}",
  "text": "={{$json.notification.message}}",
  "parse_mode": "HTML",
  "disable_web_page_preview": true,
  "reply_markup": "={{$json.notification.reply_markup}}"
}
```

After the Telegram sender succeeds, call:

```text
POST http://core-api:3001/api/veyra/budgets/overspending/record
Content-Type: application/json
x-core-api-key: <CORE_API_KEY>
```

Body:

```json
{
  "userId": "={{$json.notification.alertRecord.userId}}",
  "budgetId": "={{$json.notification.alertRecord.budgetId}}",
  "alertType": "={{$json.notification.alertRecord.alertType}}",
  "thresholdPercent": "={{$json.notification.alertRecord.thresholdPercent}}",
  "periodKey": "={{$json.notification.alertRecord.periodKey}}"
}
```

### n8n Nodes Replaced or Simplified

- Replace only forecast-warning text and button construction with direct mapping from the Core response.
- Remove any forecast-alert database insert that occurs before Telegram delivery on this path.

### n8n Nodes That Stay

- Telegram Trigger and callback routing.
- Transaction intake, Gmail triggers, and scheduling unrelated to this feature.
- Existing Core HTTP Request orchestration.
- Telegram sender, credentials, retries, and error handling.
- Post-delivery HTTP Request to record the alert.

No production workflow is changed, activated, deactivated, or deployed without explicit authorization.

## Error Handling

### Forecast or Dashboard Calculation Failure

- Do not fail transaction saving or confirmation.
- Return no forecast notification from the watchdog.
- Return an empty `current.attention` while preserving the rest of dashboard overview when attention calculation alone fails.
- Log only identifiers and error metadata already permitted by project logging rules; do not log raw Telegram text or financial payloads.

### Telegram Delivery Failure

- Do not call the alert-record endpoint.
- Let the existing n8n reliable sender retry delivery.

### Record Failure After Delivery

- Retry only `/budgets/overspending/record`.
- Rely on its existing idempotent behavior and database uniqueness.
- Do not deliberately resend Telegram from the record-retry branch.

### Invalid Mini App Start Parameter

- Reject malformed values before using them as identifiers.
- Treat a missing, inactive, or foreign pocket identically.
- Show the normal Mini App dashboard or inaccessible-resource state without revealing whether another user's pocket exists.

## Delivery Semantics

The v1 integration is at-least-once, not exactly-once. Under normal n8n execution, `budget_alerts` prevents later notifications for the same pocket and cycle. A process crash after Telegram succeeds but before the record call succeeds can produce one duplicate if the complete workflow is replayed.

Exactly-once behavior would require a durable delivery/outbox state expansion or an equivalent cross-system protocol. That complexity is deferred until duplicates are observed in production.

## Security and Privacy

- Validate Telegram Mini App `initData`, signature, and `auth_date` through the existing Mini App server authentication path.
- Never trust a browser-provided internal `userId`.
- Resolve the server-verified Telegram identity before calling Core.
- Recheck pocket ownership in Core for every pocket status or transaction query.
- Treat `startapp` as navigation only, never authorization.
- Do not include user identity, transaction details, or signed credentials in the start parameter.
- Keep the Core API key server-side and out of the browser.

## Proposed Core Files

- Add `src/veyra/budgets/budget-forecast.ts` for the shared pure calculation.
- Update `src/veyra/budgets/budget.service.ts` to separate forecast evaluation from existing pre-recorded threshold alerts and return a post-delivery record payload.
- Update `src/veyra/budgets/dto/overspending-check.dto.ts` for the forecast result contract.
- Update `src/veyra/budgets/budget.service.spec.ts` with focused forecast and dedupe cases.
- Update `src/veyra/transactions/dto/transaction-watchdog.dto.ts` with the enriched forecast notification fields.
- Update `src/veyra/transactions/transaction.service.ts` to include the enriched forecast notification in the existing ordered list.
- Update `src/veyra/transactions/transaction.service.spec.ts` for notification ordering and payload mapping.
- Update `src/veyra/dashboard/dto/dashboard-overview.dto.ts` with `current.attention`.
- Update `src/veyra/dashboard/dashboard-overview.repository.ts` to return transaction pocket IDs in the existing query.
- Update `src/veyra/dashboard/dashboard-overview.service.ts` to build live attention items using the shared calculation.
- Update the existing dashboard repository and service specs.
- Update `src/config/env.ts` and `.env.example` for optional `VEYRA_MINI_APP_BASE_URL`.
- Update `README.md` with Core response examples, Mini App handoff, and n8n send → record mapping.

No controller, module, dependency, or database migration is expected unless implementation discovery proves an existing boundary cannot support this contract.

The Mini App frontend/server and n8n workflow live outside this repository. Their required contract changes are documented here but must be implemented in their owning workspaces under separate authorization.

## Test Plan

Use the existing Node test runner and current fakes; add no test framework or dependency.

### Shared Forecast

- Projects from explicit `asOfDate` without reading the system clock.
- Respects non-first-day financial cycles.
- Handles the first and last cycle days without division by zero.
- Returns no overrun for zero or amount-less effective budgets.
- Calculates rounded projection, non-negative overrun, and floored safe daily spend.

### Budget Watchdog

- Evaluates only confirmed expenses.
- Uses explicit `pocket_id` before legacy category fallback.
- Returns one unrecorded forecast alert with `alertRecord` when eligible.
- Does not insert `budget_forecast_overrun` before delivery.
- Suppresses a forecast already present in `budget_alerts`.
- Preserves current non-forecast threshold behavior.
- Omits reply markup when the Mini App base URL is unavailable.

### Transaction Service

- Keeps notification order stable.
- Emits deterministic HTML-safe text and the exact URL button.
- Preserves empty notifications when no forecast exists.
- Does not fail a confirmed transaction when forecast evaluation throws.

### Dashboard

- Builds attention items from explicit pocket assignments.
- Preserves legacy category fallback.
- Uses parent amount or child aggregation according to existing budget rules.
- Returns all active risks ordered by overrun then pocket name.
- Removes an item when its live projection is within budget.
- Returns an empty attention array without changing existing overview fields when there are no risks.
- Preserves active-user and ownership behavior.

### n8n Contract

- Fixture-test the existing transaction response → Telegram sender mapping.
- Verify the record request occurs only after successful delivery.
- Verify record retry does not route back through the Telegram sender.
- Do not send a real Telegram message or modify a production workflow during automated verification.

## Rollout

1. Implement and verify the Core contract locally without running an npm build.
2. Implement the Mini App dashboard section and `startapp` pocket routing in its owning repository.
3. After explicit authorization, update a non-production n8n workflow or guarded draft to map the Core notification and post-delivery record request.
4. Verify one forecast alert, one deep link, live dashboard persistence, and resolution behavior with controlled data.
5. Deploy or alter production workflows only after separate explicit approval.

## Deferred Upgrades

- Historical smoothing or minimum-sample forecast gates.
- User alert preferences, snooze, and dismiss actions.
- A dedicated insights history.
- Scheduled re-evaluation without a new transaction.
- Exact-once delivery through an outbox.
- Additional anomaly and cashflow alert types.

Add any deferred upgrade only when observed user behavior or operational evidence shows the v1 limit matters.
