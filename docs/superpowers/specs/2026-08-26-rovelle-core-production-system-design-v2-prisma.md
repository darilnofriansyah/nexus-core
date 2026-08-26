# Rovelle Core Production System — Design Specification

**Date:** 2026-08-26  
**Status:** Proposed — awaiting user review  
**Target repository:** `darilnofriansyah/nexus-core`  
**Target runtime:** existing NestJS Core API  
**Implementation planning:** intentionally deferred until this design is approved  
**Codex execution model:** Terra as primary implementation orchestrator; Luna Max as delegated implementation/review worker  
**Usage constraint:** work must be partitioned into independently mergeable phases sized for roughly one 5-hour Codex usage window whenever practical

---

## 1. Decision Summary

Rovelle will be implemented as a new top-level bounded context inside `nexus-core`.

Core API is the authoritative production system.

For Rovelle specifically:

- Core owns episode state.
- Core owns canon and asset metadata.
- Core owns generation requests and provider state.
- Core talks directly to Runware through the official TypeScript SDK.
- Core owns review and regeneration history.
- Core owns generation cost accounting.
- Core owns render jobs and final-master state.
- Core owns publishing state for YouTube, Instagram, and TikTok.
- Cloudflare R2 stores binary production assets.
- PostgreSQL stores production metadata and authoritative state.
- n8n remains an auxiliary automation/integration layer.
- OpenAI is optional and advisory, not the source of truth.
- Human approval remains authoritative for creative review and final publish approval in V1.

The core architectural rule is:

> **If an action changes what Rovelle believes is true about an episode, that action belongs in Core.**

n8n may trigger that action by calling Core, but it may not own the resulting state.

---

## 2. Repository Findings

This design is anchored to the current `nexus-core` repository rather than a hypothetical new service.

### Existing runtime

The repository is a NestJS 10 / TypeScript application.

It currently has:

- `src/aegis`
- `src/veyra`
- `src/ai`
- `src/common`
- `src/config`
- `src/database`
- `src/health`

`AppModule` imports `DatabaseModule`, `AegisModule`, and `VeyraModule`.

Rovelle should follow the same pattern as a new top-level module:

```text
src/
  aegis/
  veyra/
  rovelle/
  ai/
  common/
  config/
  database/
```

### Database pattern and Prisma adoption

The repository currently uses `pg` directly through the shared `DatabaseService`.

Rovelle will intentionally become the first bounded context to use Prisma. This is a forward-looking repository convention, not a requirement to rewrite existing Veyra/Aegis persistence.

The coexistence model is:

```text
existing Veyra/Aegis feature
        |
    repository
        |
 DatabaseService
        |
       pg
        |
   PostgreSQL


new Rovelle feature
        |
    service
        |
 PrismaService
        |
 Prisma Client
        |
 @prisma/adapter-pg
        |
   PostgreSQL
```

New Veyra features may use Prisma after the Rovelle foundation proves stable.

Existing raw-SQL features migrate only when a separately approved feature/refactor gives a concrete reason to touch them.

Do not mix Prisma and `DatabaseService` inside the same transaction or repository unless a later design explicitly requires it.

Repository classes remain useful when they provide a meaningful persistence boundary or isolate complex query semantics; Prisma does not require every service to expose Prisma directly.

### Migration pattern

Schema changes are represented as explicit SQL files under:

```text
docs/migration/
```

Rovelle migrations should use the same convention.

### Testing pattern

The repository compiles TypeScript tests and runs them through Node's native test runner.

No new test framework is required.

### Authentication pattern

A global `ApiKeyGuard` protects Core routes through the `x-core-api-key` header when `CORE_API_KEY` is configured.

Runware webhooks cannot be expected to provide this header. Rovelle therefore needs one narrowly scoped external-webhook authentication path rather than disabling Core authentication globally.

### Existing OpenAI integration

The repository already depends on the OpenAI Node package and contains Veyra-specific AI services.

Rovelle must not couple itself to `VeyraAIService`.

If OpenAI is used by Rovelle later, it should either:

1. use a small shared OpenAI client abstraction, or
2. own a Rovelle-specific AI service that reuses common configuration.

The first Rovelle phases do not depend on OpenAI at all.

---

## 3. Required AGENTS.md Exception

The existing repository instructions correctly describe Veyra/Aegis migration strategy, but two current rules conflict with Rovelle's intended architecture:

- n8n is described as the orchestration layer.
- database schema changes are generally prohibited without approval.

Those rules remain correct for existing Veyra and Aegis work.

Rovelle is an explicit exception.

Before implementation begins, `AGENTS.md` should receive a narrow Rovelle section equivalent to:

```text
## Rovelle Exception

For src/rovelle/** and Rovelle-specific database tables:

- NestJS Core is the authoritative orchestration and state layer.
- n8n is an auxiliary trigger/notification/integration layer.
- Rovelle-specific additive PostgreSQL migrations are allowed only when
  backed by an approved Superpowers design/implementation plan.
- Do not apply these Rovelle rules to Veyra or Aegis.
- Do not move existing Veyra/Aegis production orchestration without an
  explicit separate request.
```

This prevents future Codex workers from following the old n8n-centric rule and unintentionally redesigning Rovelle.

This is documentation/agent policy only. It does not authorize unrelated Veyra/Aegis changes.

---

## 4. Goals

### Product goals

Rovelle V1 must be able to:

