# Rovelle Runware webhook completion

Phase 3A submits one asynchronous Vidu 2 video task. Phase 3B accepts
Runware callbacks, verifies the provider-owned upload in private R2, and
persists the terminal result. Core owns the Rovelle state transition; n8n does
not proxy, persist, or mutate webhook state.

## 3A -> 3B asynchronous boundary

```text
3A (submission)
  submit task
  persist providerTaskId
  return after provider acceptance
  generation = SUBMITTED

Runware
  generate video
  PUT raw bytes to reserved R2 uploadEndpoint (preferred)
  POST terminal result to webhookURL

3B (completion)
  authenticate webhook
  resolve providerTaskId
  HEAD reserved R2 object; if missing, fetch validated Runware videoURL and PUT to R2
  persist terminal generation state
  mark output AVAILABLE
  move shot to REVIEW_REQUIRED or FAILED
  recompute episode aggregate state
```

Every new Runware submission includes `webhookURL`, which is built from
`RUNWARE_WEBHOOK_BASE_URL` and the configured query token. The callback URL is
created for the outbound task but is not persisted in `request_json` or any
Rovelle table. Phase 3A still returns after provider acceptance and does not
poll for completion.

Runware's `videoURL` is never persisted or returned by Core. R2 remains the
media source of truth. Runware's direct `uploadEndpoint` PUT is the normal
path; if it is absent at a success callback, Core accepts only an HTTPS
`vm.runware.ai` video URL, downloads it without redirects, writes it to the
reserved R2 object, then verifies the stored object before completion.

The endpoint is `POST /api/rovelle/webhooks/runware?token=<webhook-token>`.
The query token is used because it is Runware's documented webhook
authentication mechanism. Runware calls Core directly; this is not an n8n
HTTP Request node and it does not use the Core API-key header.

## Security configuration

```dotenv
RUNWARE_WEBHOOK_BASE_URL=https://core.example.com/api/rovelle/webhooks/runware
RUNWARE_WEBHOOK_TOKEN=<at-least-32-random-characters>
```

Operational requirements:

- Production callback URLs must use HTTPS. Non-production development may use
  loopback HTTP only.
- Use a high-entropy token with at least 32 characters. The dedicated
  webhook guard compares the query token in constant time.
- The reverse proxy should redact or omit the query string for this path in
  access logs and tracing output.
- Never paste a full webhook URL (including its token) into tickets, chat, or
  logs. Do not log the raw request, query string, or provider URL.
- The global Core API-key guard is skipped only on this webhook controller.
  The dedicated Runware token guard still runs; ordinary Core routes remain
  protected by `x-core-api-key` when `CORE_API_KEY` is configured.
- Rotate by updating Core configuration and new Runware submissions. In-flight
  tasks contain the old callback URL, so accepting both old and new tokens
  requires a deliberate overlap/rotation procedure outside Phase 3B. Do not
  print either token while rotating.

The webhook guard rejects a missing, wrong, non-string, or short query token.
An unconfigured/short server token is an unavailable configuration rather than
an authorization success.

## Callback endpoint and normalization

The parser accepts a direct one-task object, or exactly one relevant item in a
`data` or `errors` wrapper. A wrapper with zero items, multiple items, both
wrappers, or a mismatched result is rejected before the service can mutate
state. Only `taskType: "videoInference"` is accepted. The normalized internal
event contains the provider task UUID, event kind, optional progress, opaque
provider output identity, optional cost, and an ephemeral validated Runware
video URL only for the R2 fallback; unknown fields are discarded. The URL is
never persisted or logged.

Successful direct callback:

```json
{
  "taskType": "videoInference",
  "taskUUID": "550e8400-e29b-41d4-a716-446655440000",
  "status": "success",
  "videoUUID": "550e8400-e29b-41d4-a716-446655440001",
  "videoURL": "https://vm.runware.ai/example.mp4",
  "cost": 0.46
}
```

Failure direct callback:

```json
{
  "taskType": "videoInference",
  "taskUUID": "550e8400-e29b-41d4-a716-446655440000",
  "status": "error",
  "code": "timeoutProvider",
  "message": "The provider timed out"
}
```

Processing direct callback:

```json
{
  "taskType": "videoInference",
  "taskUUID": "550e8400-e29b-41d4-a716-446655440000",
  "status": "processing",
  "progress": 47
}
```

The equivalent one-item wrappers are normalized in the same way:

```json
{
  "data": [
    {
      "taskType": "videoInference",
      "taskUUID": "550e8400-e29b-41d4-a716-446655440000",
      "status": "success",
      "videoUUID": "550e8400-e29b-41d4-a716-446655440001",
      "cost": 0.46
    }
  ]
}
```

```json
{
  "errors": [
    {
      "taskType": "videoInference",
      "taskUUID": "550e8400-e29b-41d4-a716-446655440000",
      "code": "timeoutProvider",
      "message": "The provider timed out"
    }
  ]
}
```

Wrapper forms `{data:[...]}` and `{errors:[...]}` are normalized only when
they contain one relevant task item. Costs are carried as decimal strings into
the persistence boundary; missing cost is `null` and does not block success.

## Completion and retry behavior

1. Core authenticates and validates the callback before any state mutation.
2. Core looks up `providerTaskId`. An unknown UUID returns `200` with
   `{"accepted":true,"disposition":"unknown_task"}` and creates nothing.
3. A known `processing` callback moves a non-terminal generation to
   `PROCESSING`. Repeated processing callbacks are idempotent and do not
   complete or fail the generation.
4. A success callback HEADs the output asset's persisted R2 storage key. If
   it is absent and the callback has a validated provider video URL, Core
   downloads the MP4 and writes it to the reserved R2 key, then HEADs again.
5. If R2 still has no object, Core intentionally returns a non-2xx response
   (`503`) without mutation. Runware retries the callback; this prevents a
   false completion while direct upload or R2 persistence is still in flight.
6. A zero-byte R2 object is a durable `OUTPUT_EMPTY` failure. The generation
   and shot become `FAILED`, the output asset remains `RESERVED`, and the
   episode aggregate is recomputed.
7. A non-empty R2 object is completed atomically: R2 `byteSize` and `ETag`
   are persisted, the generation becomes `COMPLETED`, optional actual cost is
   persisted, and the output asset becomes `AVAILABLE`. The shot becomes
   `REVIEW_REQUIRED`.
8. A provider failure marks the generation and shot `FAILED`; its output asset
   remains `RESERVED`. Error fields are bounded and URL-redacted before
   persistence.
9. After a terminal shot transition, the episode remains `GENERATING` while
   any shot is still `READY_TO_GENERATE` or `GENERATING`; when none remain it
   becomes `REVIEW_REQUIRED`.

Duplicate callbacks are normal and safe. A callback for a terminal generation
returns `200` with an accepted `duplicate` disposition and does not HEAD R2 or
rewrite terminal state. Conditional database transitions and the transaction
boundary also make callback races safe: if a callback completes a `CREATED`
generation before the submission request later calls `markSubmitted`, the
submission transition observes terminal state and cannot regress it.

This callback-race guarantee complements the Phase 3A submission contract:
retrying the same client `requestId` returns the original attempt and does not
create a second paid provider task. See [Rovelle Runware generation
submission](runware-generation-submission.md) for that idempotency boundary.

## Response dispositions

Successful callbacks use the standard Core envelope:

```json
{
  "ok": true,
  "data": {
    "accepted": true,
    "disposition": "completed",
    "generationId": "<generation-uuid>"
  }
}
```

Other accepted dispositions are `processing`, `failed`, `duplicate`, and
`unknown_task`. Missing R2 on a success callback is an intentional retryable
non-2xx response rather than an accepted completion. Malformed or unsupported
payloads are rejected before mutation; invalid webhook authentication is
rejected by the dedicated guard.

## Phase 4 boundary

Phase 3B ends when generated bytes and terminal generation state are durable,
the output asset is `AVAILABLE` for success (or remains `RESERVED` for
failure), and shot/episode aggregates are recomputed. Review decisions start
in Phase 4. Phase 3B does not implement approval/rejection decisions,
regeneration, final rendering, publishing, or live Runware generation.

n8n remains responsible for triggers, scheduling, notifications, Telegram
delivery, and simple orchestration. Core remains the only writer of Rovelle
generation, asset, shot, and episode state.
