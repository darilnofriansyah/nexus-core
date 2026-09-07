# Rovelle Guided Telegram Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a Core-owned, private guided Telegram creator flow and replace RV-00's UUID command UX with thin Telegram transport.

**Architecture:** Prisma persists one creator session per Telegram operator plus opaque short-lived actions. A Creator module delegates to the existing production, asset, canon, generation, review, and render services. RV-00 only normalizes trusted Telegram updates, calls the Creator endpoint, acknowledges callbacks, and delivers Core-provided reply markup. Existing adapter workflows remain authenticated recovery paths.

**Tech Stack:** NestJS 10, Prisma/PostgreSQL, Node test runner, n8n MCP, Telegram Bot API.

**Spec:** `docs/superpowers/specs/2026-09-07-rovelle-guided-telegram-design.md`

## Global Constraints

- Keep Core authoritative for every Rovelle session, action, UUID, spend decision, and state mutation.
- Add only additive `rovelle_*` Prisma migration/schema changes.
- Core route is API-key protected: `POST /api/rovelle/creator/telegram`.
- Accept exactly one of `messageText` or `callbackToken`, with normalized `telegramUserId` and `chatId`.
- Telegram buttons contain opaque `rv:<token>` only. Never expose IDs, request UUIDs, prompts, private URLs, credentials, or provider errors.
- Trust only Telegram user/chat ID `976684739` in a private chat.
- `/new` collects manual directions; it makes no AI call and creates no spend before `Generate shot N · est. $0.22` is consumed.
- One consumed generation/regeneration action authorizes exactly one DRAFT provider submission. No refund and no automatic retry.
- Existing render worker/repository remains unchanged. Queue render only after every shot is approved and one available `AUDIO_MASTER` is selected.
- n8n does not persist conversation/action state, construct idempotency UUIDs, or call a provider.
- No production n8n publish or Core deploy without separate explicit approval.

---