1. Create and manage a production episode.
2. Store a structured approved brief.
3. Define ordered shots.
4. Resolve locked character/environment/style references.
5. Run a preflight before spending generation credit.
6. Submit image/video generation through Runware.
7. Store generated output in R2.
8. Receive asynchronous provider completion.
9. Preserve every generation attempt.
10. Track estimated/actual generation cost where available.
11. Support human approve/reject/regenerate decisions.
12. Select one approved generation per shot.
13. Produce a deterministic final video master.
14. Require final human approval.
15. Publish approved masters to supported social platforms.
16. Expose state to n8n/Telegram/dashboard clients through Core APIs.
17. Optionally use OpenAI for assistance without making AI authoritative.

### Engineering goals

- follow existing NestJS conventions
- establish Prisma as the preferred data-access layer for new bounded contexts
- preserve existing `DatabaseService` + raw `pg` code for untouched Veyra/Aegis features
- avoid a forced legacy rewrite
- avoid Redis in V1
- keep large media binaries out of Core/n8n memory when possible
- isolate provider-specific code
- make webhook processing idempotent
- make phases independently testable and mergeable
- keep Veyra/Aegis behavior unchanged

---

## 5. Non-Goals

V1 will not:

- replace existing Veyra/Aegis orchestration
- turn n8n into the production database
- build a generic multi-tenant creator SaaS
- create a microservice fleet
- add Kubernetes
- add Redis solely for job queues
- let OpenAI autonomously approve creative assets
- autonomously publish without an explicit final approval gate
- build advanced social analytics before publishing works
- support arbitrary generation providers in the UI
- expose direct R2 credentials to clients
- rewrite existing `src/ai` code during early Rovelle phases
- perform large repository-wide refactoring

---

## 5A. Prisma Adoption Strategy

Prisma is a repository platform decision that Rovelle will introduce safely.

### Direction

The preferred long-term rule is:

> **New domain persistence uses Prisma unless there is a concrete SQL-level reason not to. Existing raw `pg` code remains supported until intentionally migrated.**

This means Prisma is not "Rovelle-only." Rovelle is simply the first adopter.

Future examples:

```text
src/rovelle/**                 -> Prisma by default
new src/veyra/<feature>/**     -> Prisma by default
existing Veyra repositories   -> keep raw pg until separately touched
existing Aegis repositories   -> keep current behavior
```

### One database, two access layers

Both access layers use the same PostgreSQL database.

That coexistence is acceptable, but ownership must remain explicit.

Rules:

1. A table has one primary application access style per feature during a change.
2. Do not rewrite a working raw-SQL repository merely because its table appears in Prisma.
3. Do not hold a Prisma transaction open while calling a raw `DatabaseService` transaction.
4. Cross-domain operations that require atomicity must be designed explicitly rather than assuming the two clients share transaction context.
5. Connection-pool limits must consider both the existing `pg` pool and Prisma's PostgreSQL adapter pool.
6. Production schema changes must have one migration source of truth.

### Prisma schema visibility

Prisma should understand the existing database sufficiently to avoid creating contradictory schema definitions, but the initial Rovelle implementation does not need to convert every Veyra table into application-facing Prisma repositories.

Existing production tables can be introspected/baselined as required by the chosen Prisma migration workflow.

Rovelle models use mapped database names:

```text
Prisma model name: RovelleEpisode
Database table:    rovelle_episodes
```

### Migration ownership

Once Prisma adoption is established, new Rovelle schema changes should use Prisma Migrate as the primary migration mechanism rather than hand-authoring a separate SQL migration for the same tables.

Do not maintain two competing migration histories for Rovelle.

Legacy SQL migrations under `docs/migration/` remain historical truth for the pre-Prisma database.

The Prisma migration baseline must represent the already-existing production schema without replaying or recreating it.

### Version selection

Do not use a floating Prisma major.

At Phase 0A implementation time:

1. verify the current generally available Prisma release and Node requirements
2. pin exact compatible Prisma packages
3. verify generated-client/module format against the NestJS build
4. record the selected major in the implementation plan

The conservative default for the repository's current Node 22 runtime is the fully supported Prisma 7 line unless the user separately approves a Node 24 / Prisma 8 runtime modernization.

### Module-system impact

The current repository compiles TypeScript as CommonJS.

Modern Prisma 7 uses ESM.

Therefore Prisma adoption must be treated as a compatibility migration, not merely `npm install prisma`.

The implementation plan must verify:

- NestJS bootstrap
- decorator metadata
- Node test runner
- compiled test paths
- current OpenAI integration
- all Veyra imports
- all Aegis imports
- Docker build/start
- existing scripts

before Rovelle depends on Prisma.

### Prisma module boundary

Recommended shared infrastructure:

```text
src/database/
  database.module.ts
  database.service.ts       # existing raw pg; retained
  prisma.module.ts          # new
  prisma.service.ts         # new
```

`PrismaModule` is shared infrastructure, not a Rovelle-only module, because future Veyra features may use it.

### Why this is preferable

This lets Rovelle benefit from:

- typed relations
- safer CRUD
- schema-driven model evolution
- cleaner transactions within Rovelle
- maintainable generation/canon/asset relations
- easier future Veyra development

without paying the risk of rewriting mature finance logic at the same time.


---

## 6. Architecture

```text
                       ChatGPT / Dashboard / Telegram
                                  |
                                  v
                       +----------------------+
                       |    ROVELLE CORE      |
                       |      NestJS          |
                       +----------+-----------+
                                  |
          +-----------------------+-----------------------+
          |                       |                       |
          v                       v                       v
      PostgreSQL             Cloudflare R2          Render Worker
   authoritative state       binary assets             FFmpeg
          |
          +------------------------+
          |                        |
          v                        v
     Runware Provider         OpenAI Assistant
     @runware/sdk             optional / later
          |
          v
      async generation
          |
          v
   Runware webhook -> Core

          |
          +--------------------------------------------+
          |
          v
      Publishing adapters
   YouTube / Instagram / TikTok


                          n8n
                           |
             +-------------+-------------+
             |             |             |
          Telegram      schedules      alerts
             |             |             |
             +-------------+-------------+
                           |
                           v
                      Core API
```

