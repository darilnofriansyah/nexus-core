# nexus-core

NestJS API for gradually moving reusable Veyra and Aegis business logic out of n8n while keeping n8n responsible for triggers, credentials, delivery, and orchestration during the migration.

This app is intentionally small. It is a service layer pilot, not a replacement for existing production workflows.

## Project Structure

```txt
src/
  aegis/
    Aegis alert formatting endpoints and services.
  common/
    Shared response contracts and small utilities.
  config/
    Environment parsing. No secrets are stored here.
  database/
    PostgreSQL access wrapper. Services should depend on this instead of opening ad hoc connections.
  health/
    Health check endpoint for n8n and reverse proxies.
  veyra/
    budgets/
      Budget lookup, status calculation, and upsert logic.
    conversation-states/
      Multi-step Telegram conversation state persistence for n8n orchestration.
    intent/
      Conversational intent detection and routing helpers.
    messages/
      Telegram message route selection for n8n workflow dispatch.
    telegram/
      Telegram response text formatting. n8n still sends messages.
    transactions/
      Transaction parsing, validation, categorization, and persistence logic.
```

## Migration Plan

1. Pilot Aegis first.
   Move error alert formatting into `AegisAlertFormatterService`, then have the Aegis n8n workflow call `POST /api/aegis/n8n-error` before its existing Telegram send path.

2. Move Veyra service-layer logic next.
   Start with pure functions and validation: transaction normalization, category decisions, budget intent parsing, and Telegram reply formatting. Keep Telegram triggers and sends in n8n.

3. Add database-backed methods behind services.
   Put PostgreSQL access in `DatabaseService`; keep SQL parameterized and scoped. Do not run destructive migrations from this app during the initial pilot.

4. Replace n8n Code node logic incrementally.
   For each workflow branch, replace one Code node or formatting block with one HTTP Request node. Keep the old n8n branch easy to restore until the Core API behavior is verified.

5. Only later consider trigger migration.
   Telegram triggers, n8n Error Trigger, workflow routing, retries, credentials, and delivery should remain in n8n until the service layer is stable.

## Current Endpoints

### `GET /api/health`

Returns a basic health payload.

### `POST /api/aegis/n8n-error`

Formats a raw n8n Error Trigger payload into the production-compatible reliable sender payload. n8n should still own the Error Trigger, routing, credentials, Telegram send, and retry behavior.

Example request body:

```json
{
  "workflow": {
    "id": "example-workflow-id",
    "name": "Error Watchdog"
  },
  "execution": {
    "id": "example-execution-id",
    "url": "https://n8n.example.com/execution/example-execution-id",
    "mode": "error",
    "stoppedAt": "2026-06-17T10:00:00.000Z"
  },
  "error": {
    "message": "Request timed out",
    "node": {
      "name": "HTTP Request"
    }
  }
}
```

Example response:

```json
{
  "chatText": "<b>AEGIS INCIDENT</b>\n------------------------------\n<b>Severity:</b> ERROR\n<b>Service:</b> Veyra\n<b>Workflow:</b> Error Watchdog\n<b>Node:</b> HTTP Request\n<b>Execution:</b> example-execution-id\n<b>Mode:</b> error\n------------------------------\n<b>Error:</b> Request timed out\n<b>Execution URL:</b> https://n8n.example.com/execution/example-execution-id",
  "chat_id": "<ADMIN_TELEGRAM_ID>",
  "text": "<b>AEGIS INCIDENT</b>\n------------------------------\n<b>Severity:</b> ERROR\n<b>Service:</b> Veyra\n<b>Workflow:</b> Error Watchdog\n<b>Node:</b> HTTP Request\n<b>Execution:</b> example-execution-id\n<b>Mode:</b> error\n------------------------------\n<b>Error:</b> Request timed out\n<b>Execution URL:</b> https://n8n.example.com/execution/example-execution-id",
  "parse_mode": "HTML",
  "disable_web_page_preview": true,
  "bot_token_env": "AEGIS_TOKEN",
  "severity": "ERROR",
  "workflowId": "example-workflow-id",
  "executionId": "example-execution-id",
  "executionUrl": "https://n8n.example.com/execution/example-execution-id"
}
```

### `POST /api/veyra/telegram/messages`

Placeholder endpoint for Veyra Telegram message handling. It currently detects a coarse intent and returns placeholder service statuses. n8n should still own Telegram receive/send behavior.

Example request body:

```json
{
  "chatId": "example-chat-id",
  "telegramUserId": "example-user-id",
  "messageText": "set food budget to 1500000 this month",
  "messageId": "example-message-id",
  "receivedAt": "2026-06-17T10:00:00.000Z",
  "source": "n8n"
}
```

### `POST /api/veyra/messages/route`

Selects the Veyra sub-workflow route for one Telegram update. This endpoint only resolves the user, checks active `conversation_states`, and returns a route for n8n; it does not classify intent, call an LLM, execute budget/transaction logic, update conversation state, or send Telegram messages.

Example request body:

```json
{
  "telegramUserId": "976684739",
  "userId": 1,
  "text": "Get all budgets",
  "messageType": "text",
  "callbackQuery": null
}
```

`userId` is optional when n8n already has the internal `telegram_users.id`. If it is missing, Core API resolves the user from `telegramUserId`. At least one of `userId` or `telegramUserId` is required. `telegramUserId` is normalized to a string at the API boundary, and database lookup uses text-safe comparisons against bigint columns.

Routing priority is deterministic:

1. Existing `callbackQuery` -> `callback`.
2. Text beginning with `/` -> `slash_command`.
3. Active `conversation_states.state_name`:
   - `budget_conversation_state` -> `budget`.
   - `record_transaction_state` -> `record`.
   - `awaiting_confirmation` -> `transaction_edit`.
   - `awaiting_transaction_selection` -> `transaction_edit`.
   - Unknown active state -> `fallback`.
4. No state, `idle`, or expired state -> `conversational`.
5. Unknown user -> `fallback`.

A state is active only when the row exists, `state_name` is not null, `state_name` is not `idle`, and `expires_at` is null or in the future. Expired states are not cleared by this endpoint.

Example response:

