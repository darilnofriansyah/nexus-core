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

Formats a raw n8n Error Trigger payload into the production-compatible Telegram reliable sender payload. The endpoint also accepts the existing flattened mapped payload shape and a one-item array from n8n. n8n should still own the Error Trigger, routing, credentials, Telegram send, and retry behavior.

Example request body:

```json
{
  "workflow": {
    "id": "z4ZSHXh84SMSt8MR",
    "name": "Veyra Message Router - Nexus Core API"
  },
  "execution": {
    "id": "2212",
    "url": "https://n8n.example.com/workflow/z4ZSHXh84SMSt8MR/executions/2212",
    "mode": "webhook",
    "lastNodeExecuted": "Call Veyra Record Sub-Workflow",
    "executionContext": {
      "triggerNode": {
        "name": "Telegram Trigger"
      }
    },
    "error": {
      "message": "Bad request - please check your parameters",
      "name": "NodeApiError",
      "node": {
        "name": "POST Core API Transaction Handle"
      },
      "errorResponse": {
        "httpCode": 400,
        "messages": "400 - \"{\\\"message\\\":\\\"llmResult is missing required fields\\\",\\\"error\\\":\\\"Bad Request\\\",\\\"statusCode\\\":400}\"",
        "context": {
          "request": {
            "method": "POST",
            "uri": "http://core-api:3001/api/veyra/transactions/handle",
            "body": {
              "telegramUserId": "976684739",
              "userId": 1,
              "source": "manual",
              "text": "Bought TUKU 25rb",
              "llmResult": {
                "intent": "record_transaction",
                "transaction_type": "expense",
                "amount": 25000,
                "merchant": "TUKU",
                "category": "Others",
                "missing_fields": ["wallet"],
                "confidence": 0.6
              }
            }
          }
        }
      }
    }
  }
}
```

Example response:

```json
{
  "chatText": "🚨 <b>Aegis Incident</b>\n\n<b>Workflow:</b> Veyra Message Router - Nexus Core API\n<b>Execution:</b> <a href=\"https://n8n.example.com/workflow/z4ZSHXh84SMSt8MR/executions/2212\">2212</a>\n<b>Mode:</b> webhook\n<b>Trigger:</b> Telegram Trigger\n\n<b>Failed Node:</b> POST Core API Transaction Handle\n<b>Last Node:</b> Call Veyra Record Sub-Workflow\n<b>Error:</b> Bad request - please check your parameters\n\n<b>HTTP FAILURE</b>\n<b>Status:</b> 400\n<b>Endpoint:</b> POST /api/veyra/transactions/handle\n<b>Response:</b> llmResult is missing required fields | Bad Request | statusCode=400\n\n<b>Request Summary</b>\n<b>User:</b> 976684739 / 1\n<b>Source:</b> manual\n<b>Text:</b> Bought TUKU 25rb\n<b>LLM:</b> record_transaction, expense, 25000, TUKU, Others\n<b>Missing:</b> wallet\n<b>Confidence:</b> 0.6",
  "chat_id": "<ADMIN_TELEGRAM_ID>",
  "text": "🚨 <b>Aegis Incident</b>\n\n<b>Workflow:</b> Veyra Message Router - Nexus Core API\n<b>Execution:</b> <a href=\"https://n8n.example.com/workflow/z4ZSHXh84SMSt8MR/executions/2212\">2212</a>\n<b>Mode:</b> webhook\n<b>Trigger:</b> Telegram Trigger\n\n<b>Failed Node:</b> POST Core API Transaction Handle\n<b>Last Node:</b> Call Veyra Record Sub-Workflow\n<b>Error:</b> Bad request - please check your parameters\n\n<b>HTTP FAILURE</b>\n<b>Status:</b> 400\n<b>Endpoint:</b> POST /api/veyra/transactions/handle\n<b>Response:</b> llmResult is missing required fields | Bad Request | statusCode=400\n\n<b>Request Summary</b>\n<b>User:</b> 976684739 / 1\n<b>Source:</b> manual\n<b>Text:</b> Bought TUKU 25rb\n<b>LLM:</b> record_transaction, expense, 25000, TUKU, Others\n<b>Missing:</b> wallet\n<b>Confidence:</b> 0.6",
  "parse_mode": "HTML",
  "disable_web_page_preview": true,
  "bot_token_env": "AEGIS_TOKEN",
  "retry": {
    "eligible": false,
    "mode": "not_retryable",
    "reason": "non_retryable_http_status",
    "workflowId": "z4ZSHXh84SMSt8MR",
    "executionId": "2212"
  },
  "severity": "ERROR",
  "workflowId": "z4ZSHXh84SMSt8MR",
  "executionId": "2212",
  "executionUrl": "https://n8n.example.com/workflow/z4ZSHXh84SMSt8MR/executions/2212"
}
```

The formatter reads nested HTTP Request failures from `execution.error.errorResponse` when n8n provides them, including status code, response messages, request method, request URI, and a safe request-body summary. Embedded JSON inside `errorResponse.messages` is summarized when possible. Sensitive keys such as tokens, authorization headers, cookies, passwords, API keys, and secrets are redacted; stack traces, headers, full raw payloads, and full request bodies are not included in Telegram text.

Retry buttons are included only when Core API has a workflow id and execution id. `Retry workflow` is returned for likely transient failures such as HTTP `408`, `409`, `425`, `429`, HTTP `5xx`, timeouts, DNS/network failures, connection resets, and fetch failures. `Retry anyway` is returned when n8n does not provide enough HTTP details to classify the failure. No retry button is returned for known client/auth/validation failures such as HTTP `400`, `401`, `403`, `404`, `422`, bad request, missing required fields, unauthorized, forbidden, invalid credentials, or validation errors.

Retryable alert response shape:

```json
{
  "text": "🚨 <b>Aegis Incident</b>...",
  "parse_mode": "HTML",
  "reply_markup": {
    "inline_keyboard": [
      [
        {
          "text": "Retry workflow",
          "callback_data": "aegis_retry:z4ZSHXh84SMSt8MR:2212"
        }
      ]
    ]
  },
  "retry": {
    "eligible": true,
    "mode": "retryable",
    "reason": "transient_http_failure",
    "workflowId": "z4ZSHXh84SMSt8MR",
    "executionId": "2212"
  }
}
```

### `POST /api/aegis/retry/handle`

Normalizes an Aegis Telegram retry callback and returns the instruction n8n should execute. Core API does not call n8n directly and does not own n8n credentials.

Example request body:

```json
{
  "callbackData": "aegis_retry:z4ZSHXh84SMSt8MR:2212",
  "chatId": "-1001234567890",
  "messageId": "77"
}
```

Example response:

```json
{
  "status": "ready",
  "action": "retry_execution",
  "workflowId": "z4ZSHXh84SMSt8MR",
  "executionId": "2212",
  "telegram": {
    "editMessageText": {
      "chat_id": "-1001234567890",
      "message_id": "77",
      "text": "Retry requested for execution 2212.",
      "parse_mode": "HTML",
      "reply_markup": null
    }
  }
}
```

n8n should answer the Telegram callback query first, call this endpoint, then call n8n's failed-execution retry API when `action` is `retry_execution`. After the retry call, n8n should edit the original Telegram message and keep `reply_markup: null` so the retry buttons are cleared. If `ADMIN_TELEGRAM_ID` is configured, callbacks from other chats return `status: "unauthorized"`.

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

### `POST /api/veyra/dashboard/overview`

Returns the structured financial overview used by `veyra-dashboard`. This
endpoint is read-only: it does not call an LLM, format Telegram text, send
Telegram messages, or modify financial data.

Send the Core API key through the global guard:

```txt
x-core-api-key: <CORE_API_KEY>
```

At least one identifier is required, and only users with
`telegram_users.is_active IS TRUE` can access dashboard data. Unknown and
inactive Telegram identities return the same `404` response. When both
identifiers are supplied, they must resolve to the same active
`telegram_users` row. Identifiers are normalized to strings.

Veyra should send the server-verified Telegram identity as `telegramUserId`.
Browser-controlled clients must not supply an internal `userId`; that
identifier remains available only to trusted internal callers. `asOfDate`
defaults to today in `timezone`; `timezone` defaults to `Asia/Jakarta`.

Example request:

```json
{
  "telegramUserId": "976684739",
  "asOfDate": "2026-07-25",
  "timezone": "Asia/Jakarta"
}
```

Example response:

```json
{
  "user": {
    "id": "1",
    "telegramUserId": "976684739"
  },
  "current": {
    "period": {
      "label": "current_cycle",
      "start": "2026-07-01",
      "end": "2026-08-01"
    },
    "hasTransactions": true,
    "totals": {
      "income": 10000000,
      "spent": 4200000,
      "netCashflow": 5800000,
      "dailyAverage": 168000
    },
    "comparison": {
      "income": 10000000,
      "spent": 3900000,
      "netCashflow": 6100000,
      "dailyAverage": 156000
    },
    "dailySpend": [
      {
        "date": "2026-07-02",
        "amount": 25000
      }
    ],
    "categories": [
      {
        "category": "Food",
        "amount": 750000,
        "percent": 18,
        "transactionCount": 9
      }
    ],
    "budgets": [
      {
        "category": "Food",
        "limit": 1500000,
        "spent": 750000,
        "percent": 50,
        "status": "on-track"
      }
    ],
    "creditCard": {
      "limit": 10000000,
      "used": 2500000,
      "statementBalance": 0
    },
    "recentTransactions": [
      {
        "id": "123",
        "date": "2026-07-24",
        "merchant": "TUKU",
        "category": "Food",
        "amount": 25000,
        "type": "expense"
      }
    ]
  },
  "previous": {
    "period": {
      "label": "previous_cycle",
      "start": "2026-06-01",
      "end": "2026-07-01"
    },
    "hasTransactions": true,
    "totals": {
      "income": 10000000,
      "spent": 4500000,
      "netCashflow": 5500000,
      "dailyAverage": 150000
    },
    "comparison": {
      "income": 9000000,
      "spent": 4000000,
      "netCashflow": 5000000,
      "dailyAverage": 129032
    },
    "dailySpend": [],
    "categories": [],
    "budgets": [],
    "creditCard": {
      "limit": 10000000,
      "used": 7500000,
      "statementBalance": 7500000
    },
    "recentTransactions": []
  }
}
```

`current` includes the current financial cycle through `asOfDate`.
`current.comparison` uses the same elapsed-day count from the previous cycle.
`previous` is the complete previous cycle, and `previous.comparison` is the
complete cycle before that. Only confirmed income and expense transactions are
included. `current.creditCard` and `previous.creditCard` each contain one
combined summary for their cycle. When no summary exists, they return
`{ "limit": 0, "used": 0, "statementBalance": 0 }`. A valid user without
activity receives zero totals and empty arrays.

Curl:

```bash
curl -X POST "$CORE_API_URL/api/veyra/dashboard/overview" \
  -H "content-type: application/json" \
  -H "x-core-api-key: $CORE_API_KEY" \
  -d '{"telegramUserId":"976684739","asOfDate":"2026-07-25","timezone":"Asia/Jakarta"}'
```

## Transactions Web API

These endpoints are for the authenticated Veyra server only. The server resolves
the signed-in session to a Telegram identity, sends that verified
`telegramUserId`, and includes `x-core-api-key: <CORE_API_KEY>`. A browser must
never call Core directly or receive the Core API key. Core resolves only active
Telegram users; missing, inactive, and foreign transaction resources are
intentionally indistinguishable.

The API exposes only finalized transactions: `status: "confirmed"` and
`type: "income" | "expense"`, newest first by transaction date and ID. It
never returns `raw_payload`, ownership fields, or other internal data. Every
public transaction has exactly these fields:

```json
{
  "id": "123",
  "amount": 25000,
  "merchant": "TUKU",
  "category": "Dining",
  "type": "expense",
  "source": "email",
  "transactionDate": "2026-08-13T03:00:00.123456Z",
  "updatedAt": "2026-08-13T04:00:00.000001Z",
  "creditCard": true
}
```

`transactionDate` and `updatedAt` are UTC timestamp strings with microsecond
precision. `amount` is a positive safe whole-IDR integer. `source` is one of
`telegram`, `email`, `manual`, or `import`.

### `POST /api/veyra/transactions/query`

Queries the active user's finalized income and expense transactions. Send the
API key and JSON body from the Veyra server:

```json
{
  "telegramUserId": "976684739",
  "cycle": "current",
  "asOfDate": "2026-08-13",
  "timezone": "Asia/Jakarta",
  "type": "expense",
  "category": "Dining",
  "merchantQuery": "tuku",
  "limit": 50,
  "direction": "next",
  "cursor": null
}
```

`telegramUserId` is required. `limit` is `1..50` (default `50`);
`direction` is `next` or `previous` (default `next`); `type` is `income` or
`expense`; and `cycle` is `current` or `previous`. `asOfDate` defaults to today
in `timezone`, which defaults to `Asia/Jakarta`. Cycle boundaries are computed
by Core from the active user's financial-cycle start day. `category` is exact;
`merchantQuery` is a case-insensitive contains match. Callers cannot supply
status, source, sort fields, or date boundaries.

`previousCursor` and `nextCursor` are opaque base64url values. Pass a returned
cursor back unchanged with the matching direction; do not decode, construct, or
interpret it. Both directions always return rows in UI-descending order.

```json
{
  "items": [
    {
      "id": "123",
      "amount": 25000,
      "merchant": "TUKU",
      "category": "Dining",
      "type": "expense",
      "source": "email",
      "transactionDate": "2026-08-13T03:00:00.123456Z",
      "updatedAt": "2026-08-13T04:00:00.000001Z",
      "creditCard": true
    }
  ],
  "previousCursor": null,
  "nextCursor": "eyJ0cmFuc2FjdGlvbkRhdGUiOiIyMDI2LTA4LTEzVDAzOjAwOjAwLjEyMzQ1NloiLCJpZCI6IjEyMyJ9",
  "categories": ["Dining", "Transport"]
}
```

### `PATCH /api/veyra/transactions/:id`

Updates only `amount`, `merchant`, and `category` on one finalized income or
expense transaction owned by the active user. `expectedUpdatedAt` is required
and must exactly equal the public microsecond UTC `updatedAt` from the last
read. At least one editable field is required. `amount` must be a positive safe
whole-IDR integer; non-null text is trimmed and limited to 200 characters.
Expense merchant and category must remain non-empty. Income merchant and
category may be `null`. Date, type, source, status, notes, and raw payload are
immutable through this API.

```json
{
  "telegramUserId": "976684739",
  "expectedUpdatedAt": "2026-08-13T04:00:00.000001Z",
  "amount": 30000,
  "merchant": "TUKU Kemang",
  "category": "Dining"
}
```

On success (`200`), the response is the updated public transaction object shown
above. If the amount changes on an eligible confirmed email credit-card expense
row, Core atomically applies the signed amount delta to that financial cycle's
`credit_used`. It never changes `credit_limit` or `statement_balance`; no
per-card model is introduced.

### Error outcomes

Both routes return `401` when `x-core-api-key` is missing or invalid (when Core
API-key protection is configured). Query and PATCH return `200` on success. Both
return `400` for unsupported fields or invalid request values. Query returns
`404` for a missing or inactive Telegram identity. PATCH returns `404` for a
missing, inactive, or foreign transaction; `409` when `expectedUpdatedAt` is
stale; and `400` when no effective change remains or the final expense
merchant/category would be empty.

### `POST /api/veyra/messages/route`

Selects the Veyra sub-workflow route for one Telegram update. The endpoint resolves the user and checks active `conversation_states`; only when the deterministic result is `conversational` does it classify master intent with `gpt-5.4-mini` and append `masterIntent`. It does not execute budget/transaction logic, update conversation state, or send Telegram messages.

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
4. No state, `idle`, or expired state -> `conversational`, then classify `masterIntent`.
5. Unknown user -> `fallback`.

A state is active only when the row exists, `state_name` is not null, `state_name` is not `idle`, and `expires_at` is null or in the future. Expired states are not cleared by this endpoint.

Callback queries, slash commands, and every active state bypass OpenAI. Conversational classification uses the Responses API with strict structured output and `store: false`. Refusal, timeout, incomplete/empty output, invalid JSON, or application validation failure returns HTTP `503` without state or database mutation.

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

Conversational responses preserve those eight route fields and append the optional production-compatible classifier result:

```json
{
  "route": "conversational",
  "reason": "no_active_state",
  "userId": 1,
  "telegramUserId": "976684739",
  "text": "How much did I spend this month?",
  "messageType": "text",
  "command": null,
  "state": null,
  "masterIntent": {
    "intent": "spending_summary",
    "period": "this_month",
    "merchant": null,
    "category": null,
    "limit": null,
    "target": {
      "id": null,
      "merchant": null,
      "category": null,
      "amount": null,
      "period": null
    },
    "changes": {
      "amount": null,
      "merchant": null,
      "merchant_normalized": null,
      "category": null,
      "transaction_date": null,
      "transaction_type": null,
      "notes": null
    },
    "selection": null,
    "confidence": 0.97
  }
}
```

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

Use `{{$json.route}}` in an n8n Switch node to dispatch to the callback, slash-command, budget, record, transaction-edit, conversational, or fallback sub-workflow. For `conversational`, pass `{{$json.masterIntent}}` as the existing downstream `llmResult`. This replaces the `Master Intent Classifier` node in `Veyra Message Router with Master Intent - Nexus Core API` only. Keep Telegram Trigger nodes, the route Switch, callback/slash/state handling, budget/record/conversational sub-workflows, Telegram sending, credentials, retries, and production workflow management in n8n.

Rollback remains the previously active n8n workflow version: it may ignore the optional `masterIntent` field and restore its classifier node without changing this request payload. This repository change does not deploy Core, edit n8n, or change production activation state.

The sanitized master-intent contract fixture is
`src/ai/test/fixtures/master-intent/n8n-classifier.json`. It covers every
audited production intent with synthetic messages and drives the existing AI
service test:

```bash
npx tsc -p tsconfig.test.json && \
  node --test --test-name-pattern="sanitized n8n fixture" \
  dist-test/src/ai/veyra-ai.service.spec.js
```

This matches the callback-testing pattern: the fixture is executable local
contract evidence, while live n8n/model comparison remains a separate,
explicitly approved step. `liveOutputsCaptured: false` means the current
expectations are derived from the audited production prompt, not retained
production executions, so the fixture alone does not authorize cutover.

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