---

## 7. Why a Modular Monolith

Three architectures were considered.

### A. n8n-centric

Rejected.

It would duplicate backend responsibilities, weaken state modeling, and make provider history difficult to test.

### B. immediate Rovelle microservices

Rejected for V1.

Separate production, generation, storage, render, and publisher services would add unnecessary operational cost on the current VPS and consume more Codex capacity.

### C. modular Core + external heavy worker

Selected.

Rovelle lives inside the existing NestJS process, while heavy media rendering runs through a worker boundary.

This keeps one system of record while retaining a clean future extraction point if volume grows.

---

## 8. Proposed Source Boundary

The design intentionally does not require a single large `RovelleService`.

Recommended bounded layout:

```text
src/rovelle/
  rovelle.module.ts

  production/
    episode.controller.ts
    episode.service.ts
    episode.repository.ts
    shot.service.ts
    shot.repository.ts
    dto/

  canon/
    canon.service.ts
    canon.repository.ts
    dto/

  assets/
    asset.service.ts
    asset.repository.ts
    r2-storage.service.ts
    dto/

  generation/
    generation.service.ts
    generation.repository.ts
    generation-provider.ts
    runware/
      runware.provider.ts
      runware-webhook.controller.ts
      runware-webhook.guard.ts
    dto/

  review/
    review.service.ts
    review.repository.ts
    dto/

  rendering/
    rendering.service.ts
    rendering.repository.ts
    dto/

  publishing/
    publishing.service.ts
    publishing.repository.ts
    providers/
      publisher.ts
      youtube.publisher.ts
      instagram.publisher.ts
      tiktok.publisher.ts
    dto/

  events/
    rovelle-event.service.ts
    rovelle-event.repository.ts
```

Exact file splits can be adjusted during implementation planning to avoid tiny unnecessary files, but these domain boundaries should remain.

---

## 9. Database Namespace

Rovelle will share the existing PostgreSQL database but will not reuse Veyra tables for unrelated production concepts.

All Rovelle tables should use a `rovelle_` prefix.

Reasons:

- the repository currently uses the public PostgreSQL schema
- a new PostgreSQL schema would introduce a new convention
- generic names like `assets`, `episodes`, or `reviews` are collision-prone
- prefixed tables make ownership obvious in SQL and operations

No existing Veyra or Aegis table is modified merely to support Rovelle.

---

## 10. Production Domain

### Episode

An episode is the aggregate root for production.

Conceptual fields:

```text
id
slug/code
title
status
brief_json
target_duration_seconds
generation_budget
generation_spent
created_at
updated_at
```

The structured brief may remain JSONB in V1 because creative brief fields will evolve faster than production invariants.

Important production facts such as status and cost must remain separate queryable columns.

### Shot

A shot belongs to an episode.

Conceptual fields:

```text
id
episode_id
sequence
name
direction
target_duration_seconds
status
approved_generation_id
created_at
updated_at
```

The shot stores creative direction.

It does not store Runware-specific request JSON as its source of truth.

---

## 11. Episode State Machine

Episode status cannot be an arbitrary update.

Recommended lifecycle:

```text
DRAFT
  |
  v
BRIEF_APPROVED
  |
  v
PREPRODUCTION
  |
  v
READY_TO_GENERATE
  |
  v
GENERATING
  |
  v
REVIEW_REQUIRED
  | \
  |  +----> GENERATING
  |
  v
GENERATION_APPROVED
  |
  v
RENDERING
  |
  v
FINAL_REVIEW
  |
  v
PUBLISH_READY
  |
  v
PUBLISHING
  |
  v
PUBLISHED
```

Control/exception states:

```text
PAUSED
CANCELLED
FAILED
```

State transitions belong in `EpisodeService`, not controllers, n8n, provider callbacks, or repositories.

Provider completion changes generation state first.

The Production service decides whether the aggregate episode state should change.

---

## 12. Canon Domain

Rovelle's canon registry solves a central Ringmaster production problem:

> Asking for Koko should resolve the exact approved Koko, not an accidental approximate version.

### Canon entity

Examples:

```text
OTTI
PIKO
KOKO
MEADOW_VILLAGE
SUNPETAL_FIELDS
CLOVERVALE_STORYBOOK_STYLE
```

### Canon version

Example:

```text
entity: KOKO
version: 1
status: LOCKED
```

A canon version is immutable after it is locked.

If the design changes later, create V2.

Do not mutate V1.

### Canon asset relationships

A canon version may own multiple assets:

```text
KOKO_V1
  |
  +-- turnaround
  +-- transparent-character
  +-- portrait
  +-- optional expression reference
```

This requires an explicit relation between canon versions and assets rather than a single file column.

### Episode pinning

When an episode enters production, its canon references are pinned.

If `KOKO_V2` is created tomorrow, an episode already generating with `KOKO_V1` does not silently change.

---

## 13. Asset Domain and R2

PostgreSQL stores asset metadata.

R2 stores bytes.

### Asset metadata

Conceptual fields:

```text
id
asset_type
media_type
storage_key
original_filename
sha256
byte_size
status
created_at
```

Useful asset types include:

```text
CHARACTER_REFERENCE
ENVIRONMENT_REFERENCE
STYLE_REFERENCE
AUDIO_MASTER
STORYBOARD
GENERATION
RENDER
THUMBNAIL
CAPTION
PUBLISH_COPY
```

### R2 logical layout

```text
ringmaster/
  canon/
    characters/
      otti/v1/
      piko/v1/
      koko/v1/
    environments/
    style/

  music/

  episodes/
    EP-007/
      brief/
      storyboard/
      source/
      generations/
        S01/
          G001/
          G002/
      renders/
      publish/
```