### Task 1: Creator schema and action repository

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260907120000_rovelle_creator_session_actions/migration.sql`
- Create: `src/rovelle/creator/creator.repository.ts`
- Create: `src/rovelle/creator/creator.repository.spec.ts`

**Interfaces:**
- Produces `RovelleCreatorSession` keyed by `telegramUserId` and `RovelleCreatorAction` keyed by opaque token.
- Produces atomic `consumeButtonAction(token, telegramUserId)` and upload-action lookup/complete operations.

- [ ] **Step 1: Write failing repository tests**

Test a session upsert, user-bound action lookup, expired action rejection, first button consume, duplicate consume returning stored result, and a foreign Telegram user rejection. Use a fake Prisma transaction that asserts conditional `updateMany`/`update` conditions.

```ts
test("consumes a button once for its Telegram user", async () => {
  const result = await repository.consumeButtonAction({
    token: "short-token",
    telegramUserId: "976684739",
  });
  assert.equal(result.status, "consumed");
  assert.equal(fake.consumeCount, 1);
});
```

- [ ] **Step 2: Run RED**

Run: `npx tsc -p tsconfig.test.json && node --test dist-test/src/rovelle/creator/creator.repository.spec.js`

Expected: FAIL because creator repository/models do not exist.

- [ ] **Step 3: Add only schema required for state**

Define `RovelleCreatorSession` with UUID `id`, unique `telegramUserId`, string `step`, JSON `data`, and timestamps. Define `RovelleCreatorAction` with UUID `id`, unique opaque `token`, `telegramUserId`, string `kind`, JSON `payload`, `expiresAt`, nullable `consumedAt`, nullable JSON `result`, and timestamps. Add indexes on `(telegramUserId, expiresAt)` and `(expiresAt, consumedAt)`. Generate one additive SQL migration with matching UUID, JSONB, and timestamptz columns.

- [ ] **Step 4: Implement atomic repository operations**

Use a serializable transaction. Button consume must select by token/user/unexpired/unconsumed, set `consumedAt` once, and persist the safe result before returning. Upload actions may be read while pending; only their final confirmation consumes them. Do not place R2 URLs in either table.

- [ ] **Step 5: Run GREEN and commit**

Run focused repository tests, Prisma schema validation, and `git diff --check`. Commit only schema, migration, repository, and tests.

### Task 2: Creator DTOs, session state machine, and controller shell

**Files:**
- Create: `src/rovelle/creator/dto/creator.dto.ts`
- Create: `src/rovelle/creator/creator-validation.ts`
- Create: `src/rovelle/creator/creator.service.ts`
- Create: `src/rovelle/creator/creator.controller.ts`
- Create: `src/rovelle/creator/creator.module.ts`
- Create: `src/rovelle/creator/creator.service.spec.ts`
- Create: `src/rovelle/creator/creator.controller.spec.ts`
- Modify: `src/rovelle/rovelle.module.ts`

**Interfaces:**
- Consumes Task 1 session/action repository.
- Produces `POST /rovelle/creator/telegram` response `{text, inlineKeyboard?}`.

- [ ] **Step 1: Write failing validation/controller tests**

Cover exactly-one message/callback rule, decimal-string Telegram IDs, `rv:` callback prefix stripping, API envelope, and rejection before service call for malformed input.

```ts
await assert.rejects(
  () => controller.handle({ telegramUserId: "1", chatId: "1" }),
  /exactly one of messageText or callbackToken/,
);
```

- [ ] **Step 2: Run RED**

Run the new controller and service specs. Expected: FAIL because creator controller/module/service are absent.

- [ ] **Step 3: Implement narrow transport contract**

Normalize `/start`, `/new`, `/canon`, `/mywork`, `/audio`, ordinary text, and `rv:<token>` callbacks. Return plain text plus rows of `{text, callbackData}` or `{text, url}`; validate no row contains both. Create `CreatorModule`, import/export only existing required feature modules, and mount it in `RovelleModule`. Do not mark route public.

- [ ] **Step 4: Implement no-spend draft steps**

Persist steps: `IDLE`, `NEW_TITLE`, `NEW_DURATION`, `NEW_PREMISE`, `NEW_LEARNING_GOAL`, `NEW_TONE`, `NEW_CANON_CODES`, `NEW_SHOT_DIRECTIONS`, `DRAFT_READY`. Collect one direction per message; only `done` from a non-empty direction list reaches `DRAFT_READY`. Return a `Confirm draft` opaque action. No AI client, provider call, or episode mutation before confirmation.

- [ ] **Step 5: Run GREEN and commit**

Run creator specs plus existing Rovelle module specs. Commit Task 2 files.

### Task 3: Confirm draft and manual generation/review actions

**Files:**
- Modify: `src/rovelle/creator/creator.service.ts`
- Modify: `src/rovelle/creator/creator.repository.ts`
- Modify: `src/rovelle/creator/creator.service.spec.ts`
- Modify: `src/rovelle/creator/creator.repository.spec.ts`

**Interfaces:**
- Consumes existing `EpisodeService`, `CanonPinService`, `GenerationService`, and `GenerationReviewService`.
- Produces creator actions `CONFIRM_DRAFT`, `GENERATE_SHOT`, `APPROVE_GENERATION`, and `REGENERATE_SHOT`.

- [ ] **Step 1: Write failing action tests**

Cover confirm creating episode/brief/shots through existing services, locked canon-code validation, no spend at confirmation, exact `$0.22` generate label, one provider submission after action consume, duplicate paid callback safety, approve selection, and regenerate creating a new Core request UUID.

```ts
assert.match(reply.text, /Generate shot 1 · est\. \$0\.22/);
assert.equal(provider.submitCount, 0);
```

- [ ] **Step 2: Run RED**

Run creator service tests. Expected: FAIL because confirmed-draft and paid-action handlers are absent.

- [ ] **Step 3: Delegate existing domain rules**

On `CONFIRM_DRAFT`, generate a unique 32-character-or-less episode code, then call existing episode create, brief update, brief approval, preproduction start, shot replacement, canon pin, and ready-to-generate services in their required order. Store returned IDs in the Core session. Do not duplicate domain validation.

On `GENERATE_SHOT` or `REGENERATE_SHOT`, generate and persist one request UUID inside the consumed action result before calling `GenerationService.submitShot(shotId, {requestId, profile:"DRAFT"})`. Surface safe final state only. `APPROVE_GENERATION` delegates to `GenerationReviewService.submitHumanReview` with a Core-generated request UUID. Do not submit more than one shot per consumed action.

- [ ] **Step 4: Implement `/mywork`**

Read session episode/shot generation state. For reviewable generations, create `Approve shot` and cost-labelled `Regenerate shot · est. $0.22` action tokens. For ready shots, create only the next cost-labelled generate action. Never include source prompt, provider task ID, or private URL.

- [ ] **Step 5: Run GREEN and commit**

Run creator, production, generation, and generation-review focused specs. Commit Task 3 files.

### Task 4: One-time canon/audio upload page and render action

**Files:**
- Create: `src/rovelle/creator/creator-upload.controller.ts`
- Create: `src/rovelle/creator/creator-upload.service.ts`
- Create: `src/rovelle/creator/creator-upload.controller.spec.ts`
- Create: `src/rovelle/creator/creator-upload.service.spec.ts`
- Modify: `src/rovelle/creator/creator.module.ts`
- Modify: `src/rovelle/creator/creator.service.ts`
- Modify: `src/rovelle/creator/creator.service.spec.ts`

**Interfaces:**
- Consumes pending upload action and existing `AssetService`/`CanonService`/`RenderService`.
- Produces token-bound upload page, upload preparation/completion, and `QUEUE_RENDER` action.

- [ ] **Step 1: Write failing upload tests**

Cover foreign/expired token denial, GET response `Cache-Control: no-store`, image-only canon input, audio-only master input, asset confirmation before attachment, one completion, and action result that returns to Telegram without a private R2 URL.

- [ ] **Step 2: Run RED**

Run new upload specs. Expected: FAIL because upload service/controller do not exist.

- [ ] **Step 3: Implement the smallest mobile page**

Serve a minimal HTML page with one file input, upload button, and completion text at a token path. Its JavaScript posts to token-bound prepare and complete endpoints. Prepare uses `AssetService.reserve`/`createUploadUrl`; browser PUTs directly to R2. Complete uses `AssetService.confirmUpload`, then attaches canon asset or records available `AUDIO_MASTER` in the session. Apply `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, and no logging of token/query values.

