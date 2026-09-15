# Rovelle Final Render Review

Phase 5C is the human final-master decision boundary after a successful Phase
5B render. All routes use the existing Core API-key guard when `CORE_API_KEY`
is configured. Send `x-core-api-key` on every request; successful responses
use `{ "ok": true, "data": ... }`.

## Final-review lifecycle

```text
5B success
  Render COMPLETED
  output AVAILABLE
  Episode FINAL_REVIEW

APPROVE
  append final review
  episode.approvedRenderId = reviewed render
  Episode PUBLISH_READY

REJECT
  append final review
  Episode remains FINAL_REVIEW

RERENDER
  append final review
  Episode GENERATION_APPROVED
  return render-create endpoint/default audio+caption
  no hidden render execution

explicit create-render
  creates new Render attempt
  Episode RENDERING

5B worker
  completes next master
  Episode FINAL_REVIEW
```

Final reviews are append-only human decisions. A review request UUID is
idempotent for its render; reusing that UUID for a different render conflicts
with HTTP `409`. Only a `COMPLETED` render whose output is an `AVAILABLE`
`RENDER` video can be reviewed, and the render's episode must be in
`FINAL_REVIEW`.

## Retry versus rerender

```text
Worker Retry
  endpoint: /api/rovelle/renders/:renderId/retry
  trigger: technical render execution failure
  same Render
  same specHash
  same output asset
  new RenderJob

Final-Review RERENDER
  trigger: human final-master decision
  old Render remains COMPLETED
  episode returns GENERATION_APPROVED
  caller explicitly creates a new Render
  new spec snapshot/hash/output asset
```

Worker retry is for technical execution failure only. Clients must not use
retry for creative or final-master review changes. A final-review `RERENDER`
response is an audit record plus the existing render-create action; it does
not create a Render, RenderJob, or output asset.

## API

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `GET` | `/api/rovelle/final-reviews/queue` | List `FINAL_REVIEW` episodes and their highest valid completed render candidates |
| `POST` | `/api/rovelle/renders/:renderId/final-reviews` | Append or replay a human final-master decision |
| `GET` | `/api/rovelle/renders/:renderId/final-reviews` | Read append-only review history |
| `GET` | `/api/rovelle/episodes/:episodeId/final-master` | Resolve the approved final master after approval |
| `POST` | `/api/rovelle/episodes/:episodeId/renders` | Explicitly create the next Render after `RERENDER` |
| `POST` | `/api/rovelle/renders/:renderId/retry` | Retry a failed Render's technical execution |

### APPROVE

`POST /api/rovelle/renders/:renderId/final-reviews`

```json
{
  "requestId": "550e8400-e29b-41d4-a716-446655440000",
  "decision": "APPROVE",
  "notes": "Final master approved."
}
```

The reviewed Render, its output, and its job history remain unchanged. The
episode stores that exact Render ID in `approvedRenderId` and moves to
`PUBLISH_READY`.

### REJECT

```json
{
  "requestId": "550e8400-e29b-41d4-a716-446655440001",
  "decision": "REJECT",
  "notes": "Caption timing needs another pass."
}
```

The review is appended, no work is queued, and the episode remains
`FINAL_REVIEW`. The completed Render remains eligible for a later human
approval using a new review request UUID.

### RERENDER

```json
{
  "requestId": "550e8400-e29b-41d4-a716-446655440002",
  "decision": "RERENDER",
  "notes": "Use the corrected audio master."
}
```

The response supplies the existing render-create endpoint and defaults from
the reviewed Render's frozen spec, for example:

```json
{
  "type": "CREATE_RENDER",
  "endpoint": "/api/rovelle/episodes/<episodeId>/renders",
  "defaults": {
    "audioAssetId": "<prior-audio-asset-id>",
    "captionAssetId": "<prior-caption-asset-id>"
  }
}
```

RERENDER response supplies defaults but caller may choose another valid
same-episode AUDIO_MASTER/CAPTION when making the explicit render-create
request. That second command creates the new Render attempt, reserved output,
and queued RenderJob, and changes the episode to `RENDERING`.

The render-create request is:

```json
{
  "requestId": "<new-render-request-uuid>",
  "audioAssetId": "<same-episode-audio-master-asset-id>",
  "captionAssetId": "<same-episode-caption-asset-id-or-null>"
}
```

When the render worker completes the new master, the episode returns to
`FINAL_REVIEW`. The old completed Render and its review history remain
available.

## Queue and private previews

The queue contains only episodes currently in `FINAL_REVIEW`. For each episode
it selects the highest valid completed Render attempt and includes prior review
history for that Render. Queue previews and approved-master reads are short-
lived private R2 GET URLs. Storage keys, lease tokens, and other internal
credentials are never returned.

## Phase 6 source of truth

Phase 6 publishing must resolve:

```text
episode.approvedRenderId
```

and verify:

- the approved render belongs to the episode;
- `COMPLETED`;
- output `AVAILABLE`;
- output type `RENDER`/video.

It must **not** select:

```text
latest render
highest attempt
latest AVAILABLE RENDER asset
```

This is a non-negotiable handoff invariant. `PUBLISH_READY` has no Phase 5C
reverse path.

## n8n request contract

For every request, an n8n HTTP Request node sends:

```text
Header: x-core-api-key: <CORE_API_KEY>
Header: Content-Type: application/json
```

n8n remains responsible for triggers, scheduling, Telegram delivery, and
simple orchestration. Core owns final-review persistence and episode/render
state. Phase 5C introduces no FFmpeg, provider, or publishing adapter call.