The folder structure is operational convenience only.

Business code references internal asset IDs, not hand-built folder strings.

### Presigned URL rule

Core generates short-lived signed URLs.

Use cases:

- upload reference asset
- Runware output upload
- render-worker download
- render-worker upload
- UI/Telegram preview

R2 credentials never leave Core/worker configuration.

---

## 14. Preflight

Preflight must occur before generation credit is spent.

The preflight checks:

- episode is in a valid state
- at least one shot exists
- shot sequence is valid
- required canon versions exist
- required canon versions are locked
- referenced R2 assets exist
- target duration is sensible
- generation model/config is resolvable
- generation budget exists when budget enforcement is enabled
- requested generation would not exceed a hard budget limit when cost can be estimated
- callback/public base URL configuration is present
- Runware is configured
- R2 is configured

Preflight results should be structured and persisted or reproducible.

A failed preflight does not partially start generation.

---

## 15. Generation Provider Boundary

Core must not let Runware request structures leak across the production domain.

Internal interface concept:

```text
GenerationProvider
  generateImage(...)
  generateVideo(...)
  getTask(...)
  cancelTask(...)
  estimateCost(...)     // when provider/model supports it
  normalizeResult(...)
```

V1 implements:

```text
RunwareGenerationProvider
```

The internal request uses normalized Rovelle concepts:

```text
shotId
modality
modelKey
prompt
referenceAssets
duration
aspectRatio
seed?
providerOptions?
```

`providerOptions` is allowed only for model-specific escape hatches and should not become the main domain model.

---

## 16. Runware Integration

Use the official `@runware/sdk`.

V1 should prefer REST submission plus asynchronous completion for long-running video generation.

Core performs:

1. create a new generation attempt
2. reserve a unique provider task UUID
3. determine R2 output key
4. create an R2 presigned PUT URL
5. compile provider request
6. submit through Runware SDK
7. record provider task ID and submission state
8. return immediately

Runware performs generation asynchronously.

When supported by the selected model, Core supplies the R2 presigned URL as Runware `uploadEndpoint`.

Generated video therefore flows:

```text
Runware
   |
   | HTTP PUT
   v
Cloudflare R2
```

not:

```text
Runware -> Core memory -> n8n -> R2
```

The webhook then tells Core that the generation completed.

---

## 17. Runware Webhook Authentication

The repository currently has a global API-key guard requiring `x-core-api-key`.

Runware webhooks support authentication through URL parameters rather than that custom header.

Rovelle therefore needs an explicit exception:

```text
global ApiKeyGuard
        |
        +-- normal Core routes -> x-core-api-key
        |
        +-- explicitly decorated external webhook route
                |
                v
        RunwareWebhookGuard
                |
                v
        RUNWARE_WEBHOOK_TOKEN
```

Requirements:

- only explicitly marked webhook routes bypass `ApiKeyGuard`
- bypass metadata must not be usable accidentally on ordinary controllers
- Runware webhook guard validates a high-entropy secret
- invalid callbacks return 401
- callback processing is idempotent
- unknown provider task IDs do not create records
- duplicate callbacks return success after confirming the existing terminal state
- webhook handler returns promptly
- no heavy media processing happens in the request

This is a security-sensitive cross-cutting change and must have focused guard tests.

---

## 18. Generation Attempts and History

A shot can have many generation attempts.

Example:

```text
S03
  |
  +-- G001  COMPLETED -> REJECTED
  +-- G002  COMPLETED -> REJECTED
  +-- G003  COMPLETED -> APPROVED
  +-- G004  COMPLETED -> alternate
```

Recommended generation fields:

```text
id
shot_id
provider
model
provider_task_id
prompt
request_json
status
output_asset_id
estimated_cost
actual_cost
error_code
error_message
created_at
submitted_at
completed_at
```

Historical attempts are immutable except for legitimate lifecycle fields.

Regeneration creates a new row.

Never overwrite an old generation with a new provider result.

---

## 19. Generation Cost Accounting

Cost needs to be visible because Ringmaster is budget-sensitive.

V1 should capture cost at the generation-attempt level.

Use provider-returned cost when available.

Store:

```text
estimated_cost
actual_cost
currency
pricing_source
```

Episode spend is calculated from attempts rather than manually incremented without an audit trail.

A cached `generation_spent` field may be added later only if query cost becomes relevant.

Failed generations remain cost-visible if the provider charged for them.

---

## 20. Review Domain

Provider success means:

> media generation completed.

It does **not** mean:

> media is approved.

Review is separate.

### Human review

Human decisions:

```text
APPROVE
REJECT
REGENERATE
```

Review record:

```text
id
generation_id
reviewer_type = HUMAN
decision
notes
created_at
```

When a generation is approved:

- the generation itself remains historically unchanged
- shot `approved_generation_id` points to it
- an audit review record exists

Approving another generation replaces the shot pointer but does not delete prior approvals/history.

### Machine review

Later OpenAI review uses:

```text
reviewer_type = AI
decision = RECOMMEND_APPROVE / RECOMMEND_REJECT
score_json
notes
```

AI recommendation can never satisfy the human approval invariant in V1.

---

## 21. Prompt Compilation

Prompt compilation is deliberately separated into two layers.

### Creative shot direction

Human-friendly:

```text
Koko counts berries one at a time.
He becomes excited, nearly drops the basket,
then catches it with a small comic bounce.
Medium-wide camera. Keep the action readable.
```

### Provider prompt

Generated from:

```text
creative direction
+ pinned character canon
+ pinned environment canon
+ style rules
+ camera rules
+ continuity constraints
+ model-specific prompting rules
```