### `POST /api/veyra/budgets/categories`

Lists active budget categories for one user with each budget's parent category when it has one. This is intended for n8n branches that need budget IDs and category labels without re-running parent-budget SQL.

Request body:

```json
{
  "userId": "example-user-id"
}
```

Example response:

```json
{
  "status": "ok",
  "categories": [
    {
      "id": 12,
      "category": "Food",
      "parent_category": "Monthly Allowance"
    },
    {
      "id": 13,
      "category": "Transport",
      "parent_category": "Monthly Allowance"
    },
    {
      "id": 18,
      "category": "Netflix",
      "parent_category": "Subscription"
    }
  ]
}
```

This replaces only the active budget category lookup and parent-category join in n8n. Keep Telegram triggers, callback routing, Telegram sending, credentials, retries, and workflow orchestration in n8n.

### Category and pocket management

n8n HTTP Request nodes can use these bodies. NestJS manages the data; n8n keeps trigger, orchestration, and Telegram-send nodes.

`POST /api/veyra/categories/list`

```json
{ "userId": 1 }
```

`POST /api/veyra/categories/create`

```json
{ "userId": 1, "name": "Toys" }
```

`POST /api/veyra/categories/archive`

```json
{ "userId": 1, "categoryId": "17" }
```

`POST /api/veyra/budgets/pockets/list`

```json
{ "userId": 1 }
```

`POST /api/veyra/budgets/pockets/rename`

```json
{ "userId": 1, "pocketId": "42", "name": "Monthly Transactions" }
```

`POST /api/veyra/budgets/pockets/default`

```json
{ "userId": 1, "pocketId": "42" }
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

Deprecated. Use `POST /api/veyra/budgets/overspending/handle` plus `POST /api/veyra/budgets/overspending/record` for new n8n flows.

### `POST /api/veyra/budgets/overspending/handle`

Calculates direct-category current-cycle spending and classifies whether an overspending alert should be sent. When `transactionId` is provided, Core API fetches the transaction, skips pending/rejected/non-expense rows, inserts new `budget_alerts` rows for dedupe, and returns Telegram-ready warning text for n8n to send. Category-only calls remain available for manual/debug checks.

Alert thresholds:

```txt
spent_percent >= 100 -> budget_100
spent_percent >= 90  -> budget_90
spent_percent >= 75  -> budget_75
projected overrun    -> budget_forecast_overrun
otherwise            -> null
```

Example request body:

```json
{
  "userId": 1,
  "category": "Food",
  "transactionId": 123,
  "asOfDate": "2026-06-25"
}
```

Example `alert_required` response:

```json
{
  "ok": true,
  "status": "alert_required",
  "shouldAlert": true,
  "alreadyAlerted": false,
  "message": {
    "text": "⚠️ <b>Budget Warning</b>\n\nFood has reached 85.4%.\nSpent: Rp854.000\nBudget: Rp1.000.000\nRemaining: Rp146.000",
    "parse_mode": "HTML",
    "disable_web_page_preview": true
  },
  "data": {
    "transactionId": 123,
    "userId": "1",
    "budgetId": "12",
    "category": "Food",
    "alertType": "budget_75",
    "spentPercent": 85.4,
    "remainingAmount": 146000
  }
}
```

Example `no_alert` response:

```json
{
  "ok": true,
  "status": "no_alert",
  "shouldAlert": false,
  "alreadyAlerted": false,
  "message": null,
  "data": {
    "userId": "1",
    "budgetId": "12",
    "category": "Food",
    "spentPercent": 42.5,
    "spentAmount": 425000,
    "budgetAmount": 1000000,
    "remainingAmount": 575000,
    "cycleStart": "2026-06-25",
    "cycleEnd": "2026-07-25"
  }
}
```

Example `already_alerted` response:

```json
{
  "ok": true,
  "status": "already_alerted",
  "shouldAlert": false,
  "alreadyAlerted": true,
  "message": null,
  "data": {
    "userId": "1",
    "budgetId": "12",
    "category": "Food",
    "alertType": "overspend_80",
    "periodKey": "2026-06-25"
  }
}
```

`budget_alerts` dedupe uses `budget_id`, `alert_type`, and full cycle-start `period_key` (`YYYY-MM-DD`); Core API checks the budget's `user_id` through `budgets`. n8n should send `message` through Telegram Reliable Sender when `status` is `alert_required`; it no longer needs to call this endpoint after every transaction mutation.

### `POST /api/veyra/budgets/overspending/record`

Records that an overspending alert was successfully delivered. This endpoint is idempotent and only writes `budget_alerts`; it does not calculate spending or send Telegram messages.

Example request body:

```json
{
  "userId": 1,
  "budgetId": 12,
  "alertType": "overspend_80",
  "thresholdPercent": 80,
  "periodKey": "2026-06-25"
}
```

Example response:

```json
{
  "ok": true,
  "status": "recorded",
  "data": {
    "userId": "1",
    "budgetId": "12",
    "alertType": "overspend_80",
    "thresholdPercent": 80,
    "periodKey": "2026-06-25"
  }
}
```

If the row already exists, `status` is `already_recorded` with the same `data` shape. Recommended database hardening when applying non-destructive schema improvements:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS budget_alerts_unique_period_alert
ON budget_alerts (budget_id, alert_type, period_key);
```

### `POST /api/veyra/transactions/normalize`

Normalizes one transaction candidate without inserting it. This endpoint trims and validates input, maps transaction type to the database-safe values `expense`, `income`, `transfer`, or `reversal`, resolves `merchantNormalized` from production `merchant_aliases.alias_name` to `canonical_name` using the active `LIKE` matching behavior, and resolves `category` from `category_rules.merchant_pattern` using priority order when available. Income may omit merchant and category; expenses still require merchant.

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

Handles one manual transaction. When `llmResult` is absent, Core extracts the transaction from `text`; this requires `OPENAI_API_KEY` in the Core API environment. `llmResult` remains accepted temporarily as the rollback path, so callers can keep using the existing n8n parser while the cutover is validated. OpenAI extraction failures return HTTP `503` and do not write a transaction or conversation state.

The MVP supports `source: "manual"` only. `source: "email"` and other sources intentionally return `status: "unsupported_source"` for now; email transaction handling will be implemented later.

Core API normalizes transaction type, amount, transaction date, merchant, merchant alias, category, and confidence, then inserts directly into the production `transactions` table. It does not write to `pending_transactions`, does not create merchant aliases or category rules, and does not send Telegram messages. Expenses require merchant and category; if `llmResult.category` is missing, Core API tries the existing `category_rules` lookup and rejects the request when no category resolves. Income may omit merchant and category, which are persisted as `NULL`.

Manual expenses resolve category and pocket independently before insert. Send optional `pocketId` to select an active top-level pocket; otherwise Core uses the user's default pocket. An unknown AI category saves as `Uncategorized` with a `Review Category` callback, rather than creating a budget. If no default exists and more than one pocket is available, Core returns `status: "awaiting_pocket"` with `pockets` and writes nothing; n8n keeps pocket selection and the follow-up HTTP Request orchestration.

Apply `docs/migration/2026-07-24-income-nullable-category.sql` before deploying this compatible API version.

Confidence may be sent as a decimal (`0.94`) or integer (`94`). Core API saves it as an integer from `0` to `100`; values `>= 90` are saved as `confirmed`, and lower values are saved as `pending`.

Confirmed transaction saves run `TransactionService.evaluateTransactionWatchdog(transactionId)` after the insert succeeds. Core API evaluates budget impact and transaction risk, then returns ordered `notifications` for n8n to deliver through Telegram. n8n should not call budget or risk endpoints separately after transaction success.

If the LLM returns `missing_fields`, Core API stores the partial payload in `conversation_states` as `record_transaction_state` and returns a follow-up question instead of a validation error. After a successful manual insert, Core API resets the user's conversation state to `idle`. If the insert fails, the state is preserved so the user can retry. Cancel text (`cancel`, `reset`, `stop`, `exit`, `batal`, or `keluar`) resets the state to `idle` and returns `status: "cancelled"` without inserting a transaction.

Core extraction request body:

```json
{
  "telegramUserId": "976684739",
  "userId": 1,
  "source": "manual",
  "text": "Spend 25k at Tuku"
}
```

Rollback request body with caller-provided `llmResult`:

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

Explicit-pocket n8n HTTP Request body:

```json
{
  "userId": 1,
  "telegramUserId": "976684739",
  "source": "manual",
  "text": "Bought a toy for 500000",
  "pocketId": "42",
  "llmResult": {
    "intent": "record_transaction",
    "transaction_type": "expense",
    "amount": 500000,
    "merchant": "Toy Store",
    "category": "Toys",
    "confidence": 95,
    "missing_fields": []
  }
}
```

Income request without merchant or category:

```json
{
  "telegramUserId": "976684739",
  "userId": 1,
  "source": "manual",
  "text": "I got my salary income with amount of 19828k",
  "llmResult": {
    "transaction_type": "income",
    "amount": 19828000,
    "confidence": 0.8,
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
    "message": "\u2705 Recorded: Rp25.000 at Kopi Tuku under Coffee.",
    "notifications": [],
    "watchdog": {
      "checked": true,
      "hasAlert": false,
      "alerts": []
    }
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
              "text": "Save",
              "callback_data": "save_transaction:123"
            },
            {
              "text": "Change Category",
              "callback_data": "change_categories:123"
            }
          ],
          [
            {
              "text": "Cancel",
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

Cancel response:

```json
{
  "ok": true,
  "data": {
    "status": "cancelled",
    "transactionId": null,
    "message": "Transaction recording cancelled."
  }
}
```

Missing-field follow-up response:

```json
{
  "ok": true,
  "data": {
    "status": "awaiting_missing_field",
    "transactionId": null,
    "message": "Which category should I use?",
    "state": {
      "nextState": "record_transaction_state",
      "payload": {
        "transaction_type": "expense",
        "amount": 25000,
        "merchant": "kopi tuku",
        "confidence": 95,
        "missing_fields": ["category"],
        "pending": true
      }
    }
  }
}
```

Validation errors include missing `text` when `llmResult` is absent, missing required transaction fields not reported through `llmResult.missing_fields`, invalid amount, missing expense merchant, missing or unresolved expense category, unsupported transaction type, and confidence outside `0` to `100` after normalization.

#### n8n cutover and rollback

Replace `Basic LLM Chain` and its attached `OpenAI Chat Model` in workflow `rbKbj56pSbMU5vTp`; send the Telegram text directly to this endpoint without `llmResult`. Keep the Telegram trigger/intake, HTTP Request to Core, response switch, Telegram sender/editor, retries, Aegis error handling, and transaction callback routing in n8n.

Do not activate, deactivate, delete, or deploy a workflow as part of this change. Cut over only after a sanitized old-n8n-versus-Core parity check accepts `Spend 25k at Tuku`, `I got salary 19.828jt`, `Transfer 100k to Budi`, `Spent at Tuku`, `batal`, and `hello` as equivalent in intent, transaction type, amount, missing fields, confidence band, endpoint status, and Telegram response shape. Category and merchant wording may differ only when the existing Core normalizer persists the same values.

Keep the prior active n8n version and caller-provided `llmResult` support for rollback. Rollback restores that n8n version only; no Core or database rollback is required.

### `POST /api/veyra/transactions/manage/handle`

Moves transaction edit/delete conversation handling into Core API. n8n sends the Telegram user id, raw initial text, the LLM parsed initial command, or Telegram callback data as `text`; Core API owns user resolution, `conversation_states`, lookup, selection, confirmation, edit, soft delete, message text, and `reply_markup`.

Initial edit example:

```json
{
  "telegramUserId": "123456789",
  "text": "edit kopi tuku to Food",
  "statePayload": {},
  "llmResult": {
    "intent": "edit_transaction",
    "target": {
      "id": null,
      "merchant": "kopi tuku",
      "category": null,
      "amount": null,
      "period": "recent"
    },
    "changes": {
      "amount": null,
      "merchant": null,
      "merchant_normalized": null,
      "category": "Food",
      "transaction_date": null,
      "transaction_type": null,
      "notes": null
    },
    "selection": null,
    "confidence": 0.86
  }
}
```

Callback example:

```json
{
  "telegramUserId": "123456789",
  "text": "veyra_tx_manage:select:1",
  "statePayload": {},
  "llmResult": null
}
```

Response shape:

```json
{
  "ok": true,
  "status": "needs_selection",
  "message": "I found several transactions. Pick one:",
  "reply_markup": {
    "inline_keyboard": []
  },
  "state": {
    "state_name": "select_transaction",
    "state_data": {}
  },
  "data": {}
}
```

Statuses are `needs_selection`, `needs_confirmation`, `completed`, `cancelled`, `not_found`, and `invalid`. Supported intents are `edit_transaction`, `delete_transaction`, and `cancel_action`. Supported callback data is only `veyra_tx_manage:select:{index}`, `veyra_tx_manage:confirm`, and `veyra_tx_manage:cancel`.

State flow:

```txt
initial edit/delete + llmResult
  -> select_transaction when multiple matches
  -> confirm_action when one match or after select callback
  -> completed after confirm callback
  -> idle after completed, cancelled, not_found, invalid expired state
```

Core API resolves `telegramUserId` through `telegram_users.telegram_id` and uses internal `telegram_users.id` for ownership checks. It does not trust `statePayload`; multi-step selection and confirmation read `conversation_states.state_data`. Manage states expire after 15 minutes.

Selection `reply_markup`:

```json
{
  "inline_keyboard": [
    [
      {
        "text": "1. Kopi Tuku — Rp25.000",
        "callback_data": "veyra_tx_manage:select:1"
      }
    ],
    [
      {
        "text": "Cancel",
        "callback_data": "veyra_tx_manage:cancel"
      }
    ]
  ]
}
```

Confirmation `reply_markup`:

```json
{
  "inline_keyboard": [
    [
      {
        "text": "Confirm",
        "callback_data": "veyra_tx_manage:confirm"
      },
      {
        "text": "Cancel",
        "callback_data": "veyra_tx_manage:cancel"
      }
    ]
  ]
}
```

Edit confirmation example:

```text
Confirm edit?

Before:
Kopi Tuku — Others — Rp25.000

After:
Kopi Tuku — Food — Rp25.000
```

Delete confirmation example:

```text
Confirm delete?

Kopi Tuku — Food — Rp25.000

