# Rovelle Production Backbone API

## Ownership and lifecycle

Core owns Rovelle episode and shot state. n8n may call these API endpoints for
Telegram, schedules, notifications, or integration work, but it must not
mutate Rovelle tables directly.

The Phase 1 episode lifecycle is:

```text
DRAFT
-> BRIEF_APPROVED
-> PREPRODUCTION
-> READY_TO_GENERATE
```

`GENERATING` exists in the database enum for a later Runware phase, but is not
reachable by this API or any current domain command.

All routes are protected by the existing Core API-key guard when
`CORE_API_KEY` is configured. Send `x-core-api-key` from an n8n HTTP Request
node. Successful responses use the shared shape:

```json
{
  "ok": true,
  "data": {}
}
```

## Endpoints

### Create an episode

`POST /api/rovelle/episodes`

```json
{
  "code": "EP-001",
  "title": "Koko Counts the Berries",
  "targetDurationSeconds": 30
}
```

### Get an episode aggregate

`GET /api/rovelle/episodes/:id`

Returns the episode and its shots ordered by `sequence`.

### Update a draft brief

`PUT /api/rovelle/episodes/:id/brief`

```json
{
  "brief": {
    "premise": "Koko learns to count berries one at a time.",
    "learningGoal": "Counting 1-5",
    "tone": "playful",
    "format": "nursery jingle short"
  }
}
```

Brief edits are allowed only while the episode is `DRAFT`.

### Approve a brief

`POST /api/rovelle/episodes/:id/approve-brief`

Requires a non-empty brief and transitions `DRAFT` to `BRIEF_APPROVED`.

### Start preproduction

`POST /api/rovelle/episodes/:id/start-preproduction`

Transitions `BRIEF_APPROVED` to `PREPRODUCTION`.

### Replace preproduction shots

`PUT /api/rovelle/episodes/:id/shots`

```json
{
  "shots": [
    {
      "sequence": 1,
      "name": "Berry Patch Arrival",
      "direction": "Koko enters the berry patch carrying his basket.",
      "targetDurationSeconds": 5
    },
    {
      "sequence": 2,
      "name": "Count One",
      "direction": "Koko picks the first berry and clearly presents it.",
      "targetDurationSeconds": 5
    }
  ]
}
```

Shot replacement is permitted only while the episode is `PREPRODUCTION` and
replaces the ordered set atomically. An empty set is allowed during
preproduction.

### Mark ready to generate

`POST /api/rovelle/episodes/:id/mark-ready`

Requires at least one shot. It atomically changes every current shot and the
episode to `READY_TO_GENERATE`.

## n8n HTTP Request payloads

Use the endpoint method and JSON body shown above. An n8n HTTP Request node
should send:

```text
Header: x-core-api-key: <CORE_API_KEY>
Header: Content-Type: application/json
```

n8n remains responsible for triggers, scheduling, Telegram delivery, and
simple orchestration. Core remains the only writer of Rovelle production
state.
