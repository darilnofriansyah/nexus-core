# Pocket budgets, category spending, and daily warnings

## Agreed behavior

Each pocket owns one monthly spending limit. Categories describe its expenses;
they do not own limits or produce independent budget warnings. Monthly cycles
still use `telegram_users.cycle_start_day`.

`POST /api/veyra/budgets/status` now returns `category_breakdown` instead of
`child_breakdown`. Each entry contains only `category` and `spent_amount`.
The entries and the pocket total come from the same confirmed expenses.
An unset pocket amount means no configured limit; child amounts never supply it.
Budget upsert rejects `parentCategory`; old sub-budget conversations explain
that the user must set the pocket's limit instead.

Existing child rows and transaction history are retained. Active legacy child
names are used only to attribute old transactions with `pocket_id IS NULL`.
Explicit `pocket_id` always takes priority. No database migration is needed.

## Alert selection and delivery

After a confirmed expense, return at most one pocket warning:

1. At or above 100%: `budget_over_100_daily`, once per local spending day.
2. Otherwise at or above 90%: `budget_90`, once per financial cycle.
3. Otherwise at or above 75%: `budget_75`, once per financial cycle.
4. Otherwise a projected overrun: `budget_forecast_overrun`, once per cycle.

Daily warnings require the expense's local transaction date to be today.
The first eligible expense on the next day can warn again. Replaying yesterday's
expense does not count as new spending, and no scheduled reminder is added.
The stored user timezone controls the day (default `Asia/Jakarta`).

All warning types return Telegram text, optional pocket button, and `alertRecord`.
Evaluation does not write `budget_alerts`. Record only after Telegram succeeds;
a failed send remains retryable. The existing unique key deduplicates records.
For daily alerts `periodKey` is the local spending day (`YYYY-MM-DD`); other
types retain the financial-cycle start. Existing cycle-level `budget_100`
records do not suppress the new daily alert type.

Delivery remains at least once: concurrent evaluations or a crash between
sending and recording can duplicate a message. Keep per-pocket deliveries
serialized in the sender. A durable outbox is outside this change.

## n8n HTTP Request mapping

Pocket status:

```text
POST /api/veyra/budgets/status
```

```json
{ "userId": "1", "pocketId": "42" }
```

Render all `category_breakdown` entries as category + spent amount, with no
category limit, remaining balance, or threshold.

For existing transaction create/confirm/edit HTTP responses:

```text
Send baseMessage
→ iterate notifications in returned order
→ Telegram Reliable Sender: notification.message + notification.reply_markup
→ only after successful delivery, if notification.alertRecord exists:
  POST /api/veyra/budgets/overspending/record
  JSON body = notification.alertRecord
```

Example daily delivery acknowledgement:

```json
{
  "userId": "1",
  "budgetId": "42",
  "alertType": "budget_over_100_daily",
  "thresholdPercent": 100,
  "periodKey": "2026-09-13"
}
```

Use the returned record verbatim; do not calculate dates or change the alert type
in n8n. Record-request failure retries the record request, not the Telegram send.
The legacy `overspending/handle` transaction-ID wrapper also exposes
`data.alertRecord` for callers using that response.

Replace child-budget calculations, child-warning nodes, and pre-send alert inserts
with the returned pocket status/notifications. Keep intake, scheduling, sending,
retry handling, callback routing, and credentials in n8n.

## Validation and rollout

Focused tests cover category totals, pocket-only limits, legacy attribution,
threshold selection, daily timezone boundaries, no warning on historical replay,
post-delivery deduplication, failed-send retry, and card metadata forwarding.
Existing Veyra tests cover transaction saving and financial cycles.

This changes the status response contract. Update consumers of `child_breakdown`
to `category_breakdown` together with the API rollout. This work does not deploy
Core, edit production workflows, deactivate child rows, or clear alert history.