- [ ] **Step 4: Add render decision**

Only when every shot has an approved generation and the session has an available audio master, return `Render episode`. Its action consumes one Core-generated request UUID and calls existing `RenderService.createRender`. Return queued render status only; no FFmpeg/provider execution in request.

- [ ] **Step 5: Run GREEN and commit**

Run creator upload/render focused tests and existing assets/canon/render specs. Commit Task 4 files.

### Task 5: Revamp RV-00 and extend recovery adapter

**Systems:**
- n8n workflow `5GKxG48lGVwhTBXR` — `Rovelle 00 - Operator Gateway`
- n8n workflow `jBrgmLgl1zXUjYSq` — `Rovelle 40 - Generation Commands`

**Interfaces:**
- Consumes Task 2 `POST /api/rovelle/creator/telegram` only for Telegram UX.
- Preserves authenticated command webhook and existing domain workflows for recovery.

- [ ] **Step 1: Read live workflow and node contracts**

Use n8n MCP SDK reference, human-in-the-loop/notification/data-transformation practices, Telegram Trigger/Telegram/HTTP Request/Code/Execute Workflow node definitions, then inspect both live workflows and active versions. Reuse existing Rovelle Telegram and Core Header Auth credentials.

- [ ] **Step 2: Draft RV-00 change**

Configure Telegram Trigger for `message` and `callback_query`. Normalize only allowlisted private updates to Core body. For a callback, acknowledge Telegram query and pass only stripped opaque token; for a text message pass exact text. Replace Telegram command parser/child dispatch branch with one fixed authenticated Core HTTP Request. Format only Core response text and inline keyboard; dynamically use authenticated source chat ID. Keep RV-00 webhook branch unchanged.

- [ ] **Step 3: Extend RV-40 recovery operation**

Add `generation.review` mapping for `POST /api/rovelle/generations/:generationId/reviews` to the authenticated internal/webhook adapter. Preserve request UUID validation and never add a Telegram direct UUID command.

- [ ] **Step 4: Validate and save drafts**

Validate each changed node before wiring and validate full workflows. Save updated workflow drafts with execution-data retention disabled, Aegis error workflow retained, no automatic retries for paid actions, and no publish. Test only safe `/start`/malformed callback paths after deployed Core availability is confirmed; never invoke generation, upload, or render in test.

- [ ] **Step 5: Document handoff**

Record deployed Core route prerequisite, exact n8n HTTP payload, callback-token handling, safe test cases, and the separate explicit publication gate in `docs/rovelle/guided-telegram-creator.md`.

### Task 6: End-to-end review and publication gate

**Files:**
- Modify: `docs/rovelle/guided-telegram-creator.md`
- Test: focused creator/asset/canon/generation/review/render tests and n8n workflow validation reports.

- [ ] **Step 1: Run Core verification**

Run the focused specs changed by Tasks 1–4 plus adjacent existing Rovelle tests. Run the repository's full suite in CI; local loopback smoke failure remains an environment diagnostic, not a feature regression unless it fails outside the sandbox.

- [ ] **Step 2: Request Core deploy verification**

Confirm the deployed Core responds to the new authenticated route before any n8n draft is published. Do not deploy from this task.

- [ ] **Step 3: Request publish approval**

Show saved workflow versions, validation result, allowed Telegram test matrix, and exact behavior of a paid button. Publish only after explicit user approval.