This will mark it as rejected.
```

Delete is a soft delete: Core API updates `transactions.status = 'rejected'` and `updated_at = now()`. n8n should pass `reply_markup` directly to the Telegram sender/editor and keep Telegram triggers, callback answering, message sending/editing, and credentials in n8n.

### `POST /api/veyra/transactions/email/handle`

Handles one Gmail-sourced transaction notification. Core API tries existing hard-coded bank parsers first, then active user-scoped learned templates, then invokes its email AI fallback for an authenticated likely transaction. The fallback uses the existing `VeyraAiService`, `gpt-4.1-mini`, the Responses API with `store: false`, and a strict JSON schema. Every AI-created candidate remains pending until the user confirms it; confirmation activates its validated learned template only when the stored Gmail sender metadata has aligned DKIM or DMARC authentication.

The handler derives the internal `userId` from `telegramUserId`; an included `userId` is treated as a compatibility assertion and must match. It deduplicates Gmail messages through `transaction_imports` using `source = "email"` and `source_reference = email.messageId`. It normalizes the email body, parses `emailText` first, then falls back to `emailHtml` converted with `html-to-text` when the text body is missing, too short, or not parseable. Import metadata stores only the normalized sender, sanitized authentication, and a SHA-256 binding of the normalized subject and body; it does not store subject or body content. Resolve and correction submissions must match that stored sender, authentication, and binding before they can persist a result. Imports created before the binding was introduced remain review-compatible only when sender and authentication match, but they cannot learn or activate a template.

The `needs_ai` detector evaluates subject and body together, but admits only known providers with aligned sender authentication. This allows a trusted notification whose body contains only an amount to use a transactional subject as the missing signal, while marketing messages and arbitrary authenticated senders remain outside AI fallback. Parse outcomes are logged to `email_parse_attempts` with structured diagnostics and a trimmed `body_sample`, not the full email body. The table definitions are in `docs/migration/2026-06-23-email-transaction-imports.sql` and should be applied separately.

The deterministic BCA parser accepts both transaction and cancellation
notification titles. Indonesian cancellation markers such as `PEMBATALAN` and
`dibatalkan` produce `transactionType = "reversal"`; the n8n HTTP Request
payload does not change.

Confirmed saves insert into `transactions` with `source = "email"` and `status = "confirmed"` only when the parser returns a valid transaction, amount is positive, merchant is known or an allowed fallback, and category resolves from `category_rules` or an allowed existing fallback budget category. A valid deterministic parse that still needs sender-authentication, merchant, alias, or category review creates one pending transaction and returns the normal confirmation actions. Expense reviews with an unresolved merchant or category must be corrected before Save; income retains its existing optional merchant/category behavior. Redelivery, including the loser of a concurrent import race, resumes the same pending transaction instead of escalating it to AI.

Initial Gmail HTTP Request body:

```json
{
  "telegramUserId": "976684739",
  "userId": 1,
  "source": "email",
  "email": {
    "messageId": "gmail-message-id",
    "threadId": "gmail-thread-id",
    "from": "card@bca.co.id",
    "subject": "Credit Card Transaction Notification",
    "date": "2026-07-27T10:00:00+07:00",
    "emailText": "normalized plain-text body",
    "emailHtml": "<p>optional fallback body</p>",
    "authentication": {
      "dkim": "pass",
      "spf": "pass",
      "dmarc": "pass",
      "domain": "bca.co.id"
    }
  }
}
```

Example confirmed response:

```json
{
  "status": "confirmed",
  "provider": "Krom",
  "templateKey": "krom-qris-payment",
  "reason": null,
  "transaction": {
    "id": "123",
    "userId": "1",
    "transactionType": "expense",
    "amount": 25000,
    "merchant": "Kopi Tuku",
    "merchantNormalized": "Kopi Tuku",
    "category": "Food",
    "transactionDate": "2026-06-22T03:00:00.000Z",
    "source": "email",
    "status": "confirmed",
    "confidence": 97
  },
  "parsed": {
    "ok": true,
    "provider": "Krom",
    "templateKey": "krom-qris-payment",
    "emailId": "gmail-message-id",
    "merchant": "Kopi Tuku",
    "merchantNormalized": null,
    "amount": 25000,
    "transactionDate": "2026-06-22T10:00:00+07:00",
    "bank": "Krom",
    "paymentType": "QRIS",
    "type": "expense",
    "confidence": 97,
    "isTransaction": true,
    "raw": {
      "bodySource": "text"
    },
    "warnings": []
  },
  "telegram": {
    "text": "<b>Transaction recorded</b>\n\nAmount: Rp25.000\nMerchant: Kopi Tuku\nCategory: Food\nSource: Krom",
    "parseMode": "HTML"
  }
}
```

Possible statuses are `confirmed`, `needs_review`, `needs_ai`, `duplicate`, `ignored_non_transaction`, `unsupported_provider`, `unsupported_template`, and `parse_failed`. The `telegram.text` field is HTML-safe and suitable for n8n Telegram routing with `parseMode: "HTML"`.

`needs_ai` is the internal rollback handoff when neither deterministic path produced a usable result and no AI service is injected. In the normal application module, Core sends the already validated Gmail request to its AI service and feeds the structured result through the same identity-bound review validator used by `resolve-review`. A valid candidate returns `needs_review`; an inference failure returns `needs_review` / `ai_failed` without inserting a transaction or template.

This endpoint can replace deterministic email parser Code nodes, the high-confidence direct insert branch, and the initial n8n AI round trip. Gmail triggers, email fetching/refetching, Telegram sends, retries, callback routing, and correction collection remain in n8n. The existing correction flow may continue calling AI in n8n until it receives its own migration slice.

### `POST /api/veyra/transactions/email/source-reference`

Resolves the Gmail message ID linked to one user-owned pending email
transaction. This endpoint exists only for the n8n
`edit_email_details:{transactionId}` branch so Gmail can refetch the original
message before AI correction.

Request:

```json
{
  "telegramUserId": "976684739",
  "transactionId": "123"
}
```

Response:

```json
{
  "transactionId": "123",
  "messageId": "gmail-message-id"
}
```

Invalid identifiers return `400`. Unknown users and missing, foreign-owned,
non-email, non-pending, or unlinked transactions return the same `404`. Core
API performs no Gmail request. Gmail refetch, AI regeneration, callback
interception, Telegram handling, and workflow activation remain in n8n.

### `POST /api/veyra/transactions/email/resolve-review`

Accepts a structured email AI result for correction and rollback compatibility. Initial fallback inference now enters this same validation and persistence path internally from `email/handle`. Every AI candidate is persisted as a pending email transaction for user confirmation, regardless of confidence. Core API validates the transaction fields and retains a learned-template proposal only when it can replay safely against the supplied email. This endpoint does not itself call an LLM or send Telegram messages.

The endpoint accepts confidence as `0..1` or `0..100`; the response normalizes it to `0..100`. It does not create budgets. If the AI category is not an active budget category, the candidate still remains pending with that category for the user to correct.

Structured n8n AI submission:

```json
{
  "telegramUserId": "976684739",
  "reviewToken": "gmail-message-id",
  "isTransaction": true,
  "email": {
    "messageId": "gmail-message-id",
    "from": "card@bca.co.id",
    "subject": "Credit Card Transaction Notification",
    "date": "2026-07-27T10:00:00+07:00",
    "emailText": "normalized plain-text body",
    "authentication": {
      "dkim": "pass",
      "spf": "pass",
      "dmarc": "pass",
      "domain": "bca.co.id"
    }
  },
  "transactionCandidate": {
    "source": "email",
    "bank": "BCA",
    "transactionType": "expense",
    "amount": 25000,
    "merchant": "Kopi Tuku",
    "merchantNormalized": "Kopi Tuku",
    "transactionDate": "2026-07-27T09:30:00+07:00",
    "description": "BCA credit-card purchase",
    "rawPayload": {}
  },
  "resolution": {
    "category": "Food",
    "confidence": 98,
    "resolver": "llm"
  },
  "templateProposal": {
    "provider": "BCA",
    "templateKey": "learned-bca-card",
    "requiredAnchors": ["Merchant / ATM", "Pada Tanggal", "Sejumlah"],
    "forbiddenAnchors": ["Promo"],
    "merchant": {
      "kind": "text",
      "after": "Merchant / ATM",
      "before": "Jenis Transaksi"
    },
    "amount": {
      "kind": "idr_amount",
      "after": "Sejumlah"
    },
    "transactionDate": {
      "kind": "datetime",
      "after": "Pada Tanggal",
      "before": "Sejumlah"
    },
    "transactionType": "expense",
    "paymentType": "Credit Card"
  }
}
```

Example pending response:

```json
{
  "status": "pending",
  "transaction": {
    "id": "123",
    "userId": "1",
    "transactionType": "expense",
    "amount": 25000,
    "merchant": "TUKU",
    "merchantNormalized": "tuku",
    "category": "Food",
    "transactionDate": "2026-06-24T17:00:00.000Z",
    "source": "email",
    "status": "pending",
    "confidence": 84
  },
  "telegramText": "<b>Confirm transaction</b>\n\nType: Expense\nAmount: Rp25.000\nMerchant: tuku\nCategory: Food\nDate: 2026-06-24",
  "actions": {
    "confirm": {
      "action": "save_transaction",
      "transactionId": "123"
    },
    "cancel": {
      "action": "cancel_transaction",
      "transactionId": "123"
    },
    "changeCategory": {
      "action": "change_categories",
      "transactionId": "123"
    },
    "editDetails": {
      "action": "edit_email_details",
      "transactionId": "123"
    }
  },
  "replyMarkup": {
    "inline_keyboard": [
      [
        {
          "text": "Save",
          "callback_data": "save_transaction:123"
        },
        {
          "text": "Edit Details",
          "callback_data": "edit_email_details:123"
        }
      ],
      [
        {
          "text": "Change Category",
          "callback_data": "change_categories:123"
        },
        {
          "text": "Cancel",
          "callback_data": "cancel_transaction:123"
        }
      ]
    ]
  }
}
```

`reviewToken` must exactly equal `email.messageId`. `templateProposal` is optional. A malformed proposal, a proposal that cannot replay the email, or a proposal whose replayed amount, merchant, date, or transaction type differs from `transactionCandidate` does not block the user review; Core API stores no validated template for it. A retained proposal is activated only after the user confirms the pending transaction and aligned sender authentication is present.

`transactionCandidate.description` is untrusted model prose. Adaptive initial and
correction requests neither persist nor return it. The deprecated exact legacy
candidate-only request shape below preserves its historical description behavior
until that compatibility path is removed.

Template activation is retryable. A failed activation leaves the validated
proposal on the confirmed transaction; repeating Save (or the category
confirmation path) retries it. Activation and pending-marker removal share one
locked database transaction, so a successful activation consumes the marker
exactly once and later callback redelivery cannot reactivate the template.

For rollout compatibility only, the previously deployed initial request shape
with exactly `telegramUserId`, `transactionCandidate`, and `resolution` remains
accepted without `email` or `reviewToken`. It creates a pending transaction
without an import binding, sender authentication, parser source, or validated
template, so it can never activate or learn an email parser template. This
compatibility path is deprecated; n8n should migrate to the identity-bound
request above. Adding any adaptive field such as `templateProposal`,
`transactionId`, `aiError`, or `isTransaction` requires the normal
`reviewToken`/`email.messageId` binding.

Runtime `email.authentication` is reduced before persistence to normalized
`dkim`, `spf`, `dmarc`, and a validated domain. Unknown properties, headers,
and body-like values are discarded. Expense candidates must include a
resolved merchant; blank or `Unknown` merchants are rejected before a pending
row is inserted or corrected. Successful initial and correction submissions
also clear any stale failure status for the same parse attempt in the same
database transaction.

AI correction uses the preceding structured submission plus the existing pending row:

```json
{
  "transactionId": "123"
}
```

n8n refetches Gmail by `messageId`, sends the original candidate, the user's correction, and the email to its AI node, then sends the corrected `transactionCandidate` and regenerated `templateProposal` back to Core API. The correction updates that pending email transaction; it does not create another one.

n8n must intercept `edit_email_details:*` itself and must not forward it to the generic Core API callback handler. It uses that action to gather the correction and invoke its AI node. The existing production callbacks remain owned by their current n8n routes: `save_transaction:*`, `change_categories:*`, and `cancel_transaction:*`.

When the AI node fails, n8n submits:

```json
{
  "telegramUserId": "976684739",
  "reviewToken": "gmail-message-id",
  "email": {
    "messageId": "gmail-message-id",
    "from": "card@bca.co.id",
    "subject": "Credit Card Transaction Notification",
    "emailText": "normalized plain-text body"
  },
  "aiError": "model unavailable"
}
```

Core API returns `status: "needs_review"` with `reason: "ai_failed"` and the
fixed message `AI processing failed`, records that same safe diagnostic on the
import and parse attempt, and inserts neither a transaction nor a template.
The caller-provided `aiError` is treated only as a failure signal and is never
persisted or returned.

If AI fails while correcting an existing pending review, include that
`transactionId` in the same failure payload. Core API binds the transaction,
user, Gmail message, and pending import before recording body-free failure
diagnostics. The existing candidate remains pending and can be retried; a
cross-email or already-terminal transaction is rejected.

When AI explicitly classifies the email as a non-transaction, n8n submits the same identity and email metadata with no candidate, resolution, or proposal:

```json
{
  "telegramUserId": "976684739",
  "reviewToken": "gmail-message-id",
  "isTransaction": false,
  "email": {
    "messageId": "gmail-message-id",
    "from": "card@bca.co.id",
    "subject": "Monthly card newsletter",
    "emailText": "normalized plain-text body"
  }
}
```

Core API returns `status: "ignored_non_transaction"` with `reason: "ai_non_transaction"`, records only a body-free decision in the existing import diagnostics, and creates no transaction or template. Repeating the same submission is idempotent. A failed AI attempt with no transaction remains retryable: a repeated Gmail delivery resumes the same `needs_ai` handoff.

This endpoint owns only validation and pending review persistence. Initial fallback prompting/invocation is owned by `email/handle`; Gmail triggers, Gmail refetching, correction prompting/invocation, correction collection, Telegram sends, retries, and callback routing stay in n8n. Do not alter or activate a production n8n workflow as part of this API change.

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
          "text": "Save",
          "callback_data": "save_transaction:transaction-id"
        },
        {
          "text": "Change Category",
          "callback_data": "change_categories:transaction-id"
        }
      ],
      [
        {
          "text": "Cancel",
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

Approves one production pending transaction. Core API finds the matching `transactions` row by `transactionId` and `userId`, then updates `status` from `pending` to `confirmed` and refreshes `updated_at`. Email expenses resolve their category and explicit `pocketId` (or the user's default pocket) before that atomic transition.

Confirming an email expense with
`raw_payload.parsed.paymentType = "Credit Card"` atomically adds its amount to
the user's transaction-date financial cycle. A confirmed credit-card reversal
subtracts from its reversal-date cycle without reducing usage below zero.
Existing n8n request payloads do not change.

This endpoint does not edit or delete transactions, does not handle Telegram callbacks directly, and does not send Telegram messages.

Confirmed updates run the transaction watchdog after the status update succeeds. `notifications` is ordered as `risk_review`, `budget_alert`, then `burn_rate` when present; it is an empty array when no alert/review is created or watchdog evaluation fails. Cancel/reject flows skip the watchdog.

Example request body:

```json
{
  "transactionId": "transaction-id",
  "userId": "example-user-id",
  "pocketId": "optional-pocket-id"
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
  },
  "notifications": [],
  "watchdog": {
    "checked": true,
    "hasAlert": false,
    "alerts": []
  }
}
```

If an email expense has no resolvable default, `status` is `awaiting_pocket` and `pockets` contains the active choices; it remains pending. Unknown categories are saved as `Uncategorized` for review independently of budgets. If the transaction row is missing, `status` is `not_found`. If it is already confirmed, `status` is `already_confirmed`. If it is already rejected, `status` is `already_rejected`.

Gmail triggers, review buttons, callback routing, and Telegram delivery remain in n8n; this endpoint only receives the optional `pocketId` in its HTTP Request body.

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

### `POST /api/veyra/transactions/callback/handle`

Routes one Telegram transaction callback through Core API. `veyra_tx_manage:*` callback data is normalized and passed to `/transactions/manage/handle`; all other supported transaction callback data keeps the existing Telegram `editMessageText` response behavior.

Supported callback data:

```txt
save_transaction:{transactionId}
cancel_transaction:{transactionId}
change_categories:{transactionId}
catid:{categoryId}:{transactionId}
veyra_risk:{reviewId}:planned
veyra_risk:{reviewId}:necessary
veyra_risk:{reviewId}:regret
veyra_risk:{reviewId}:ignore
veyra_tx_manage:select:{index}
veyra_tx_manage:confirm
veyra_tx_manage:cancel
```

Example request body:

```json
{
  "telegramUserId": "976684739",
  "userId": 1,
  "callbackData": "catid:10:123",
  "chatId": "123456789",
  "messageId": 42
}
```

Example response:

```json
{
  "status": "ok",
  "action": "catid",
  "transactionId": 123,
  "telegram": {
    "method": "editMessageText",
    "chat_id": "123456789",
    "message_id": 42,
    "text": "Transaction 123 confirmed: GoPay 50000",
    "parse_mode": "HTML",
    "reply_markup": null
  }
}
```

For `change_categories:{transactionId}`, `telegram.reply_markup` contains `inline_keyboard` buttons using `catid:{categoryId}:{transactionId}`. Core validates that the active category belongs to the user. Confirmed transactions are reclassified without changing status or pocket, then Watchdog is reevaluated. n8n keeps routing callback prefixes and sending Telegram edits unchanged. For `veyra_risk:{reviewId}:{response}`, Core API validates ownership, requires a pending `large_transaction` review, stores `user_response` as `planned`, `necessary`, `regret`, or `ignore`, sets `status = "resolved"`, clears the inline keyboard, and returns Telegram-safe text. Duplicate risk callbacks return `This transaction review was already answered.` and do not overwrite the first response. Unknown or invalid callback data returns `status: "error"` and safe user-facing `telegram.text`.

For a successful `save_transaction:{transactionId}`, Core runs Watchdog and
keeps the existing aggregated confirmation text. When Watchdog returns a
pending `risk_review`, `telegram.reply_markup` contains that review's existing
`planned`, `necessary`, `regret`, and `ignore` keyboard; otherwise it is null.
n8n should pass this field through unchanged when editing the original
confirmation message. Clicking a risk action replaces the combined message
with the existing acknowledgement or regret-note prompt and removes the
keyboard.

Manage callback example:

```json
{
  "telegramUserId": "123456789",
  "callbackData": "veyra_tx_manage:select:1",
  "chatId": "123456789",
  "messageId": 42
}
```

Manage callback response:

```json
{
  "status": "ok",
  "action": "veyra_tx_manage",
  "transactionId": 163,
  "telegram": {
    "method": "editMessageText",
    "chat_id": "123456789",
    "message_id": 42,
    "text": "Confirm edit?\n\nBefore:\nFamily Mart — Food — Rp16.000\n\nAfter:\nUnknown — food — Rp16.000",
    "parse_mode": "HTML",
    "reply_markup": {
      "inline_keyboard": [
        [
          {
            "text": "Confirm",
            "callback_data": "veyra_tx_manage:confirm"
          },
          {
            "text": "Cancel",
            "callback_data": "veyra_tx_manage:cancel"
          }
        ]
      ]
    }
  }
}
```

Transaction ids are not stored in `veyra_tx_manage:*` callback data. Selection and confirmation are validated from `conversation_states.state_data`: selection indexes map to stored `candidates`, and confirmation uses the stored `transaction_id`. Stale or repeated callbacks return an invalid response without mutating transactions.

Recommended n8n callback flow:

```txt
Telegram Callback Query Trigger
  -> HTTP Request
     Method: POST
     URL: http://core-api:3001/api/veyra/transactions/callback/handle
     Body:
     {
       "telegramUserId": "={{$json.callback_query.from.id}}",
       "userId": "={{$json.user_id}}",
       "callbackData": "={{$json.callback_query.data}}",
       "chatId": "={{$json.callback_query.message.chat.id}}",
       "messageId": "={{$json.callback_query.message.message_id}}"
     }
  -> Telegram Edit Message Text
     Method = {{$json.telegram.method}}
     Chat ID = {{$json.telegram.chat_id}}
     Message ID = {{$json.telegram.message_id}}
     Text = {{$json.telegram.text}}
     Parse Mode = {{$json.telegram.parse_mode}}
     Reply Markup = {{$json.telegram.reply_markup}}
