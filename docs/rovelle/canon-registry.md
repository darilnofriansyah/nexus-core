# Rovelle canon registry

The canon registry records the production reference for each reusable Rovelle
entity. It is separate from asset storage: Core owns canon metadata and IDs;
assets remain in the private R2 asset registry and are addressed only by asset
ID.

## Concepts

- **Entity** is the stable production identity, for example `KOKO`.
- **Version** is an immutable design revision of that entity, for example
  KOKO V1.
- **Asset** is a production reference attached to a draft version.
- **Lock** is the irreversible transition that freezes a draft version.
- **Episode pin** is the production default for an entity in an episode.
- **Shot pin** is a per-shot override for an entity.
- **Effective shot canon** is the episode defaults plus direct shot overrides.
  A shot override replaces its episode pin for the same entity, so the result
  contains no duplicate entities and is ordered by entity code.

The current entity types and their only compatible asset types are:

| Canon entity type | Compatible AVAILABLE asset type |
| --- | --- |
| `CHARACTER` | `CHARACTER_REFERENCE` |
| `ENVIRONMENT` | `ENVIRONMENT_REFERENCE` |
| `STYLE` | `STYLE_REFERENCE` |

An attachment is accepted only when the asset is already `AVAILABLE` and its
type exactly matches this table. Each attachment has a role and sort order;
roles/sort orders make multi-asset references deterministic.

## Versions and immutability

Entity codes are stable, uppercase production identifiers and unique. Core
assigns sequential version numbers per entity. New versions start as `DRAFT`.

Only a draft version may have its definition changed or assets attached,
detached, or reordered. Locking requires at least one compatible attached
asset and makes the version `LOCKED`. The transition is one way (`DRAFT` to
`LOCKED`): there is no unlock route or mutation. A new design must be created
as a new version; locking V2 never moves existing pins from V1.

Pins require a `LOCKED` version belonging to the requested entity. PostgreSQL
also enforces that entity/version match, and permits at most one pin for an
entity per episode and per shot. Pins may be created, replaced, or removed
only before generation begins; changes after that point are rejected.

## Core API

All routes below are under the `/api` global prefix and use the normal
`x-core-api-key` protection when `CORE_API_KEY` is configured. Successful
responses use `{ "ok": true, "data": ... }`. Requests with a body use
`content-type: application/json`.

| Method | Endpoint | Purpose |
| --- | --- | --- |
| POST | `/api/rovelle/canon/entities` | Create an entity |
| GET | `/api/rovelle/canon/entities` | List entities |
| GET | `/api/rovelle/canon/entities/:entityId` | Read an entity |
| POST | `/api/rovelle/canon/entities/:entityId/versions` | Create the next draft version |
| GET | `/api/rovelle/canon/versions/:versionId` | Read a version and attachments |
| PUT | `/api/rovelle/canon/versions/:versionId` | Replace a draft definition |
| POST | `/api/rovelle/canon/versions/:versionId/assets` | Attach an AVAILABLE compatible asset to a draft |
| DELETE | `/api/rovelle/canon/versions/:versionId/assets/:assetId` | Detach an asset from a draft |
| POST | `/api/rovelle/canon/versions/:versionId/lock` | Lock a draft version |
| GET | `/api/rovelle/episodes/:episodeId/canon` | List episode-default pins |
| PUT | `/api/rovelle/episodes/:episodeId/canon/:entityId` | Create or replace an episode pin |
| DELETE | `/api/rovelle/episodes/:episodeId/canon/:entityId` | Remove an episode pin |
| GET | `/api/rovelle/shots/:shotId/canon` | Read effective shot canon |
| PUT | `/api/rovelle/shots/:shotId/canon/:entityId` | Create or replace a shot override |
| DELETE | `/api/rovelle/shots/:shotId/canon/:entityId` | Remove a shot override |

## Example request payloads

Create `KOKO` with `POST /api/rovelle/canon/entities`:

```json
{
  "code": "KOKO",
  "displayName": "Koko the Quokka",
  "entityType": "CHARACTER",
  "description": "Clovervale quirky inventor and comic character."
}
```

Create KOKO V1 with
`POST /api/rovelle/canon/entities/:entityId/versions`:

```json
{
  "definition": {
    "heightRelativeToPiko": 0.84,
    "frontTooth": "one tiny front tooth",
    "fur": "sandy caramel with light beige muzzle and belly",
    "backpack": "mint mini-backpack",
    "bodyShape": "round pear-shaped"
  }
}
```

Attach a reference asset with
`POST /api/rovelle/canon/versions/:versionId/assets`:

```json
{
  "assetId": "<available-character-reference-uuid>",
  "role": "TURNAROUND",
  "sortOrder": 0
}
```

Pin a locked version with either
`PUT /api/rovelle/episodes/:episodeId/canon/:entityId` or
`PUT /api/rovelle/shots/:shotId/canon/:entityId`:

```json
{
  "canonVersionId": "<locked-koko-v1-uuid>"
}
```

Locking has no JSON body. The effective-shot response contains one item per
entity; each item has `source: "EPISODE"` or `source: "SHOT"` and the complete
locked version, including its deterministically ordered reference assets.

## n8n ownership

n8n HTTP Request nodes can call these canonical Core API endpoints. n8n keeps
triggers, scheduling, Telegram sending, and simple orchestration. It must not
mutate Rovelle canon tables directly.