```json
{
  "route": "budget",
  "reason": "active_budget_state",
  "userId": 1,
  "telegramUserId": "976684739",
  "text": "Get all budgets",
  "messageType": "text",
  "command": null,
  "state": {
    "name": "budget_conversation_state",
    "data": {}
  }
}
```

Supported `route` values are `callback`, `slash_command`, `budget`, `record`, `transaction_edit`, `conversational`, and `fallback`.

Recommended Veyra message route node settings:

```txt
Method: POST
URL: http://core-api:3001/api/veyra/messages/route
Send Body: JSON
Body:
{
  "telegramUserId": "={{$json.message.from.id}}",
  "userId": "={{$json.user_id}}",
  "text": "={{$json.message.text || ''}}",
  "messageType": "={{$json.message ? 'text' : 'callback_query'}}",
  "callbackQuery": "={{$json.callback_query || null}}"
}
```

Use `{{$json.route}}` in an n8n Switch node to dispatch to the callback, slash-command, budget, record, transaction-edit, conversational, or fallback sub-workflow. This replaces only the duplicated route-selection Code/Switch pre-processing at the front of the Veyra message workflow. Keep Telegram Trigger nodes, callback handling, LLM/intent classification, budget/record/conversational sub-workflows, Telegram sending, credentials, retries, and production workflow management in n8n.

### `POST /api/veyra/budgets/status`

Looks up one existing budget and calculates current-cycle spending. The cycle uses `telegram_users.cycle_start_day`; spending includes only confirmed expense transactions where `transaction_date >= cycle_start` and `transaction_date < cycle_end`.

Core API reads the production budget amount from `budgets.amount` and returns it as `budget_amount` in the response for n8n compatibility. Inactive budgets are excluded with `COALESCE(is_active, true) = true`. For a parent budget lookup with active children, top-line budget and spending totals are aggregated from the active child budgets. `child_breakdown` contains active child categories only so n8n can render parent details without re-running child budget SQL.

Direct category request body:

```json
{
  "telegramUserId": "example-telegram-user-id",
  "category": "Food",
  "asOfDate": "2026-06-17"
}
```

`userId` may be used instead of `telegramUserId` when n8n already has the internal `telegram_users.id`. `asOfDate` is optional and defaults to the current date.

Parent category request body:

```json
{
  "userId": "example-user-id",
  "category": "Living",
  "asOfDate": "2026-06-17"
}
```

Example response:

```json
{
  "budget_id": "example-budget-id",
  "category": "Food",
  "parent_budget_id": null,
  "budget_amount": 1500000,
  "spent_amount": 375000,
  "remaining_amount": 1125000,
  "spent_percent": 25,
  "child_breakdown": [],
  "cycle_start": "2026-06-15",
  "cycle_end": "2026-07-15"
}
```

Parent category responses include child details when active children exist:

```json
{
  "budget_id": "example-parent-budget-id",
  "category": "Living",
  "parent_budget_id": null,
  "budget_amount": 5000000,
  "spent_amount": 2250000,
  "remaining_amount": 2750000,
  "spent_percent": 45,
  "child_breakdown": [
    {
      "budget_id": "example-child-budget-id",
      "category": "Food",
      "budget_amount": 2000000,
      "spent_amount": 1250000,
      "remaining_amount": 750000,
      "spent_percent": 62.5
    }
  ],
  "cycle_start": "2026-06-01",
  "cycle_end": "2026-07-01"
}
```

### `POST /api/veyra/budgets/upsert`

Creates or updates one budget using exact-case category matching for the same user. Child budgets are matched by `parent_budget_id` and `category`, matching the production `budgets_parent_budget_category_unique` constraint. Top-level budgets are matched in code by user and category because PostgreSQL unique constraints allow multiple `NULL` parent values. `periodType` defaults to `monthly`; other period types are rejected until the database behavior is reviewed.

Core API writes the production `budgets.amount` column. New budget rows are inserted with `is_active = true`.

If `parentCategory` is provided, Core API resolves an exact-case parent budget for the same user or creates it as an active parent row with no amount, then stores its `id` as `parent_budget_id`. If `parentCategory` is omitted, new budgets are created with `parent_budget_id = null`; existing budgets keep their current `parent_budget_id` during amount-only updates.

Example request body:

```json
{
  "userId": "example-user-id",
  "category": "Food",
  "amount": 1500000,
  "parentCategory": "Monthly Allowance",
  "periodType": "monthly"
}
```

Single budget request body:

```json
{
  "userId": "example-user-id",
  "category": "Food",
  "amount": 1500000,
  "periodType": "monthly"
}
```

Child budget request body:

```json
{
  "userId": "example-user-id",
  "category": "Groceries",
  "amount": 1000000,
  "parentCategory": "Monthly Allowance",
  "periodType": "monthly"
}
```

Example response:

```json
{
  "budget_id": "example-budget-id",
  "user_id": "example-user-id",
  "category": "Food",
  "amount": 1500000,
  "parent_budget_id": "example-parent-budget-id",
  "parent_category": "Monthly Allowance",
  "period_type": "monthly",
  "action": "created"
}
```

### `POST /api/veyra/budgets/handle`

Orchestrates one parsed budget conversation step for n8n. n8n should run LLM parsing first, pass the previous budget `statePayload` plus the new `llmResult`, then send the returned `message` through Telegram Reliable Sender. Core API saves pending budget state when more information is needed and resets state to `idle` after success, reset/cancel, unsupported delete, or unknown action.

Example request body:

```json
{
  "telegramUserId": "123456789",
  "userId": 1,
  "text": "1 juta",
  "statePayload": {},
  "llmResult": {
    "intent": "set_budget",
    "category": "Food",
    "parent_category": null,
    "amount": 1000000,
    "missing_fields": []
  }
}
```

Example response:

```json
{
  "ok": true,
  "state": {
    "nextState": "idle",
    "payload": {}
  },
  "message": {
    "text": "Budget updated.\n\nCategory: Food\nAmount: Rp1.000.000",
    "parse_mode": "HTML",
    "disable_web_page_preview": true
  },
  "data": {
    "intent": "set_budget",
    "category": "Food",
    "parent_category": null,
    "action": "updated",
    "budget_id": "example-budget-id"
  }
}
```