```

This replaces only the transaction callback parsing/routing and per-branch HTTP Request mapping in n8n. Keep Telegram Callback Query triggers, Telegram edit/send execution, callback answer nodes, overspend orchestration, and credentials in n8n.

### Large Transaction / Regret Detector v1

The transaction Watchdog evaluates confirmed expense transactions after create, confirm, category confirmation, email review confirmation, and managed edits. It skips pending, rejected, non-expense, missing, and zero-value transactions. Core API is deterministic and does not call an LLM; n8n only forwards callback data and sends/edits Telegram messages.

Scoring defaults:

```txt
+40 amount >= 20% of active parent or total monthly budget
+30 amount >= 3x the 90-day median confirmed expense, with at least 5 history rows
+25 transaction causally crosses category or parent budget over 100%
+20 shared Watchdog burn-rate projection exceeds active parent/total budget
+10 normalized merchant has fewer than 3 prior confirmed expense rows in 90 days
```

Scores cap at `100`. Levels are `low` (`0-29`), `medium` (`30-49`), `high` (`50-69`), and `critical` (`70-100`). Only high and critical reviews notify the user. Low and medium evaluations are persisted as resolved for audit/idempotency but add no Telegram section.

Persistence uses `transaction_risk_reviews` with `risk_type = "large_transaction"`, structured `risk_reasons`, structured `risk_metrics`, and `risk_metrics.evaluationFingerprint`. The fingerprint includes evaluator version `large_transaction_v1`, transaction id, amount, category, normalized merchant, transaction date, status, and transaction type. Re-running Watchdog for the same fingerprint reuses the stored review and does not notify again. A material transaction edit cancels stale pending reviews and stores a new evaluation; resolved historical responses are preserved.

Watchdog aggregation returns one response. If budget alert, burn-rate warning, and large-transaction risk all trigger, the transaction response appends the Telegram-safe sections into one message and exposes ordered `notifications` (`risk_review`, `budget_alert`, `burn_rate`).

For duplicate-free n8n delivery, use the unaggregated `baseMessage` first and
then send each `notifications` item in the returned order. The manual
`POST /api/veyra/transactions/handle` response exposes these as
`data.baseMessage` and `data.notifications`; the email
`POST /api/veyra/transactions/email/handle` response exposes top-level
`baseMessage` and `notifications`. Map `notification.message` directly as HTML
text and pass `notification.reply_markup` through unchanged when present. Do
not sort notifications or recover the base message by parsing the legacy
aggregated `message` or `telegram.text` fields; those fields remain for
rollback compatibility.

Example pending high-risk review:

```json
{
  "type": "risk_review",
  "priority": 1,
  "severity": "high",
  "review_id": 42,
  "message": "<b>⚠️ Large transaction detected</b>\n\nRp1.850.000 at Electronic City\n• 23.1% of your monthly budget\n• 4.2x larger than your recent median\n• This pushed Shopping over budget\n\nWas this purchase planned?",
  "reply_markup": {
    "inline_keyboard": [
      [
        { "text": "Planned", "callback_data": "veyra_risk:42:planned" },
        { "text": "Necessary", "callback_data": "veyra_risk:42:necessary" }
      ],
      [
        { "text": "Regret it", "callback_data": "veyra_risk:42:regret" },
        { "text": "Ignore", "callback_data": "veyra_risk:42:ignore" }
      ]
    ]
  }
}
```

Risk callback example:

```json
{
  "telegramUserId": "976684739",
  "userId": 1,
  "callbackData": "veyra_risk:42:regret"
}
```

Risk callback response:

```json
{
  "status": "ok",
  "action": "veyra_risk",
  "transactionId": 123,
  "telegram": {
    "method": "editMessageText",
    "text": "What note should I add?",
    "parse_mode": "HTML",
    "reply_markup": null
  }
}
```

The `regret` callback enters `veyra_regret_note` state and leaves the review
pending. Route the user's next Telegram text through the existing `record`
message path; Core API adds that note to the transaction and then resolves the
review as `regret`.

This replaces only deterministic large-transaction risk evaluation, review storage, and callback resolution. Keep Telegram triggers, callback answering, Telegram sending/editing, credentials, retries, and workflow orchestration in n8n.

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
burn_rate_forecast
help, greeting, unknown
```