Initially this compiler can be deterministic templates.

OpenAI prompt compilation is optional later.

This avoids making generation dependent on OpenAI during the foundation phases.

---

## 22. Rendering Architecture

Runware creates shots; it does not replace deterministic final assembly.

Final production needs:

- clip ordering
- precise trimming
- jingle/audio master
- audio normalization
- captions
- overlays
- intro/outro if used
- transitions where deliberately configured
- output codec/profile

Use FFmpeg.

### Worker boundary

Do not run long FFmpeg work inside the HTTP request that requested the render.

V1 does not require Redis.

Use PostgreSQL as the durable job coordination mechanism.

Conceptual flow:

```text
POST render request
      |
      v
Core creates rovelle_render_jobs row
      |
      v
worker claims job
FOR UPDATE SKIP LOCKED
      |
      v
worker downloads signed R2 inputs
      |
      v
FFmpeg
      |
      v
worker uploads final master to R2
      |
      v
worker marks render complete
```

The worker can run as a second Docker service from the same repository/codebase.

This provides process isolation without introducing a full microservice architecture.

---

## 23. Render Specification

A render job stores the deterministic recipe used to create the master.

Example conceptual structure:

```json
{
  "video": {
    "width": 1080,
    "height": 1920,
    "fps": 30,
    "codec": "h264"
  },
  "shots": [
    {"shotId": "1", "generationId": "14"},
    {"shotId": "2", "generationId": "17"}
  ],
  "audioAssetId": "41",
  "captionAssetId": "42"
}
```

The render spec is immutable per render attempt.

A rerender creates another attempt.

The final approved master is selected explicitly.

---

## 24. Publishing Domain

Publishing is controlled by Core.

Common conceptual interface:

```text
Publisher
  validate(...)
  publish(...)
  getStatus(...)
```

Implementations:

```text
YouTubePublisher
InstagramPublisher
TikTokPublisher
```

Publication state is per platform.

Example:

```text
EP-007

YouTube   PUBLISHED
Instagram PUBLISHED
TikTok    FAILED
```

The episode remains a valid production even if one platform fails.

A failed platform may retry independently.

---

## 25. Final Approval Gate

Publishing cannot start unless:

- all required shots have approved generations
- an approved final render exists
- episode is `PUBLISH_READY`
- explicit publish approval has occurred

V1 should expose one explicit command equivalent to:

```text
approve final master
```

followed by a separate command equivalent to:

```text
publish episode
```

This prevents accidental publish merely because rendering succeeded.

---

## 26. n8n Role

n8n remains useful but becomes a Core client for Rovelle.

Allowed responsibilities:

- Telegram trigger
- Telegram reply transport
- scheduled production summary
- failure notifications
- reminders
- simple HTTP Request chains
- platform analytics ingestion
- operational alerts
- external integrations that do not own Rovelle state

Example:

```text
Telegram
   |
   v
n8n
   |
   | POST /api/rovelle/shots/123/approve
   v
Core
   |
   v
PostgreSQL
```

n8n does not update PostgreSQL directly.

---

## 27. Domain Events to n8n

Core should expose meaningful production events instead of requiring n8n to poll tables.

Candidate events:

```text
rovelle.episode.created
rovelle.preflight.failed
rovelle.generation.started
rovelle.generation.completed
rovelle.generation.failed
rovelle.review.required
rovelle.shot.approved
rovelle.render.started
rovelle.render.completed
rovelle.render.failed
rovelle.publish.ready
rovelle.publication.completed
rovelle.publication.failed
```

### Reliability

Do not call n8n synchronously inside a database transaction and assume success.

Use a small PostgreSQL outbox pattern when event delivery is introduced:

```text
domain transaction
      |
      +-- update production state
      +-- insert outbox row
      |
    COMMIT
      |
      v
outbox dispatcher
      |
      v
n8n webhook
```

This keeps production truth valid even when n8n is down.

The outbox is not required in Phase 1.

---

## 28. OpenAI Role

OpenAI is optional and deliberately late.

Good uses:

- prompt compilation
- visual consistency review
- generation issue summaries
- metadata/caption generation
- platform copy variations
- production assistant explanations

OpenAI must not:

- own state
- assign canonical versions
- silently approve shots
- silently publish
- mutate production records without a deterministic Core command

If `OPENAI_API_KEY` is absent, core production/generation/rendering/publishing must still work.

---

## 29. Error Handling Principles

### Provider errors

Store normalized error details on the generation attempt.

Do not lose raw provider diagnostics needed for debugging.

### Retry

Retries create explicit attempts when creative generation is rerun.

Infrastructure retries of the same provider task must remain idempotent.

### Webhook duplicates

Must be safe.

### Storage failure

A generation callback saying "complete" is not enough if the expected R2 object does not exist.

Core should verify object presence before marking the output available.

### Partial publish

Per-platform state.

### Render failure

Keep failed render attempt and logs/summary; permit explicit retry.

### Core restart

All durable work must be recoverable from PostgreSQL/R2. In-memory state cannot be authoritative.

---

## 30. Observability

V1 should use structured application logs rather than introducing a new observability platform.

Every production log should include relevant identifiers:

```text
episodeId
shotId
generationId
providerTaskId
renderId
publicationId
```

Never log:

- Runware API key
- R2 secret key
- presigned URLs in full
- webhook secret
- social access tokens
- OpenAI key

---

## 31. Configuration Additions

Likely environment additions, introduced only in the phase that needs them:

### R2

```text
R2_ACCOUNT_ID
R2_ACCESS_KEY_ID
R2_SECRET_ACCESS_KEY
R2_BUCKET
R2_PRESIGN_TTL_SECONDS
```

### Runware

