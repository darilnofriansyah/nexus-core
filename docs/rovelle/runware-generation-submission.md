# Rovelle Runware generation submission

Phase 3A submits one Clovervale shot from Core directly to Runware Vidu 2.0.
Core returns after Runware accepts the asynchronous task; it does not
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

| Method | Endpoint                                 | Purpose                                         |
| ------ | ---------------------------------------- | ----------------------------------------------- |
| POST   | `/api/rovelle/shots/:shotId/generations` | Submit or replay one idempotent shot generation |
| GET    | `/api/rovelle/shots/:shotId/generations` | List attempts by attempt number                 |
| GET    | `/api/rovelle/generations/:generationId` | Read one attempt                                |

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

## Human generation review

`POST /api/rovelle/generations/:generationId/reviews` appends one human review
or replays the same `requestId`. Reusing a request ID for another generation
returns `409`. The endpoint uses the global Core API-key guard; n8n sends:

```text
Header: x-core-api-key: <CORE_API_KEY>
Header: Content-Type: application/json
```

```json
{
  "requestId": "550e8400-e29b-41d4-a716-446655440000",
  "decision": "APPROVE",
  "notes": "Approved for render."
}
```

Only a `COMPLETED` generation with an `AVAILABLE` `GENERATION` `video/*`
output can be reviewed. `APPROVE` points the shot to that generation and marks
the shot `APPROVED` (a later approval may replace that pointer); `REJECT` only
appends the audit row; `REGENERATE` clears
the selected generation and returns that shot to `READY_TO_GENERATE`. n8n keeps
provider submission separate: this endpoint never calls the generation provider.

The requested shot must be `READY_TO_GENERATE`; its episode may be
`READY_TO_GENERATE` or already `GENERATING`. Core resolves effective canon
(episode pins plus shot overrides) before spending. It requires locked
`CHARACTER`, `ENVIRONMENT`, and `STYLE` versions. Every selected reference
must be an `AVAILABLE` `image/*` asset. Vidu 2 accepts one through three
references per generation.

The canon registry retains every locked attachment. For Vidu submission, Core
selects the first sorted asset from each canon type, yielding at most one
`CHARACTER`, `ENVIRONMENT`, and `STYLE` reference.

Core compiles canon and shot direction deterministically. The prompt is
limited to 10,000 characters and rejects URL-looking content. Reference order
is deterministic. On provider acceptance Core atomically moves the shot to
`GENERATING`; it moves the episode on its first accepted generation. Other
ready shots may then submit while that episode is `GENERATING`.

## Profiles and price estimate

| Profile | Dimensions | Fixed estimate   |
| ------- | ---------- | ---------------- |
| `DRAFT` | 1280x720   | USD 0.055/second |

Vidu 2 reference-image generations use exactly one 4-second duration and one
through three reference images. Core stores the estimate as an exact
six-decimal value with pricing source.

## Private R2 transfer

Core creates short-lived presigned GET URLs in memory for canon references.
It also creates a provider-owned presigned PUT URL in memory for the reserved
output asset. That PUT signature deliberately has no required `Content-Type`,
so Runware can upload its MP4 response. If that direct upload is absent when
the authenticated success callback arrives, Core immediately copies the
validated Runware MP4 URL into the same private R2 object before completion.

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
submission (observed estimate USD 0.220000), configured private R2 and
Runware key, and a real ready shot with required locked canon. Do not run it
until that approval is given.
