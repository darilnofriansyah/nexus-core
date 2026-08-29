# Rovelle Runware generation submission

Phase 3A submits one Clovervale shot from Core directly to Runware Seedance
2.5. Core returns after Runware accepts the asynchronous task; it does not
poll for a completed video.

Raw REST is deliberate. The Runware SDK `.run()` path polls async
work to a terminal state, which would make a submission request own
completion. Phase 3A instead sends one documented REST enqueue request with
native `fetch`. Completion belongs to Phase 3B.

## Ownership and boundary

```text
n8n HTTP Request -> Core preflight/persistence -> Runware REST enqueue
                                      |                 |
                                      +-> private R2 <-+
```

Core owns Rovelle state, attempt history, and private R2 URL creation. n8n
may call the Core endpoints, but keeps triggers, schedules, notifications,
Telegram delivery, and simple orchestration. It must not write Rovelle tables
or call Runware directly.

Phase 3A creates a durable attempt and a `RESERVED` `GENERATION`
`video/mp4` asset, then stops at `SUBMITTED`. It has no webhook endpoint or
authentication exception, polling, output confirmation, actual-cost update,
`COMPLETED`, `AVAILABLE`, or `REVIEW_REQUIRED` behavior. Those are Phase 3B.

## Core API

All routes are under `/api`, use the existing `x-core-api-key` guard when
`CORE_API_KEY` is configured, and return `{ "ok": true, "data": ... }` on
success.

| Method | Endpoint | Purpose |
| --- | --- | --- |
| POST | `/api/rovelle/shots/:shotId/generations` | Submit or replay one idempotent shot generation |
| GET | `/api/rovelle/shots/:shotId/generations` | List attempts by attempt number |
| GET | `/api/rovelle/generations/:generationId` | Read one attempt |

n8n HTTP Request node for submission:

```text
Header: x-core-api-key: <CORE_API_KEY>
Header: Content-Type: application/json
```

```json
{
  "requestId": "550e8400-e29b-41d4-a716-446655440000",
  "profile": "DRAFT"
}
```

`requestId` is a client UUID idempotency key. Retrying the same key returns
the original attempt and never submits a second paid provider task or reserves
a second output asset. Core creates and persists the provider task UUID before
the external call. Attempt records are historical/immutable: submission only
advances their status or records normalized provider failure information.

## Preconditions and prompt

The requested shot must be `READY_TO_GENERATE`; its episode may be
`READY_TO_GENERATE` or already `GENERATING`. Core resolves effective canon
(episode pins plus shot overrides) before spending. It requires locked
`CHARACTER`, `ENVIRONMENT`, and `STYLE` versions. Every selected reference
must be an `AVAILABLE` `image/*` asset, with no more than 30 total.

Core compiles canon and shot direction deterministically. The prompt is
limited to 10,000 characters and rejects URL-looking content. Reference order
is deterministic. On provider acceptance Core atomically moves the shot to
`GENERATING`; it moves the episode on its first accepted generation. Other
ready shots may then submit while that episode is `GENERATING`.

## Profiles and price estimate

| Profile | Dimensions | Fixed estimate |
| --- | --- | --- |
| `DRAFT` | 480x854 | USD 0.115/second |
| `PRODUCTION` | 720x1280 | USD 0.249/second |

Duration comes from the shot and must be an integer from 4 through 30 seconds.
Core stores the estimate as an exact six-decimal value with pricing source;
audio is always disabled.

## Private R2 transfer

Core creates short-lived presigned GET URLs in memory for canon references.
It also creates a provider-owned presigned PUT URL in memory for the reserved
output asset. That PUT signature deliberately has no required `Content-Type`,
so Runware can upload its MP4 response.

Presigned reference URLs, output URLs, authorization values, and
`RUNWARE_API_KEY` are never stored in `request_json`, returned by the
generation API, or logged. Durable request data contains only profile,
dimensions, duration, reference asset IDs, and canon version identifiers.

## Failures and smoke boundary

A normalized Runware rejection remains a durable `SUBMISSION_FAILED` attempt;
the shot and episode remain unchanged. An accepted submission that cannot be
persisted is returned as an internal error with only the generation ID, never
retried automatically.

Automated tests use fake Runware and R2 implementations and spend no credits.
A real smoke is separate: it needs explicit approval for one DRAFT, 4-second
submission (documented estimate USD 0.460000), configured private R2 and
Runware key, and a real ready shot with required locked canon. Do not run it
until that approval is given.