```text
RUNWARE_API_KEY
RUNWARE_WEBHOOK_TOKEN
CORE_PUBLIC_BASE_URL
```

### Rendering

```text
ROVELLE_RENDER_WORKER_ENABLED
ROVELLE_RENDER_POLL_INTERVAL_MS
FFMPEG_PATH
```

### Publishing

Platform credentials are introduced per publisher phase rather than all at once.

Do not add placeholder secrets to committed files.

`.env.example` receives names only.

---

# 32. Phased Delivery Design

The phases below describe **architecture checkpoints**, not the detailed implementation plan.

After this design is approved, Superpowers `writing-plans` should produce the exact implementation tasks, tests, commands, and file edits for **Phase 0/1 first**, not one giant execution plan for every phase.

That keeps Codex work compatible with the 5-hour usage window.

---

## Phase 0A — Prisma Platform Foundation

### Objective

Introduce Prisma as shared `nexus-core` infrastructure without changing Veyra/Aegis product behavior.

### Scope

- select and pin the approved Prisma major
- establish Prisma configuration and generated client
- add shared `PrismaModule` / `PrismaService`
- use PostgreSQL through the supported `pg` driver adapter when required by the selected Prisma major
- baseline/introspect the existing production schema safely
- establish Prisma migration ownership for new Rovelle tables
- make only module/runtime compatibility changes required by the chosen Prisma version
- retain existing `DatabaseService`
- retain existing Veyra/Aegis repositories
- no Rovelle product tables yet
- no external API calls
- no production migration application without explicit approval

### Critical compatibility gate

The current repository is CommonJS and runs Node 22.

If the selected Prisma version requires ESM, this phase owns that compatibility conversion and nothing else.

### Exit gate

```text
npm test
npm run lint
npm run build
```

all pass.

Additionally:

- Docker build succeeds
- NestJS boots
- Veyra/Aegis tests remain green
- a minimal Prisma connectivity test succeeds against a controlled PostgreSQL environment
- no existing feature has been rewritten to Prisma

### Codex sizing

One focused Terra-led window.

Use Luna Max for compatibility/test review only if needed.

---

## Phase 0B — Rovelle Guardrails and Module Foundation

### Objective

Make the repository safe for Rovelle domain implementation on top of the proven Prisma foundation.

### Scope

- add narrow Rovelle exception to `AGENTS.md`
- add `RovelleModule` shell
- register it in `AppModule`
- import shared `PrismaModule`
- establish Rovelle-specific configuration shape without credentials
- no Rovelle schema yet
- no external API call
- no production n8n changes

### Exit gate

Full tests, lint, build, and boot remain green.

### Codex sizing

Short Terra-led checkpoint.

---

## Phase 1 — Production Backbone

### Objective

Core can persist episodes and shots and enforce the production state machine.

### New durable concepts

- Prisma `RovelleEpisode` mapped to `rovelle_episodes`
- Prisma `RovelleShot` mapped to `rovelle_shots`

This is the first product migration created through the Prisma migration workflow.

### Capabilities

- create/read episode
- update approved brief
- define ordered shots
- explicit allowed episode transitions
- status query
- no generation yet
- no R2 yet

### Important restriction

Do not add canon, provider, render, or publisher tables prematurely.

### Exit gate

A test can create an episode with shots, transition it through valid early states, and prove invalid state jumps are rejected.

### Codex sizing

One main Terra window with at most one Luna Max worker for repository/test slices.

---

## Phase 2A — R2 Asset Registry

### Objective

Core can register assets and move media to/from private R2 through signed URLs.

### New durable concept

- `rovelle_assets`

### Capabilities

- create asset reservation
- produce short-lived upload URL
- confirm uploaded object
- generate short-lived read URL
- metadata query
- R2 object existence check

### Exit gate

Integration test against mocked S3 client plus a manual dev smoke test against the configured R2 bucket.

### Codex sizing

One window.

---

## Phase 2B — Canon Registry and Episode Pinning

### Objective

Rovelle knows which asset/version is canonical.

### New durable concepts

- `rovelle_canon_entities`
- `rovelle_canon_versions`
- `rovelle_canon_assets`
- episode/shot pinned canon references as required by final schema design

### Capabilities

- create canon entity/version
- attach reference assets
- lock version
- reject mutation of locked version
- pin version to episode/shot
- resolve references for preflight

### Exit gate

Koko V1 and one environment can be represented with multiple reference assets, locked, and pinned to a sample episode without storing any binary in PostgreSQL.

### Codex sizing

One window.

---

## Phase 3A — Runware Provider and Submission

### Objective

Submit a real generation through Core.

### New dependency

- official `@runware/sdk`

### New durable concept

- `rovelle_shot_generations`

### Capabilities

- provider abstraction
- Runware provider
- create generation attempt
- build R2 output key
- create presigned upload endpoint
- submit async request
- store provider task UUID
- cost estimate/request metadata when available
- no callback processing yet beyond test fixtures

### Exit gate

A manual non-production test can submit one inexpensive generation and confirm it receives a provider task identifier without n8n.

### Codex sizing

One focused window.

Luna Max is useful for SDK adapter tests while Terra owns integration boundaries.

---

## Phase 3B — Runware Webhook Completion

### Objective

Core receives provider completion securely and idempotently.

### Scope

- narrow global API guard bypass metadata
- dedicated Runware webhook guard
- webhook controller
- task lookup
- duplicate handling
- R2 output existence verification
- generation terminal state
- generation cost capture
- episode/shot aggregate reconciliation

### Exit gate

Tests prove:

- normal API routes still require Core API key
- webhook route does not accept arbitrary unauthenticated calls
- duplicate callback is harmless
- unknown task does not create data
- completed callback without R2 object does not become review-ready
- valid completion moves shot to review-required