Incomplete requests return a follow-up and persist a pending payload:

```json
{
  "ok": true,
  "state": {
    "nextState": "budget_conversation_state",
    "payload": {
      "intent": "set_budget",
      "category": "Food",
      "missing_fields": ["amount"],
      "pending": true
    }
  },
  "message": {
    "text": "How much for Food?",
    "parse_mode": "HTML",
    "disable_web_page_preview": true
  },
  "data": {
    "intent": "set_budget",
    "category": "Food",
    "missing_field": "amount"
  }
}
```

Supported intents are `budget_status`, `set_budget`, `set_sub_budget`, `delete_budget`, `delete_sub_budget`, `reset`, and `unknown`. `set_budget` requires `category` and `amount`; `set_sub_budget` requires `category`, `parent_category`, and `amount`; `budget_status` requires `category`. Delete intents currently return a not-wired message and reset state because no budget delete service method exists.

`budget_overview` returns all active budgets for the user. It includes parent budgets with active children grouped underneath, top-level budgets without children, and a short empty-state message when no active budgets exist. Each line shows used amount / total budget. Large overviews are split into `data.messages` chunks around 3500 characters so n8n can send each item as a separate Telegram bubble; `message.text` and `data.message` contain the first chunk for existing senders.

Overview request body:

```json
{
  "telegramUserId": "123456789",
  "userId": 1,
  "text": "show my budgets",
  "statePayload": {},
  "llmResult": {
    "intent": "budget_overview"
  }
}
```

Overview response shape:

```json
{
  "ok": true,
  "state": {
    "nextState": "idle",
    "payload": {}
  },
  "message": {
    "text": "📊 Budget Overview\n\nMonthly Allowance - Rp2.000.000 / Rp4.000.000\n├ Food — Rp1.000.000 / Rp2.000.000\n└ Transport — Rp1.000.000 / Rp2.000.000",
    "parse_mode": "HTML",
    "disable_web_page_preview": true
  },
  "data": {
    "intent": "budget_overview",
    "messages": [
      "📊 Budget Overview\n\nMonthly Allowance - Rp2.000.000 / Rp4.000.000\n├ Food — Rp1.000.000 / Rp2.000.000\n└ Transport — Rp1.000.000 / Rp2.000.000"
    ],
    "message": "📊 Budget Overview\n\nMonthly Allowance - Rp2.000.000 / Rp4.000.000\n├ Food — Rp1.000.000 / Rp2.000.000\n└ Transport — Rp1.000.000 / Rp2.000.000"
  }
}
```

### `POST /api/veyra/budgets/overspending-check`

Calculates direct-category current-cycle spending and classifies whether an overspending alert should be sent. This endpoint only reads `budget_alerts` to prevent duplicate notifications; it does not insert alert records or send Telegram messages.

Alert thresholds:

```txt
spent_percent >= 120 -> overspend_120
spent_percent >= 100 -> overspend_100
spent_percent >= 80  -> overspend_80
otherwise            -> null
```

Example request body:

```json
{
  "userId": "example-user-id",
  "category": "Food"
}
```

Example response:

```json
{
  "shouldAlert": true,
  "alreadyAlerted": false,
  "alertType": "overspend_80",
  "telegramHtml": "<b>Budget warning</b>\n\nCategory: <b>Food</b>\nSpent: Rp854.000 (85.4%)\nBudget: Rp1.000.000\nRemaining: Rp146.000",
  "alertRecord": {
    "budgetId": "example-budget-id",
    "alertType": "overspend_80",
    "periodKey": "2026-06-15"
  },
  "budgetId": "example-budget-id",
  "userId": "example-user-id",
  "category": "Food",
  "spentPercent": 85.4,
  "spentAmount": 854000,
  "budgetAmount": 1000000,
  "remainingAmount": 146000,
  "cycleStart": "2026-06-15",
  "cycleEnd": "2026-07-15",
  "periodKey": "2026-06-15"
}
```

`alreadyAlerted` is `true` when a row already exists in `budget_alerts` for the same `user_id`, `budget_id`, `alert_type`, and `period_key`. `periodKey` uses the full cycle start date (`YYYY-MM-DD`) to match production data. n8n should insert `alertRecord` into `budget_alerts` only after successful Telegram delivery.

### `POST /api/veyra/transactions/normalize`

Normalizes one transaction candidate without inserting it. This endpoint trims and validates input, maps transaction type to the database-safe values `expense`, `income`, `transfer`, or `reversal`, resolves `merchantNormalized` from production `merchant_aliases.alias_name` to `canonical_name` using the active `LIKE` matching behavior, and resolves `category` from `category_rules.merchant_pattern` using priority order when available.

Refund and cashback-like inputs are mapped to `income`; reversal, void, and chargeback-like inputs are mapped to `reversal`. Missing `transactionDate` defaults to the current timestamp, and missing `source` defaults to `manual`.

Confidence remains the Core API normalization-helper scale from `0` to `95` while this endpoint is normalization-only and does not own the production LLM categorizer fallback.

Example request body:

```json
{
  "userId": "example-user-id",
  "transactionType": "EXPENSE",
  "amount": "Rp50.000",
  "merchant": " gopay ",
  "category": null,
  "transactionDate": "2026-06-17T10:00:00.000Z",
  "source": "email",
  "notes": "BCA notification",
  "rawPayload": {
    "emailId": "example-email-id"
  }
}
```

Example response:

```json
{
  "userId": "example-user-id",
  "transactionType": "expense",
  "amount": 50000,
  "merchant": "gopay",
  "merchantNormalized": "GoPay",
  "category": "Transport",
  "transactionDate": "2026-06-17T10:00:00.000Z",
  "source": "email",
  "notes": "BCA notification",
  "confidence": 95,
  "warnings": []
}
```

### `POST /api/veyra/transactions/handle`

Handles one structured manual transaction result from the existing LLM parser. This endpoint does not parse raw free text itself: n8n or the client should send the user text to the LLM first, then pass the structured `llmResult` here.

The MVP supports `source: "manual"` only. `source: "email"` and other sources intentionally return `status: "unsupported_source"` for now; email transaction handling will be implemented later.

