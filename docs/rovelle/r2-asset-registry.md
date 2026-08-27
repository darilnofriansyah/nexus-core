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
`CORE_API_KEY` is configured.

| Method | Endpoint | Purpose |
| --- | --- | --- |
| POST | `/api/rovelle/assets/reservations` | Reserve metadata and receive a PUT URL. |
| GET | `/api/rovelle/assets/:id` | Read metadata without generating an R2 URL. |
| POST | `/api/rovelle/assets/:id/upload-url` | Renew the PUT URL while the asset is `RESERVED`. |
| POST | `/api/rovelle/assets/:id/confirm` | Confirm uploaded bytes through `HeadObject`. |
| POST | `/api/rovelle/assets/:id/read-url` | Receive a GET URL for an `AVAILABLE` asset. |

Example n8n HTTP Request body for a reservation:

```json
{
  "assetType": "SOURCE",
  "mediaType": "text/plain",
  "originalFilename": "phase2a-smoke.txt"
}
```

n8n calls Core with `content-type: application/json` and, when configured,
`x-core-api-key`. It must send the returned upload URL directly to R2 using
the returned `upload.headers`; it must not place file bytes in a Core request.
For the metadata, confirmation, and URL-renewal endpoints, n8n sends no body.

External asset metadata omits the internal storage key. `byteSize`, when
present, is a decimal string rather than a JavaScript bigint.

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
`text/plain` asset, PUT the file straight to its upload URL with the exact
`Content-Type: text/plain` header, call `confirm`, obtain the read URL, and
compare the downloaded bytes. A subsequent `upload-url` request must return
HTTP 400 after confirmation.
