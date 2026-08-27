# Rovelle private R2 asset registry

Rovelle Core owns asset IDs, metadata, and lifecycle state in PostgreSQL.
Cloudflare R2 stores bytes only. Clients use asset IDs; they never choose or
receive R2 storage keys.

The R2 bucket must remain private. Core issues short-lived presigned URLs,
which are bearer credentials: do not persist, log, forward, or expose them in
long-lived workflow data.

## Lifecycle

1. Reserve an asset. Core creates a `RESERVED` row and returns a presigned PUT
   URL whose `content-type` header must be sent exactly as supplied.
2. Upload bytes directly to R2. Bytes do not pass through Core or n8n.
3. Confirm the upload. Core calls `HeadObject` and changes the asset to
   `AVAILABLE` only when the object exists, is non-empty, and reports the
   registered media type when R2 supplies one.
4. Request a presigned GET URL for an `AVAILABLE` asset.

Missing, empty, or media-type-mismatched objects remain `RESERVED`. There is
no deletion, canon, Runware, generation, public-serving, or R2 public-domain
behavior in Phase 2A.

## Core API

All routes are protected by the existing `x-core-api-key` guard when
`CORE_API_KEY` is configured; send that header on every request in that
configuration. Send `content-type: application/json` only when a JSON body is
present. The success envelope is `{ "ok": true, "data": ... }`; errors are Nest `400` or
`404` responses.

| Method | Endpoint | Request headers/body | Success response paths |
| --- | --- | --- | --- |
| POST | `/api/rovelle/assets/reservations` | `content-type: application/json`; JSON body below | `data.asset.id`, `data.asset.status`, `data.upload.url`, `data.upload.headers["content-type"]` |
| GET | `/api/rovelle/assets/:id` | No body | `data.id`, `data.status`, `data.byteSize`; no R2 call or URL |
| POST | `/api/rovelle/assets/:id/upload-url` | No body | `data.asset.id`, `data.asset.status`, `data.upload.url` |
| POST | `/api/rovelle/assets/:id/confirm` | No body | `data.id`, `data.status`, `data.byteSize`, `data.etag` |
| POST | `/api/rovelle/assets/:id/read-url` | No body | `data.asset.id`, `data.asset.status`, `data.download.url` |

Reservation body:

```json
{
  "assetType": "SOURCE",
  "mediaType": "text/plain",
  "originalFilename": "phase2a-smoke.txt",
  "episodeId": "<optional-episode-uuid>"
}
```

Reservation response excerpt:

```json
{
  "ok": true,
  "data": {
    "asset": {
      "id": "<asset-uuid>",
      "status": "RESERVED",
      "mediaType": "text/plain"
    },
    "upload": {
      "method": "PUT",
      "url": "<short-lived-presigned-put-url>",
      "headers": { "content-type": "text/plain" },
      "expiresAt": "<iso-timestamp>"
    }
  }
}
```

Use the `data.upload.url` and `data.upload.headers` values for the direct R2
PUT. The upload request sends the exact registered `Content-Type` and the file
bytes to R2, never to Core. A confirmation response is the mapped asset under
`data`; a read URL response is under `data.download` (not `data.read`).
Metadata omits the internal storage key. `byteSize`, when present, is a
decimal string rather than a JavaScript bigint. URL-renewal and read URL
responses also contain the mapped asset under `data.asset`.

## R2 configuration

```dotenv
R2_ACCOUNT_ID=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET=
R2_PRESIGN_TTL_SECONDS=900
```

All four identity and bucket settings are optional as a group. A partial
configuration fails safely. The URL TTL defaults to 900 seconds and accepts
only whole seconds from 60 through 3600. Core uses the private account S3 API
endpoint (`https://<ACCOUNT_ID>.r2.cloudflarestorage.com`) with AWS region
`auto`.

## Operational smoke test

Use a development R2 bucket with bucket-scoped Object Read & Write credentials.
Do not echo secrets or print the generated presigned URLs. Reserve a
`text/plain` asset, PUT the file straight to `data.upload.url` with the exact
`Content-Type: text/plain` header, call `confirm`, then request the read URL
from `data.download.url` and compare the downloaded bytes. A subsequent
`upload-url` request must return HTTP 400 after confirmation.
