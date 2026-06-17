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
    intent/
      Conversational intent detection and routing helpers.
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

Formats a raw n8n Error Trigger payload into a Telegram-ready alert message. n8n should still send the returned text to Telegram.

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
  "chatText": "Aegis ERROR alert\nWorkflow: Error Watchdog (example-workflow-id)\nError: Request timed out\nNode: HTTP Request\nExecution: example-execution-id\nURL: https://n8n.example.com/execution/example-execution-id\nWhen: 2026-06-17T10:00:00.000Z",
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

### `POST /api/veyra/budgets/status`

Looks up one existing budget and calculates current-cycle spending. The cycle uses `telegram_users.cycle_start_day`; spending includes only confirmed expense transactions where `transaction_date >= cycle_start` and `transaction_date < cycle_end`.

Example request body:

```json
{
  "telegramUserId": "example-telegram-user-id",
  "category": "Food",
  "asOfDate": "2026-06-17"
}
```

`userId` may be used instead of `telegramUserId` when n8n already has the internal `telegram_users.id`. `asOfDate` is optional and defaults to the current date.

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
  "cycle_start": "2026-06-15",
  "cycle_end": "2026-07-15"
}
```

### `POST /api/veyra/budgets/upsert`

Creates or updates one budget by the existing `(user_id, category)` uniqueness rule. `periodType` defaults to `monthly`; other period types are rejected until the database behavior is reviewed.

If `parentCategory` is provided, Core API resolves an existing parent budget for the same user and stores its `id` as `parent_budget_id`. If `parentCategory` is omitted, new budgets are created with `parent_budget_id = null`; existing budgets keep their current `parent_budget_id` during amount-only updates.

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

Then keep the existing Telegram node or reliable sender workflow and map:

```txt
Telegram text = {{$json.chatText}}
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

Map downstream n8n fields from the response:

```txt
Budget amount = {{$json.budget_amount}}
Spent amount = {{$json.spent_amount}}
Remaining amount = {{$json.remaining_amount}}
Spent percent = {{$json.spent_percent}}
Cycle start = {{$json.cycle_start}}
Cycle end = {{$json.cycle_end}}
```

This replaces only the n8n budget lookup/status calculation logic. Keep Telegram triggers, intent routing, callback routing, message sending, budget create/update/delete behavior, and workflow orchestration in n8n for now.

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