### Codex sizing

One window.

This should not be combined with 3A if usage is already high.

---

## Phase 4 — Human Review, Regeneration, and Budget Visibility

### Objective

Complete the generation loop.

### New durable concepts

- `rovelle_reviews`
- cost fields/table if not already sufficient in generation table

### Capabilities

- approve generation
- reject generation
- regenerate shot
- preserve attempt history
- select approved generation
- calculate episode generation spend
- preflight budget enforcement
- review-required queries

### Exit gate

A shot can go through three generations, reject two, approve one, and report total spend correctly.

### Codex sizing

One window.

At the end of this phase Rovelle has a usable **generation MVP** even without rendering or publishing.

---

## Phase 5A — Render Job Model

### Objective

Create deterministic render specifications without running FFmpeg yet.

### New durable concepts

- `rovelle_render_jobs`
- `rovelle_renders`

### Capabilities

- validate all required shots are approved
- build immutable render spec
- enqueue render
- status/query/retry model
- no HTTP request blocks on media processing

### Exit gate

Render request produces a durable queued job referencing exact generation/audio/caption assets.

### Codex sizing

One short window.

---

## Phase 5B — FFmpeg Worker

### Objective

Produce the actual vertical master video.

### Runtime

A second process/container from the same repository.

### Capabilities

- atomically claim queued render job through PostgreSQL
- acquire R2 signed reads
- run FFmpeg
- capture safe failure summary
- upload master to R2
- mark render complete
- recover from process restart
- avoid duplicate job execution

### Exit gate

A test fixture episode renders into a valid MP4 and is registered as a Rovelle render asset.

### Codex sizing

One full window.

Luna Max is useful for FFmpeg command/test worker while Terra owns job semantics.

---

## Phase 5C — Final Review

### Objective

Separate successful rendering from publish readiness.

### Capabilities

- approve final master
- reject/rerender
- mark one render as approved
- transition episode to `PUBLISH_READY`

### Exit gate

No episode can become publish-ready merely because FFmpeg succeeded.

### Codex sizing

Small window; may be paired with 5B only if remaining usage is healthy.

---

## Phase 6 — YouTube Publisher MVP

### Objective

Publish one approved master through Core.

### New durable concept

- `rovelle_publications`

### Capabilities

- publisher interface
- YouTube implementation
- create publication attempt
- store external video ID
- poll/refresh status if required
- retry safely
- platform-specific failure state

### Exit gate

A manually approved test video can be uploaded by Core and the publication record contains the resulting YouTube identifier/state.

### Codex sizing

One window.

YouTube is deliberately first so the publishing abstraction is tested with one real platform before Instagram/TikTok are added.

---

## Phase 7A — Instagram Publisher

### Objective

Add Instagram without altering YouTube semantics.

### Exit gate

Same common publication contract, separate platform state.

### Codex sizing

One window.

---

## Phase 7B — TikTok Publisher

### Objective

Add TikTok and its platform-specific AI-content requirements/constraints.

### Exit gate

TikTok failure cannot affect YouTube/Instagram publication records.

### Codex sizing

One window.

---

## Phase 8 — n8n and Telegram Operations

### Objective

Make Rovelle operationally convenient without moving authority out of Core.

### Capabilities

- production summary endpoint
- review queue endpoint
- generation failure events
- render/publish events
- outbox delivery to n8n
- Telegram actions call Core commands

### Core remains authoritative

n8n receives and presents information.

It does not own production state.

### Exit gate

A Telegram approval path changes state only because n8n calls a Core endpoint.

### Codex sizing

Split into event-outbox and Telegram-contract windows if necessary.

---

## Phase 9 — Optional OpenAI Assistance

### Objective

Add AI only where deterministic production already works.

Possible slices:

### 9A Prompt compiler

Creative shot -> model-aware Runware prompt.

### 9B Visual QC

Reference + generated keyframes -> structured recommendation.

### 9C Metadata generation

Platform-specific title/description/caption.

### 9D Production explanation

Summarize recurring generation failures/cost.

Every subphase must be independently disableable.

---

# 33. Codex Execution Strategy

The implementation plan created after approval should be optimized for the user's Codex usage model.

## Terra role

Terra is the primary orchestrator.

Terra should:

- own the current phase
- read this design before starting
- read relevant repository code before editing
- create/maintain the task decomposition
- delegate only independent bounded tasks
- integrate worker changes
- run phase verification
- stop at the phase boundary
- leave a concise handoff if the 5-hour window is nearing reset

Terra must not delegate the architectural decision itself to workers.

## Luna Max role

Luna Max workers are best used for:

- isolated repository implementation
- provider adapter implementation
- focused tests
- FFmpeg worker details
- publisher implementation
- bounded review/fix passes

Workers should receive:

- exact phase
- exact owned files/domain
- invariant list
- test expectation
- explicit "do not expand scope"

## Parallelism rule

Parallel workers only when their file ownership is clearly non-overlapping.

Good:

```text
Luna worker A -> Runware adapter tests
Luna worker B -> R2 storage unit tests
Terra         -> integration/service boundary
```

Bad:

```text
multiple workers all editing rovelle.module.ts,
episode.service.ts, and the same migration
```

## Window rule

A phase should end with:

1. focused tests
2. full tests
3. lint
4. build
5. diff review
6. design invariant check
7. commit/checkpoint

Do not begin the next phase merely because unused time remains if doing so would create an unmergeable half-phase.

---

# 34. Testing Strategy

Every phase uses layers appropriate to the repository.

### Unit/service tests

State transitions, prompt/build logic, guards, provider normalization.

### Repository tests

SQL behavior should be tested with current repository conventions and/or controlled database fixtures when available.