Core API normalizes transaction type, amount, transaction date, merchant, merchant alias, category, and confidence, then inserts directly into the production `transactions` table. It does not write to `pending_transactions`, does not create merchant aliases or category rules, and does not send Telegram messages. If `llmResult.category` is provided, Core API accepts it even when it does not exist in `budgets`; if category is missing, Core API tries the existing `category_rules` lookup and rejects the request if no category can be resolved because `transactions.category` is required.

Confidence may be sent as a decimal (`0.94`) or integer (`94`). Core API saves it as an integer from `0` to `100`; values `>= 90` are saved as `confirmed`, and lower values are saved as `pending`.

Example request body:

```json
{
  "telegramUserId": "976684739",
  "userId": 1,
  "source": "manual",
  "text": "Spend 25k for kopi tuku",
  "llmResult": {
    "transaction_type": "expense",
    "amount": 25000,
    "merchant": "kopi tuku",
    "category": "Coffee",
    "confidence": 0.94,
    "transaction_date": null,
    "notes": null,
    "missing_fields": []
  }
}
```

Example confirmed response:

```json
{
  "ok": true,
  "data": {
    "status": "confirmed",
    "transactionId": "123",
    "message": "\u2705 Recorded: Rp25.000 at Kopi Tuku under Coffee."
  }
}
```

Example pending response:

```json
{
  "ok": true,
  "data": {
    "status": "pending",
    "transactionId": "123",
    "message": "Please confirm this transaction.",
    "confirmationPayload": {
      "text": "Confirm transaction\n\nType: Expense\nAmount: Rp25.000\nMerchant: kopi tuku\nCategory: Coffee\nWallet: -\nNotes: -",
      "reply_markup": {
        "inline_keyboard": [
          [
            {
              "text": "Approve",
              "callback_data": "save_transaction:123"
            },
            {
              "text": "Change Category",
              "callback_data": "change_categories:123"
            }
          ],
          [
            {
              "text": "Reject",
              "callback_data": "cancel_transaction:123"
            }
          ]
        ]
      }
    }
  }
}
```

Unsupported source response:

```json
{
  "ok": true,
  "data": {
    "status": "unsupported_source",
    "transactionId": null,
    "message": "Transaction source email is not supported yet."
  }
}
```

Validation errors include missing `llmResult`, non-empty `llmResult.missing_fields`, missing required transaction fields, invalid amount, missing merchant, missing or unresolved category, unsupported transaction type, and confidence outside `0` to `100` after normalization.

### `POST /api/veyra/transactions/confirmation-payload`

Builds Telegram-ready confirmation text and inline keyboard data for a pending transaction. Manual payloads return plain text. Email payloads default to Telegram HTML text and `parseMode: "HTML"`. This endpoint does not insert or update transactions, does not handle callbacks, and does not send Telegram messages.

Production-compatible callback payloads use `transactions.id`, not `pending_transactions.id`. `callbackMode` defaults to `production`; the old `tx_*` callback names are available only with `callbackMode: "experimental"` for draft flows.

Example request body:

```json
{
  "pendingTransactionId": "pending-transaction-id",
  "transactionId": "transaction-id",
  "userId": "example-user-id",
  "transactionType": "expense",
  "amount": 50000,
  "merchant": "gopay",
  "merchantNormalized": "GoPay",
  "category": "Transport",
  "wallet": "BCA",
  "notes": "QRIS payment",
  "transactionDate": "2026-06-17T10:00:00.000Z",
  "source": "email",
  "confidence": 95,
  "warnings": []
}
```

Example response:

```json
{
  "text": "<b>Confirm transaction</b>\n\nType: Expense\nAmount: Rp50.000\nMerchant: GoPay\nCategory: Transport\nWallet: BCA\nNotes: QRIS payment",
  "parseMode": "HTML",
  "replyMarkup": {
    "inline_keyboard": [
      [
        {
          "text": "Approve",
          "callback_data": "save_transaction:transaction-id"
        },
        {
          "text": "Change Category",
          "callback_data": "change_categories:transaction-id"
        }
      ],
      [
        {
          "text": "Reject",
          "callback_data": "cancel_transaction:transaction-id"
        }
      ]
    ]
  },
  "summary": {
    "amount": 50000,
    "merchant": "GoPay",
    "category": "Transport",
    "wallet": "BCA",
    "notes": "QRIS payment"
  },
  "warnings": []
}
```

If `transactionId` is missing in production mode, the response still includes readable text, returns an empty `inline_keyboard`, and adds `callbacks require transactionId` to `warnings`.

### `POST /api/veyra/transactions/confirm`

Approves one production pending transaction. Core API finds the matching `transactions` row by `transactionId` and `userId`, then updates `status` from `pending` to `confirmed` and refreshes `updated_at`.

This endpoint does not edit or delete transactions, does not handle Telegram callbacks directly, and does not send Telegram messages.

Example request body:

```json
{
  "transactionId": "transaction-id",
  "userId": "example-user-id"
}
```

Example confirmed response:

```json
{
  "status": "confirmed",
  "transactionId": "transaction-id",
  "userId": "example-user-id",
  "summary": {
    "amount": 50000,
    "merchant": "GoPay",
    "category": "Transport"
  },
  "editMessage": {
    "text": "Transaction transaction-id confirmed: GoPay 50000",
    "parseMode": null
  }
}
```

If the transaction row is missing, `status` is `not_found`. If it is already confirmed, `status` is `already_confirmed`. If it is already rejected, `status` is `already_rejected`.

### `POST /api/veyra/transactions/cancel`

Rejects one production pending transaction. Core API finds the matching `transactions` row by `transactionId` and `userId`, then updates `status` from `pending` to `rejected` and refreshes `updated_at`.

Example request body:

```json
{
  "transactionId": "transaction-id",
  "userId": "example-user-id"
}
```

Example rejected response:

```json
{
  "status": "rejected",
  "transactionId": "transaction-id",
  "userId": "example-user-id",
  "summary": {
    "amount": 50000,
    "merchant": "GoPay",
    "category": "Transport"
  },
  "editMessage": {
    "text": "Transaction transaction-id cancelled.",
    "parseMode": null
  }
}
```