### `POST /api/veyra/conversational/handle`

Handles structured analytics results from the n8n Master Intent Classifier. Core API resolves the user, resolves the period from `telegram_users.cycle_start_day`, queries PostgreSQL, calculates deterministic facts, and returns either a Telegram-ready message or an `insight_payload` for n8n's Insight LLM. Core API does not call any LLM.

Example n8n HTTP Request body:

```json
{
  "telegramUserId": "976684739",
  "userId": 1,
  "text": "how my spending looked like this week?",
  "timezone": "Asia/Jakarta",
  "statePayload": {},
  "llmResult": {
    "intent": "spending_summary",
    "period": "this_week",
    "comparisonPeriod": null,
    "merchant": null,
    "category": null,
    "limit": null,
    "target": null,
    "needs_insight": false,
    "confidence": 0.91
  }
}
```

Response shape:

```json
{
  "ok": true,
  "status": "ok",
  "intent": "spending_summary",
  "message": {
    "text": "Spending: <b>Rp1.250.000</b> from 8 transactions.",
    "parse_mode": "HTML",
    "disable_web_page_preview": true,
    "reply_markup": null
  },
  "data": {},
  "insight_payload": null
}
```

Supported MVP intents: `spending_summary`, `category_spending`, `merchant_spending`, `top_merchants`, `top_categories`, `largest_transactions`, `recent_transactions`, `transaction_count`, `spending_by_day`, `daily_average_spending`, `spending_trend`, `cashflow_summary`, `burn_rate_forecast`, `daily_spending_review`, `weekly_spending_review`.

Unsupported for now returns `status: "unsupported_intent"`: `subscription_summary`, `subscription_detail`, `spending_comparison`, `merchant_comparison`, `category_comparison`, `weekday_analysis`, `most_frequent_merchant`, `unknown`.

When `status` is `needs_insight`, n8n should send `insight_payload` to the Insight LLM, then send the LLM result through Telegram Reliable Sender. Otherwise send `message` directly. Keep Telegram trigger, Master Intent Classifier LLM, optional Insight LLM, reliable Telegram sender, and workflow orchestration in n8n.

`burn_rate_forecast` is deterministic and returns a Telegram-ready HTML message from Core API. It counts only confirmed expense transactions in the user's current cycle from `telegram_users.cycle_start_day`; pending, rejected, deleted, income, transfer, and reversal rows are ignored by the existing analytics queries. When `category` is null, Core API compares total spending against the sum of active top-level budgets; parent budgets use active child budget amounts and child category spending. n8n should classify the intent, pass any explicit `category`, then send `message` directly.

Scheduled spending reviews use the same endpoint. n8n keeps the Schedule Trigger, optional weekly Insight LLM, Telegram Reliable Sender, credentials, and workflow orchestration. Core API replaces the n8n SQL and deterministic text-formatting nodes.

Daily scheduled request:

```json
{
  "telegramUserId": "976684739",
  "userId": 1,
  "timezone": "Asia/Jakarta",
  "text": "daily spending review",
  "llmResult": {
    "intent": "daily_spending_review",
    "period": "today",
    "needs_insight": false
  }
}
```

Daily returns `status: "ok"` with `message.text` ready for Telegram. Core API does not request or call an LLM for this intent.

Weekly scheduled request:

```json
{
  "telegramUserId": "976684739",
  "userId": 1,
  "timezone": "Asia/Jakarta",
  "text": "weekly spending review",
  "llmResult": {
    "intent": "weekly_spending_review",
    "period": "this_week",
    "comparisonPeriod": "last_week",
    "needs_insight": true
  }
}
```

Weekly returns `status: "needs_insight"` when there is spending data. `message.text` contains deterministic total/category/merchant sections, while `insight_payload.facts` contains the week comparison, weekday/weekend split, top categories, and top merchants for n8n's Insight LLM to produce only the `Insights` and `Veyra's Verdict` sections.

Example burn-rate request:

```json
{
  "telegramUserId": "976684739",
  "userId": 1,
  "text": "will my food budget run out?",
  "timezone": "Asia/Jakarta",
  "statePayload": {},
  "llmResult": {
    "intent": "burn_rate_forecast",
    "period": "this_month",
    "category": "Food",
    "merchant": null,
    "limit": null,
    "target": {},
    "confidence": 0.91
  }
}
```

Example burn-rate response:

```json
{
  "ok": true,
  "status": "ok",
  "intent": "burn_rate_forecast",
  "message": {
    "text": "<b>Food burn-rate forecast</b>\n• Spent: Rp400.000 of Rp1.000.000.\n• Burn rate: Rp40.000/day. Safe daily spend left: Rp30.000/day.\n• Projected spend: Rp900.000. Still under budget. Barely acceptable.",
    "parse_mode": "HTML",
    "disable_web_page_preview": true,
    "reply_markup": null
  },
  "data": {
    "cycleStart": "2026-06-25",
    "cycleEnd": "2026-07-25",
    "elapsedDays": 10,
    "daysLeft": 20,
    "totalCycleDays": 30,
    "category": "Food",
    "spentSoFar": 400000,
    "averageDailySpend": 40000,
    "projectedCycleSpend": 900000,
    "budgetLimit": 1000000,
    "remainingBudget": 600000,
    "safeDailySpend": 30000,
    "projectedOverrun": 0,
    "projectedRemaining": 100000,
    "exhaustionDate": "2026-07-20",
    "status": "safe"
  },
  "insight_payload": null
}
```

Insight LLM prompt:

```txt
You are Veyra, a strict personal finance assistant.

Create a short spending insight from the facts below.
Use only the provided facts. Do not invent transactions, merchants, or categories.

Rules:

* Max 3 bullets.
* Mention whether spending is improving, worsening, stable, concentrated, or unusual.
* Be direct and slightly strict.
* Use Indonesian Rupiah formatting.
* No markdown table.
* Return Telegram-safe HTML only.

Facts:
{{ JSON.stringify($json.insight_payload) }}
```

Curl examples:

```bash
curl -X POST "$CORE_API_URL/api/veyra/conversational/handle" \
  -H "content-type: application/json" \
  -H "x-core-api-key: $CORE_API_KEY" \
  -d '{"telegramUserId":"976684739","text":"how my spending looked like this week?","timezone":"Asia/Jakarta","llmResult":{"intent":"spending_summary","period":"this_week","needs_insight":false}}'

curl -X POST "$CORE_API_URL/api/veyra/conversational/handle" \
  -H "content-type: application/json" \
  -H "x-core-api-key: $CORE_API_KEY" \
  -d '{"telegramUserId":"976684739","timezone":"Asia/Jakarta","llmResult":{"intent":"top_categories","period":"current_cycle","limit":5,"needs_insight":false}}'