### Provider tests

Mock Runware and S3 SDK boundaries.

Do not spend Runware credits during ordinary automated tests.

### Contract tests

Webhook payload fixtures and publisher response fixtures.

### Manual smoke tests

Required only at explicit gates that touch real external providers:

- R2
- Runware
- FFmpeg runtime
- YouTube
- Instagram
- TikTok

No external smoke test should happen implicitly during `npm test`.

---

# 35. Migration Safety

Rovelle migrations are additive.

Rules:

- new `rovelle_*` tables only during early phases
- no changes to Veyra tables for convenience
- migrations are committed as SQL documents using existing repo convention
- each phase introduces only tables it actually needs
- constraints/indexes are explicit
- destructive cleanup is deferred
- production migration execution requires separate explicit approval/deployment procedure

The design authorizes planning these migrations, not applying them to production.

---

# 36. Security

### Secrets

Never store credentials in PostgreSQL production records, logs, specs, or Git.

### Signed URLs

Treat R2 presigned URLs as bearer credentials.

Keep TTL short.

Never persist the full signed URL as the durable asset address.

Persist only the R2 object key.

### Runware webhook

Dedicated high-entropy secret.

### Social tokens

Provider-specific credential management is introduced only when the publisher is implemented.

### Public media

Production R2 should remain private by default.

Publishing may use temporary delivery URLs or platform upload APIs without exposing the entire bucket.

---

# 37. Failure Recovery

The system must survive:

- Core restart during generation
- duplicate Runware callback
- delayed Runware callback
- R2 transient error
- render worker crash
- n8n outage
- one social platform failure
- OpenAI outage
- Core process restart after job enqueue

Durable state in PostgreSQL/R2 is sufficient to recover.

No critical state is stored only in an n8n execution or Node memory.

---

# 38. V1 Success Criteria

Rovelle V1 is successful when this can happen:

```text
1. Create EP-001 in Core.
2. Add structured brief and shots.
3. Pin Koko V1 + environment/style canon.
4. Preflight passes.
5. Generate shots through Runware SDK.
6. Runware writes media to R2.
7. Core receives callback.
8. User reviews each attempt.
9. Regenerate one failed shot.
10. Approve one generation for every shot.
11. Render a final vertical MP4.
12. Approve the master.
13. Publish to YouTube.
14. Record publication state in Core.
15. n8n/Telegram can report all of the above without owning any state.
```

Instagram/TikTok and OpenAI are later capability phases, not blockers for the first production MVP.

---

# 39. Recommended MVP Cut Line

For fastest useful validation, the strongest first milestone is the end of **Phase 4**.

At that point Rovelle already owns:

- production state
- canon
- assets
- R2
- Runware generation
- webhook lifecycle
- review/regeneration
- cost visibility

That is enough to generate and review real Ringmaster episode shots.

The second milestone is the end of **Phase 6**:

- deterministic final render
- final approval
- YouTube publication

Instagram/TikTok can follow without risking the production core.

---

# 40. Decisions Locked by This Design

Unless revised during user review:

1. `nexus-core` remains the main backend.
2. Rovelle is a new top-level bounded context.
3. Core owns Rovelle orchestration.
4. n8n is auxiliary.
5. PostgreSQL remains the source of truth.
6. Prisma becomes the preferred data-access layer for new bounded-context persistence.
7. Existing Veyra/Aegis raw `pg` repositories remain supported and are not rewritten as part of Rovelle.
8. Shared `PrismaModule` lives outside `src/rovelle` so future Veyra features can adopt it.
9. Rovelle tables use `rovelle_` prefix.
10. R2 stores binary media.
9. Runware SDK integration is direct from Core.
10. Runware output should go directly to R2 when the selected model supports `uploadEndpoint`.
11. Runware callback is direct to Core.
12. webhook auth receives a narrow route-level exception from the global API-key guard.
13. generation provider is abstracted.
14. generation attempts are immutable history.
15. human creative approval remains mandatory.
16. FFmpeg is used for deterministic assembly.
17. rendering uses a separate worker process with PostgreSQL-backed job claiming.
18. publishing is abstracted per platform.
19. YouTube is implemented before Instagram/TikTok.
20. OpenAI is optional and late.
21. implementation is split into phase-sized Codex sessions.
22. Terra is implementation orchestrator.
23. Luna Max is delegated worker/reviewer, not the architectural owner.
24. no implementation plan is created until this specification is approved.

---

# 41. Open Review Questions

These are product choices that do **not** block approval of the architecture, but should be resolved before the relevant implementation phase.

1. Should one episode be allowed to have multiple approved final masters for A/B platform variants, or only one V1 master?
   - Design default: one approved master in V1.

2. Should generation budget be a hard stop or warning?
   - Design default: configurable hard stop per episode; no budget means warning-only development mode.

3. Should canon administration initially be API-only or exposed through Telegram?
   - Design default: API-only first.

4. Where should the render worker run?
   - Design default: second Docker service on the current VPS until load proves otherwise.

5. Should social publication default to immediate publish or schedule?
   - Design default: immediate after explicit publish command; scheduling remains n8n-triggered by calling Core at the scheduled time.

---

# 42. Approval Gate

No runtime implementation should begin from this document alone until the user reviews and approves it.

After approval:

1. invoke Superpowers `writing-plans`
2. create the detailed implementation plan for Phase 0A first
3. review and execute only Phase 0A
4. verify the Prisma platform checkpoint
5. create the Phase 0B + Phase 1 implementation plan
6. review each implementation plan
7. execute only the approved phase
8. verify and checkpoint
9. create/refine the next phase plan as needed

This keeps implementation aligned with both the architecture and the 5-hour Codex usage constraint.