If the transaction row is missing, `status` is `not_found`. If it is already confirmed, `status` is `already_confirmed`. If it is already rejected, `status` is `already_rejected`.

### `GET /api/veyra/conversation-states/:userId`

Reads the current multi-step conversation state for one internal `telegram_users.id`. If no row exists in `conversation_states`, Core API returns `idle` with empty `stateData`.

Example response when no row exists:

```json
{
  "userId": "123",
  "stateName": "idle",
  "stateData": {},
  "expiresAt": null,
  "updatedAt": null
}
```

### `POST /api/veyra/conversation-states`

Upserts one conversation state row by `userId` using `ON CONFLICT (user_id) DO UPDATE`. `stateData` is optional and stored as JSONB. `updated_at` is refreshed on insert and update.

Supported state names:

```txt
idle
record_transaction_state
budget_conversation_state
```

Slash command aliases are accepted for n8n convenience:

```txt
/record -> record_transaction_state
/budget -> budget_conversation_state
```

Example request body:

```json
{
  "userId": "123",
  "stateName": "/record",
  "stateData": {
    "step": "amount"
  },
  "expiresAt": null
}
```

Example response:

```json
{
  "userId": "123",
  "stateName": "record_transaction_state",
  "stateData": {
    "step": "amount"
  },
  "expiresAt": null,
  "updatedAt": "2026-06-20T10:00:00.000Z"
}
```

### `POST /api/veyra/conversation-states/reset`

Resets one user to `idle`, stores `{}` in `state_data`, clears `expires_at`, and refreshes `updated_at`.

Example request body:

```json
{
  "userId": "123"
}
```

Example response:

```json
{
  "userId": "123",
  "stateName": "idle",
  "stateData": {},
  "expiresAt": null,
  "updatedAt": "2026-06-20T10:00:00.000Z"
}
```

This replaces only the duplicated n8n SQL/read-write block for `conversation_states`. Keep Telegram slash-command intake, conflict messages, Telegram sending, callback routing, and workflow orchestration in n8n.

### `POST /api/veyra/intents/classify`

Classifies one Telegram user message into a structured intent result. This endpoint is pure routing logic: it does not call an LLM, does not query PostgreSQL, does not format Telegram messages, and does not execute budget or transaction business logic.

The deterministic classifier is still experimental. Keep the production LLM classifier and analytics routing in n8n until fixture parity from real classifier examples is high.

Example request body:

```json
{
  "userId": 1,
  "message": "I spent 45k at GoPay",
  "conversationState": {},
  "timezone": "Asia/Jakarta"
}
```

Example response:

```json
{
  "intent": "add_transaction",
  "confidence": 0.81,
  "amount": 45000,
  "merchant": "GoPay",
  "category": null,
  "period": null,
  "limit": null,
  "transactionId": null,
  "budgetParent": null,
  "target": {
    "type": "merchant",
    "value": "GoPay"
  },
  "changes": null,
  "selection": null,
  "requiresConfirmation": true,
  "missingFields": [],
  "warnings": []
}
```

Supported initial intents:

```txt
set_budget, delete_budget, budget_status
add_transaction, edit_transaction, delete_transaction, confirm_transaction
select_transaction, confirm_action, cancel_action
spending_summary, category_spending, merchant_spending, spending_comparison
category_comparison, merchant_comparison
top_categories, top_merchants, largest_transactions, recent_transactions
daily_average_spending, most_frequent_merchant, spending_by_day, weekday_analysis
transaction_count, subscription_summary, spending_trend, cashflow_summary
help, greeting, unknown
```

### `POST /api/veyra/transactions/category-options`

Builds Telegram-ready category selection text and inline keyboard buttons for a transaction category callback. This endpoint reads the production `transactions` row for ownership and active leaf `budgets` for options; it does not update, confirm, insert, or send Telegram messages.

Production-compatible category callbacks use `catid:{budgetId}:{transactionId}` for active leaf budgets. Parent budgets with active children are excluded, child categories are labeled as `Parent / Child`, button labels are truncated to Telegram-safe length, and the endpoint falls back to `Food`, `Transport`, `Groceries`, `Bills`, `Health & Beauty`, `Shopping`, `Entertainment`, `Transfer`, and `Other` when no active leaf budgets exist. `callbackMode: "experimental"` keeps the old `tx_set_category:{pendingTransactionId}:{categorySlug}` draft format.

Example request body:

```json
{
  "transactionId": "transaction-id",
  "userId": "example-user-id"
}
```

Example response:

```json
{
  "status": "ok",
  "pendingTransactionId": "",
  "text": "Choose transaction category\n\nMerchant: GoPay\nAmount: Rp50.000",
  "replyMarkup": {
    "inline_keyboard": [
      [
        {
          "text": "Food",
          "callback_data": "catid:food-budget-id:transaction-id"
        }
      ],
      [
        {
          "text": "Health & Beauty",
          "callback_data": "catid:health-budget-id:transaction-id"
        }
      ]
    ]
  }
}
```

If the transaction row is missing, `status` is `not_found`. If a legacy pending row is supplied and already resolved, `status` is `already_resolved`.

### `POST /api/veyra/transactions/set-category`

Updates the selected production transaction category, sets `status = confirmed`, and returns Telegram edit-message data. The budget id must belong to the same user and be an active leaf budget.

Example request body:

```json
{
  "transactionId": "transaction-id",
  "budgetId": "food-budget-id",
  "userId": "example-user-id"
}
```

Example response:

```json
{
  "status": "updated",
  "pendingTransactionId": null,
  "transactionId": "transaction-id",
  "confirmationPayload": null,
  "summary": {
    "amount": 50000,
    "merchant": "GoPay",
    "category": "Food"
  },
  "editMessage": {
    "text": "Transaction transaction-id confirmed: GoPay 50000",
    "parseMode": null
  }
}
```

If the transaction row is missing, `status` is `not_found`. If the budget id does not belong to an active leaf budget for the same user, `status` is `unauthorized_budget`.

## How n8n Should Call This API

Use an HTTP Request node after the existing n8n trigger or after the Code node that currently builds the alert/message payload.

Recommended Aegis pilot node settings:

```txt
Method: POST
URL: http://core-api:3001/api/aegis/n8n-error
Send Body: JSON
Body: pass the raw n8n Error Trigger payload, or map workflow, execution, and error fields from the trigger item
```

If `CORE_API_KEY` is set in the Core API environment, add this HTTP header in n8n:

```txt
x-core-api-key: <value stored in n8n credentials or environment>
```

Then keep the existing reliable sender workflow and map the Core API response directly:

```txt
chat_id = {{$json.chat_id}}
text = {{$json.text}}
parse_mode = {{$json.parse_mode}}
disable_web_page_preview = {{$json.disable_web_page_preview}}
bot_token_env = {{$json.bot_token_env}}
```

This replaces only the n8n Code node or expression block that formats the Aegis error alert text. Keep the n8n Error Trigger, workflow routing, credentials, Telegram send node, and retry behavior in n8n.

If the Core API runs on the host instead of the same Docker network as n8n, use the host or reverse-proxy URL that n8n can reach. Do not put secrets in the URL.

Recommended Veyra budget status node settings:

```txt
Method: POST
URL: http://core-api:3001/api/veyra/budgets/status
Send Body: JSON
Body:
{
  "telegramUserId": "={{$json.telegram_user_id}}",
  "category": "={{$json.parsed.category}}"
}
```

For parent budget lookup, send the parent category in the same field:

```txt
Body:
{
  "userId": "={{$json.user_id}}",
  "category": "={{$json.parsed.parentCategory || $json.parsed.category}}"
}
```

Map downstream n8n fields from the response:

```txt
Budget amount = {{$json.budget_amount}}
Spent amount = {{$json.spent_amount}}
Remaining amount = {{$json.remaining_amount}}
Spent percent = {{$json.spent_percent}}
Child breakdown = {{$json.child_breakdown}}
Cycle start = {{$json.cycle_start}}
Cycle end = {{$json.cycle_end}}
```

This replaces only the n8n budget lookup/status SQL and calculation logic after fixture comparison. Keep Telegram triggers, intent routing, callback routing, message rendering, message sending, budget create/update/delete behavior, and workflow orchestration in n8n for now.

Recommended Veyra budget upsert node settings:

```txt
Method: POST
URL: http://core-api:3001/api/veyra/budgets/upsert
Send Body: JSON
Body:
{
  "userId": "={{$json.user_id}}",
  "category": "={{$json.parsed.category}}",
  "amount": "={{$json.parsed.amount}}",
  "periodType": "monthly"
}
```

For child budget creation, include the exact parent category parsed by the existing budget agent. Core API creates the parent row when it does not exist:

```txt
Body:
{
  "userId": "={{$json.user_id}}",
  "category": "={{$json.parsed.category}}",
  "amount": "={{$json.parsed.amount}}",
  "parentCategory": "={{$json.parsed.parentCategory}}",
  "periodType": "monthly"
}
```

Map downstream n8n fields from the response:

```txt
Budget id = {{$json.budget_id}}
Action = {{$json.action}}
Parent budget id = {{$json.parent_budget_id}}
Period type = {{$json.period_type}}
```

This replaces only the n8n budget create/update database logic. Keep Telegram triggers, intent parsing, message sending, budget delete behavior, and workflow orchestration in n8n for now.

Recommended Veyra budget handle node settings:

```txt
Method: POST
URL: http://core-api:3001/api/veyra/budgets/handle
Send Body: JSON
Body:
{
  "telegramUserId": "={{$json.telegram_user_id}}",
  "userId": "={{$json.user_id}}",
  "text": "={{$json.message_text}}",
  "statePayload": "={{$json.state_payload || {}}}",
  "llmResult": "={{$json.llm_result}}"
}
```

n8n should run LLM parsing first, then call `/api/veyra/budgets/handle`, then send `message.text`, `message.parse_mode`, and `message.disable_web_page_preview` through Telegram Reliable Sender for single-message replies. For `budget_overview`, iterate over `data.messages` and send each string as its own Telegram Reliable Sender call. This replaces only the budget workflow orchestration step after parsing; keep Telegram Trigger nodes, LLM parsing, Telegram sending, callback routing, credentials, retries, and production workflow management in n8n.

Recommended Veyra overspending check node settings:

```txt
Method: POST
URL: http://core-api:3001/api/veyra/budgets/overspending-check
Send Body: JSON
Body:
{
  "userId": "={{$json.user_id}}",
  "category": "={{$json.category}}"
}
```

Use `shouldAlert`, `alreadyAlerted`, `alertType`, and `telegramHtml` in n8n to decide whether to continue to the existing Telegram notification path. Send `telegramHtml` as Telegram HTML. After successful delivery, insert `alertRecord.budgetId`, `alertRecord.alertType`, and `alertRecord.periodKey` into `budget_alerts`. This replaces only the direct-category spending, threshold, duplicate-check, and alert text calculation; keep scheduling, transaction triggers, Telegram sending, delivery retry, and alert record insertion orchestration in n8n for now.

Recommended Veyra transaction normalize node settings:

```txt
Method: POST
URL: http://core-api:3001/api/veyra/transactions/normalize
Send Body: JSON
Body:
{
  "userId": "={{$json.user_id}}",
  "transactionType": "={{$json.type || $json.transaction_type}}",
  "amount": "={{$json.amount}}",
  "merchant": "={{$json.merchant}}",
  "category": "={{$json.category}}",
  "transactionDate": "={{$json.transaction_date}}",
  "source": "={{$json.source}}",
  "notes": "={{$json.notes}}",
  "rawPayload": "={{$json}}"
}
```

This replaces only the n8n transaction normalization Code node logic for already-parsed transaction candidates. Keep Gmail triggers, email fetch/parsing, n8n orchestration, LLM categorization fallback, Telegram confirmation/send, transaction insertion, pending transaction handling, merchant review queue upserts, and credentials in n8n for now.

Recommended Veyra manual transaction handle node settings:

```txt
Method: POST
URL: http://core-api:3001/api/veyra/transactions/handle
Send Body: JSON
Body:
{
  "telegramUserId": "={{$json.telegramUserId}}",
  "userId": "={{$json.userId}}",
  "source": "manual",
  "text": "={{$json.text}}",
  "llmResult": "={{$json.llmResult}}"
}
```