curl -X POST "$CORE_API_URL/api/veyra/conversational/handle" \
  -H "content-type: application/json" \
  -H "x-core-api-key: $CORE_API_KEY" \
  -d '{"telegramUserId":"976684739","text":"how is my spending trend now?","timezone":"Asia/Jakarta","llmResult":{"intent":"spending_trend","period":"current_cycle","comparisonPeriod":"previous_cycle","needs_insight":true}}'

curl -X POST "$CORE_API_URL/api/veyra/conversational/handle" \
  -H "content-type: application/json" \
  -H "x-core-api-key: $CORE_API_KEY" \
  -d '{"telegramUserId":"976684739","timezone":"Asia/Jakarta","llmResult":{"intent":"daily_average_spending","period":"current_cycle"}}'

curl -X POST "$CORE_API_URL/api/veyra/conversational/handle" \
  -H "content-type: application/json" \
  -H "x-core-api-key: $CORE_API_KEY" \
  -d '{"telegramUserId":"976684739","timezone":"Asia/Jakarta","llmResult":{"intent":"cashflow_summary","period":"current_cycle"}}'

curl -X POST "$CORE_API_URL/api/veyra/conversational/handle" \
  -H "content-type: application/json" \
  -H "x-core-api-key: $CORE_API_KEY" \
  -d '{"telegramUserId":"976684739","timezone":"Asia/Jakarta","text":"will my food budget run out?","llmResult":{"intent":"burn_rate_forecast","period":"this_month","category":"Food"}}'

curl -X POST "$CORE_API_URL/api/veyra/conversational/handle" \
  -H "content-type: application/json" \
  -H "x-core-api-key: $CORE_API_KEY" \
  -d '{"telegramUserId":"976684739","llmResult":{"intent":"category_spending","period":"current_cycle","category":"Food","needs_insight":true}}'

curl -X POST "$CORE_API_URL/api/veyra/conversational/handle" \
  -H "content-type: application/json" \
  -H "x-core-api-key: $CORE_API_KEY" \
  -d '{"telegramUserId":"976684739","llmResult":{"intent":"category_spending","period":"current_cycle"}}'

curl -X POST "$CORE_API_URL/api/veyra/conversational/handle" \
  -H "content-type: application/json" \
  -H "x-core-api-key: $CORE_API_KEY" \
  -d '{"telegramUserId":"976684739","llmResult":{"intent":"subscription_summary","period":"current_cycle"}}'
```

### `POST /api/veyra/transactions/category-options`

Builds Telegram-ready category selection text and inline keyboard buttons for a transaction category callback. This endpoint reads the production `transactions` row for ownership and active user categories for options; it does not update, confirm, insert, or send Telegram messages.

Production-compatible category callbacks use `catid:{categoryId}:{transactionId}` for active user categories. Category IDs are ownership-validated on selection; category and pocket assignment are independent. `callbackMode: "experimental"` keeps the old `tx_set_category:{pendingTransactionId}:{categorySlug}` draft format.

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
          "callback_data": "catid:food-category-id:transaction-id"
        }
      ],
      [
        {
          "text": "Health & Beauty",
          "callback_data": "catid:health-category-id:transaction-id"
        }
      ]
    ]
  }
}
```

If the transaction row is missing, `status` is `not_found`. If a legacy pending row is supplied and already resolved, `status` is `already_resolved`.

### `POST /api/veyra/transactions/set-category`

Updates the selected production transaction category and returns Telegram edit-message data. The category id must belong to the same user and be active. Confirmed rows change category only; pending rows are atomically confirmed with their resolved or retained pocket.

Category confirmation runs the transaction watchdog after the category/status update succeeds because category changes can affect both budget impact and risk evaluation.

Example request body:

```json
{
  "transactionId": "transaction-id",
  "categoryId": "food-category-id",
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
  },
  "notifications": []
}
```

If the transaction row is missing, `status` is `not_found`. If the category does not belong to the user's active category catalog, `status` is `unauthorized_category`.

## How n8n Should Call This API

Use an HTTP Request node after the existing n8n trigger or after the Code node that currently builds the alert/message payload.

Recommended Aegis pilot node settings:

```txt
Method: POST
URL: http://core-api:3001/api/aegis/n8n-error
Send Body: JSON
Body: pass the raw n8n Error Trigger payload, or map workflow, execution, and error fields from the trigger item
```

The body may be the raw trigger object, the current flattened mapped object, or a one-item array containing the raw trigger object. If an HTTP Request node failed, Core API reads `execution.error.errorResponse` and returns a compact Telegram-safe incident summary. n8n should send the returned payload as-is through the existing Telegram sender.

If `CORE_API_KEY` is set in the Core API environment, add this HTTP header in n8n:

```txt
x-core-api-key: <value stored in n8n credentials or environment>
```

Then keep the existing reliable sender workflow and map the Core API response directly:

```txt
chat_id = {{$json.chat_id}}
text = {{$json.text}}
parse_mode = {{$json.parse_mode}}
reply_markup = {{$json.reply_markup}}
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

Recommended Veyra budget categories node settings:

```txt
Method: POST
URL: http://core-api:3001/api/veyra/budgets/categories
Send Body: JSON
Body:
{
  "userId": "={{$json.user_id}}"
}
```

Use `categories` as the active budget list with parent category labels already attached. This replaces only the n8n budget category list SQL; keep Telegram triggers, callback routing, Telegram sending, credentials, retries, and workflow orchestration in n8n.

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

Recommended Veyra overspending handle node settings:

```txt
Method: POST
URL: http://core-api:3001/api/veyra/budgets/overspending/handle
Send Body: JSON
Body:
{
  "userId": "={{$json.user_id}}",
  "category": "={{$json.category}}",
  "transactionId": "={{$json.transaction_id}}",
  "asOfDate": "={{$json.transaction_date}}"
}
```

When `status` is `alert_required`, send `message.text`, `message.parse_mode`, and `message.disable_web_page_preview` through Telegram Reliable Sender. After Telegram success, call the record endpoint with `data.alertRecord`:

```txt
Method: POST
URL: http://core-api:3001/api/veyra/budgets/overspending/record
Send Body: JSON
Body:
{
  "userId": "={{$json.data.alertRecord.userId}}",
  "budgetId": "={{$json.data.alertRecord.budgetId}}",
  "alertType": "={{$json.data.alertRecord.alertType}}",
  "thresholdPercent": "={{$json.data.alertRecord.thresholdPercent}}",
  "periodKey": "={{$json.data.alertRecord.periodKey}}"
}
```

If Telegram delivery fails, do not call `record`. This replaces only the direct-category spending, threshold, duplicate-check, alert text calculation, and durable delivered-alert recording; keep scheduling, transaction triggers, Telegram sending, delivery retry, and orchestration in n8n.

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

Use this after the existing manual transaction LLM parser. If the parser returns `missing_fields`, Core API persists `record_transaction_state`; n8n should send `data.message` to Telegram as the follow-up question and route the next message back through the record flow. Merchant and category are optional for income: n8n should not report them as missing, and Core API ignores those two entries if they are present in an income `missing_fields` array. If the user sends cancel/reset text while in transaction state, n8n can call this same endpoint with `source: "manual"` and `text`; Core API returns `data.status = "cancelled"` and clears the conversation state without inserting. For `data.status = "confirmed"`, send `data.message` to Telegram. For `data.status = "pending"`, send `data.confirmationPayload.text` with `data.confirmationPayload.reply_markup`; the buttons use the existing production callbacks `save_transaction:{transactionId}`, `cancel_transaction:{transactionId}`, and `change_categories:{transactionId}`. This replaces only the manual transaction normalize/insert/confirmation decision logic. Keep Telegram triggers, LLM parsing, Telegram sending, callback routing, email transaction handling, and credentials in n8n for now.

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
Save = save_transaction:{transactionId}
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
  -> parse callback_data catid:{categoryId}:{transactionId}
  -> HTTP Request
     Method: POST
     URL: http://core-api:3001/api/veyra/transactions/set-category
     Body:
     {
       "transactionId": "={{$json.transactionId}}",
      "categoryId": "={{$json.categoryId}}",
       "userId": "={{$json.user_id}}"
     }
  -> Telegram Edit Message Text or Telegram Send Message
```

Map the refreshed confirmation message from the HTTP response:

```txt
Telegram text = {{$json.editMessage.text}}
Parse mode = {{$json.editMessage.parseMode}}
```

This replaces category lookup, category button formatting, and the transaction category update. Keep callback routing, Telegram answering/sending, overspend orchestration after successful selection, rejection, and edit-transaction flows in n8n for now.

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

Overspending handle test:

```bash
curl -X POST http://localhost:3001/api/veyra/budgets/overspending/handle \
  -H 'content-type: application/json' \
  -d '{"userId":"example-user-id","category":"Food","transactionId":123,"asOfDate":"2026-06-25"}'
```

Overspending record test:

```bash
curl -X POST http://localhost:3001/api/veyra/budgets/overspending/record \
  -H 'content-type: application/json' \
  -d '{"userId":"example-user-id","budgetId":"example-budget-id","alertType":"overspend_80","periodKey":"2026-06-25"}'
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
  -d '{"transactionId":"transaction-1","categoryId":"food-category-id","userId":"example-user-id"}'
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
