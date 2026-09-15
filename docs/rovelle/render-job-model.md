# Rovelle render queue model

The render queue and its separate worker are implemented. Core atomically
queues a render; `render-worker` claims eligible jobs, reads signed source
URLs only at execution time, renders with ffmpeg, uploads the master, and
records the terminal state.

## Render and RenderJob

`Render` is the immutable logical master attempt for one episode. It freezes:

- the exact approved generation and target duration for every shot;
- the exact episode audio master and optional caption asset;
- the `VERTICAL_SHORT_V1` output profile and deterministic spec hash; and
- one reserved `RENDER` `video/mp4` output asset.

`RenderJob` is one worker execution attempt for that `Render`. It holds queue,
lease, error, and timing state. A retry appends a new job to the same Render,
using the same immutable spec and reserved output asset; prior failed jobs
remain historical.

```text
Render
  immutable logical master attempt
  exact source snapshot
  exact output profile
  one reserved R2 output asset

RenderJob
  one worker execution attempt
  queue/lease/error/timing state
  retries append new jobs
  same Render/spec/output asset
```

A **retry** executes the same spec again. It is allowed only after the Render
has failed, and it creates one new queued RenderJob. A **new render** is a new
logical master attempt with a different Render/spec; later final-review
rerender behavior introduces that path, not Phase 5A.

Render creation is atomic: Core reserves the output asset, creates the Render
and its initial queued job, and changes the episode from `GENERATION_APPROVED`
to `RENDERING` in one transaction. The create request UUID is idempotent.

## Immutable deterministic spec

The persisted spec has version `1`. Its SHA-256 hash is computed from a stable
JSON representation, so the same spec produces the same hash. It contains
only frozen asset metadata and output settings: no storage key, signed URL,
token, secret, or authorization value.

```json
{
  "version": 1,
  "profile": "VERTICAL_SHORT_V1",
  "output": {
    "container": "mp4",
    "width": 1080,
    "height": 1920,
    "frameRate": 30,
    "videoCodec": "libx264",
    "pixelFormat": "yuv420p",
    "audioCodec": "aac",
    "audioSampleRate": 48000
  },
  "shots": [
    {
      "sequence": 1,
      "shotId": "<uuid>",
      "generationId": "<uuid>",
      "targetDurationSeconds": 5,
      "video": {
        "assetId": "<uuid>",
        "mediaType": "video/mp4",
        "byteSize": "1234567",
        "etag": "abc123"
      }
    }
  ],
  "audio": {
    "assetId": "<uuid>",
    "mediaType": "audio/mpeg",
    "byteSize": "345678",
    "etag": "def456"
  },
  "captions": null
}
```

Core validates that source assets are episode-correct and `AVAILABLE` at
enqueue time. The signed R2 URLs needed to read those frozen assets are
resolved only by the render worker; they are never persisted in the
spec or returned by the render API.

## Core API requests

All routes are under `/api`, retain the existing `x-core-api-key` protection
when `CORE_API_KEY` is configured, and return `{ "ok": true, "data": ... }`
on success. Requests with bodies use `content-type: application/json`.

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `POST` | `/api/rovelle/episodes/:episodeId/renders` | Create or replay an idempotent queued Render |
| `GET` | `/api/rovelle/episodes/:episodeId/renders` | List an episode's Render attempts |
| `GET` | `/api/rovelle/renders/:renderId` | Read one Render and its job history |
| `POST` | `/api/rovelle/renders/:renderId/retry` | Append an idempotent queued job for a failed Render |

Create request:

```json
{
  "requestId": "550e8400-e29b-41d4-a716-446655440000",
  "audioAssetId": "550e8400-e29b-41d4-a716-446655440001",
  "captionAssetId": null
}
```

Retry request:

```json
{
  "requestId": "550e8400-e29b-41d4-a716-446655440002"
}
```

The retry request UUID is idempotent per job request. It cannot create a
second active queued or running job, and it preserves the failed Render's
spec, hash, output asset, and existing job history.

The create endpoint returns after its atomic enqueue transaction; it does not
wait for media work. The reserved output asset has no required R2 object at
enqueue time. Render reads expose queue state but omit the lease token and
internal storage key.

## Worker claim and completion

The worker atomically selects eligible jobs using `FOR UPDATE SKIP LOCKED`:

```sql
SELECT id
FROM rovelle_render_jobs
WHERE status = 'QUEUED'
  AND available_at <= now()
ORDER BY available_at ASC, created_at ASC
FOR UPDATE SKIP LOCKED
LIMIT 1;
```

The claim sets the job and Render to `RUNNING`, records a random lease token,
and assigns lease timestamps. Completion requires that token, marks the output
asset `AVAILABLE`, marks the Render `COMPLETED`, and moves the episode to
`FINAL_REVIEW`. Failure and expired leases mark the job and Render `FAILED`.
Retries create a new queued job for the same immutable render spec.

The worker validates ffmpeg/ffprobe at startup, recovers expired leases, uses
temporary job workspaces, and is deployed with `npm run start:render-worker`.
Its deployment still requires current operational evidence; source presence is
not production deployment proof.