Use this after the existing manual transaction LLM parser. For `data.status = "confirmed"`, send `data.message` to Telegram. For `data.status = "pending"`, send `data.confirmationPayload.text` with `data.confirmationPayload.reply_markup`; the buttons use the existing production callbacks `save_transaction:{transactionId}`, `cancel_transaction:{transactionId}`, and `change_categories:{transactionId}`. This replaces only the manual transaction normalize/insert/confirmation decision logic. Keep Telegram triggers, LLM parsing, Telegram sending, callback routing, email transaction handling, and credentials in n8n for now.

Recommended Veyra transaction confirmation payload node settings:

```txt
Method: POST
URL: http://core-api:3001/api/veyra/transactions/confirmation-payload
Send Body: JSON
Body: map transaction fields from the prior n8n node, including transactions.id as transactionId
```

Manual transaction body:

```json
{
  "transactionId": "transaction-id",
  "userId": "example-user-id",
  "transactionType": "expense",
  "amount": 75000,
  "merchant": "Coffee Shop",
  "category": "Food",
  "wallet": "Cash",
  "notes": "Latte and breakfast",
  "transactionDate": "2026-06-17T10:00:00.000Z",
  "source": "manual"
}
```

Email pending transaction confirmation body:

```json
{
  "transactionId": "transaction-id",
  "userId": "example-user-id",
  "transactionType": "expense",
  "amount": 50000,
  "merchant": "gopay",
  "merchantNormalized": "GoPay",
  "category": "Transport",
  "wallet": "BCA",
  "notes": "QRIS payment",
  "transactionDate": "2026-06-17T10:00:00.000Z",
  "source": "email"
}
```

Then keep the existing Telegram Send Message node and map:

```txt
Telegram text = {{$json.text}}
Reply markup = {{$json.replyMarkup}}
Parse mode = {{$json.parseMode}}
```

Production callback data emitted by this endpoint:

```txt
Approve = save_transaction:{transactionId}
Cancel = cancel_transaction:{transactionId}
Change category = change_categories:{transactionId}
```

This replaces only the n8n Code node that builds confirmation text and inline keyboard payloads. Keep pending transaction persistence, Telegram sending, callback handling, final transaction insertion, and category-change routing in n8n for now. The old `tx_confirm`, `tx_category`, and `tx_reject` names are experimental only and require `callbackMode: "experimental"`.

Recommended Veyra transaction confirm callback flow:

```txt
Telegram Callback Query Trigger
  -> parse callback_data save_transaction:{transactionId}
  -> HTTP Request
     Method: POST
     URL: http://core-api:3001/api/veyra/transactions/confirm
     Body:
     {
       "transactionId": "={{$json.transactionId}}",
       "userId": "={{$json.user_id}}"
     }
  -> Telegram Edit Message Text
```

Map the Telegram confirmation message from the Core API response:

```txt
Confirmed text = {{$json.editMessage.text}}
Already resolved text = This pending transaction was already handled.
Not found text = Pending transaction was not found.
```

This replaces only the approve-pending-transaction status update logic. Keep callback routing, Telegram edit/send, Telegram answering, overspend orchestration, and category-change flows in n8n for now.

Recommended Veyra transaction cancel callback flow:

```txt
Telegram Callback Query Trigger
  -> parse callback_data cancel_transaction:{transactionId}
  -> HTTP Request
     Method: POST
     URL: http://core-api:3001/api/veyra/transactions/cancel
     Body:
     {
       "transactionId": "={{$json.transactionId}}",
       "userId": "={{$json.user_id}}"
     }
  -> Telegram Edit Message Text
```

Map the Telegram cancel message from the Core API response:

```txt
Cancelled text = {{$json.editMessage.text}}
Already resolved text = This pending transaction was already handled.
Not found text = Pending transaction was not found.
```

Use `already_confirmed`, `already_rejected`, and `not_found` to choose the existing n8n fallback text. Keep callback routing, Telegram edit/send, Telegram answering, overspend orchestration, and category-change flows in n8n for now.

Recommended Veyra transaction category callback flow:

```txt
Telegram Callback Query Trigger
  -> parse callback_data change_categories:{transactionId}
  -> HTTP Request
     Method: POST
     URL: http://core-api:3001/api/veyra/transactions/category-options
     Body:
     {
       "transactionId": "={{$json.transactionId}}",
       "userId": "={{$json.user_id}}"
     }
  -> Telegram Edit Message Text or Telegram Send Message
```

Map the Telegram category message from the HTTP response:

```txt
Telegram text = {{$json.text}}
Reply markup = {{$json.replyMarkup}}
```

Recommended Veyra set-category callback flow:

```txt
Telegram Callback Query Trigger
  -> parse callback_data catid:{budgetId}:{transactionId}
  -> HTTP Request
     Method: POST
     URL: http://core-api:3001/api/veyra/transactions/set-category
     Body:
     {
       "transactionId": "={{$json.transactionId}}",
       "budgetId": "={{$json.budgetId}}",
       "userId": "={{$json.user_id}}"
     }
  -> Telegram Edit Message Text or Telegram Send Message
```

Map the refreshed confirmation message from the HTTP response:

```txt
Telegram text = {{$json.editMessage.text}}
Parse mode = {{$json.editMessage.parseMode}}
```

This replaces only active leaf-budget lookup, category button formatting, and the transaction category update. Keep callback routing, Telegram answering/sending, overspend orchestration after successful selection, rejection, and edit-transaction flows in n8n for now.

Recommended Veyra intent classification architecture:

```txt
Telegram
  -> n8n Trigger
  -> POST /veyra/intents/classify
  -> Switch(intent)
  -> Call corresponding NestJS endpoint
  -> Return response to n8n
```

Recommended Veyra intent classification node settings:

```txt
Method: POST
URL: http://core-api:3001/api/veyra/intents/classify
Send Body: JSON
Body:
{
  "userId": "={{$json.user_id}}",
  "message": "={{$json.message.text}}",
  "conversationState": "={{$json.conversation_state || {}}}",
  "timezone": "Asia/Jakarta"
}
```

Use `{{$json.intent}}` in an n8n Switch node, then route to the matching Core API endpoint. This replaces only the n8n conversational routing Code or Switch pre-processing logic. Keep Telegram triggers, endpoint orchestration, Telegram response sending, and all write/confirmation flows in n8n for now.

The response shape follows the production classifier fields: `intent`, `period`, `merchant`, `category`, `limit`, `target`, `changes`, `selection`, and `confidence`. The deterministic helper also returns legacy helper fields such as `amount`, `transactionId`, `budgetParent`, `requiresConfirmation`, `missingFields`, and `warnings` for current Core API consumers.

Recommended Veyra conversation state check before accepting slash commands:

```txt
Method: GET
URL: http://core-api:3001/api/veyra/conversation-states/{{$json.user_id}}
Send Body: None
```

If `stateName` is not `idle`, keep the existing n8n branch that rejects or guides the user before starting a new slash-command conversation.

Recommended Veyra conversation state upsert for `/record`:

```txt
Method: POST
URL: http://core-api:3001/api/veyra/conversation-states
Send Body: JSON
Body:
{
  "userId": "={{$json.user_id}}",
  "stateName": "/record",
  "stateData": {
    "source": "telegram_slash_command"
  }
}
```

Recommended Veyra conversation state upsert for `/budget`:

```txt
Method: POST
URL: http://core-api:3001/api/veyra/conversation-states
Send Body: JSON
Body:
{
  "userId": "={{$json.user_id}}",
  "stateName": "/budget",
  "stateData": {
    "source": "telegram_slash_command"
  }
}
```

Recommended Veyra conversation state reset after completion or cancellation:

```txt
Method: POST
URL: http://core-api:3001/api/veyra/conversation-states/reset
Send Body: JSON
Body:
{
  "userId": "={{$json.user_id}}"
}
```

Use the response `stateName` and `stateData` in n8n Switch/IF nodes. This state API does not implement Telegram slash-command routing and does not send Telegram messages.

## What Stays In n8n For Now

- Telegram Trigger nodes.
- n8n Error Trigger nodes.
- Workflow orchestration and branch routing.
- Existing credential storage.
- Telegram message delivery and retry workflows.
- Production activation state and deployment behavior.

## What Moves To NestJS First

- Aegis alert text formatting.
- Veyra transaction normalization and validation.
- Budget intent parsing and validation.
- Telegram reply text formatting.
- Database reads/writes that are currently duplicated across workflows, after the service API contract is reviewed.

## Local Development

```bash
cd /home/unmeii/apps/core-api
cp .env.example .env
npm install
npm run start:dev
```

Health check:

```bash
curl http://localhost:3001/api/health
```

Aegis format test:

```bash
curl -X POST http://localhost:3001/api/aegis/n8n-error \
  -H 'content-type: application/json' \
  -d '{"workflow":{"id":"workflow-123","name":"Error Watchdog"},"execution":{"id":"exec-456","url":"https://n8n.example.com/execution/exec-456"},"error":{"message":"Request timed out","node":{"name":"HTTP Request"}}}'
```

Budget status test:

```bash
curl -X POST http://localhost:3001/api/veyra/budgets/status \
  -H 'content-type: application/json' \
  -d '{"telegramUserId":"example-telegram-user-id","category":"Food","asOfDate":"2026-06-17"}'
```

Budget upsert test:

```bash
curl -X POST http://localhost:3001/api/veyra/budgets/upsert \
  -H 'content-type: application/json' \
  -d '{"userId":"example-user-id","category":"Food","amount":1500000,"periodType":"monthly"}'
```

Overspending check test:

```bash
curl -X POST http://localhost:3001/api/veyra/budgets/overspending-check \
  -H 'content-type: application/json' \
  -d '{"userId":"example-user-id","category":"Food"}'
```

Transaction normalize test:

```bash
curl -X POST http://localhost:3001/api/veyra/transactions/normalize \
  -H 'content-type: application/json' \
  -d '{"userId":"example-user-id","transactionType":"EXPENSE","amount":"Rp50.000","merchant":" gopay ","source":"manual"}'
```

Transaction confirmation payload test:

```bash
curl -X POST http://localhost:3001/api/veyra/transactions/confirmation-payload \
  -H 'content-type: application/json' \
  -d '{"pendingTransactionId":"pending-1","userId":"example-user-id","transactionType":"expense","amount":50000,"merchant":"gopay","merchantNormalized":"GoPay","category":"Transport","transactionDate":"2026-06-17T10:00:00.000Z","source":"manual","confidence":95}'
```

Transaction confirm test:

```bash
curl -X POST http://localhost:3001/api/veyra/transactions/confirm \
  -H 'content-type: application/json' \
  -d '{"transactionId":"transaction-1","userId":"example-user-id"}'
```

Transaction cancel test:

```bash
curl -X POST http://localhost:3001/api/veyra/transactions/cancel \
  -H 'content-type: application/json' \
  -d '{"transactionId":"transaction-1","userId":"example-user-id"}'
```

Transaction category options test:

```bash
curl -X POST http://localhost:3001/api/veyra/transactions/category-options \
  -H 'content-type: application/json' \
  -d '{"transactionId":"transaction-1","userId":"example-user-id"}'
```

Transaction set category test:

```bash
curl -X POST http://localhost:3001/api/veyra/transactions/set-category \
  -H 'content-type: application/json' \
  -d '{"transactionId":"transaction-1","budgetId":"food-budget-id","userId":"example-user-id"}'
```

Intent classify test:

```bash
curl -X POST http://localhost:3001/api/veyra/intents/classify \
  -H 'content-type: application/json' \
  -d '{"userId":1,"message":"I spent 45k at GoPay","conversationState":{},"timezone":"Asia/Jakarta"}'
```

## Environment Variables

```txt
NODE_ENV=development
PORT=3001
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/veyra_core
CORE_API_KEY=optional-local-development-secret
```

Do not commit real `.env` files, production database URLs, Telegram tokens, chat IDs, webhook secrets, or API keys.

## Production Safety

This app does not alter existing n8n workflows. Connecting production n8n to this API should be done as a small reviewed workflow edit, starting with Aegis formatting only. Docker, reverse proxy, deployment, production workflow activation, and production database changes require separate approval.
