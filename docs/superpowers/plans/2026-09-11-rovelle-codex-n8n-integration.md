# Rovelle–Codex–n8n Storyboard Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Terra High orchestrates; Luna Max implements bounded tasks. Do not start implementation merely because this document exists.

**Goal:** An authorized Telegram creator supplies a brief, receives a Codex storyboard, requests a revision, approves that exact revision, and recovers the saved episode plan through `/mywork`.

**Architecture:** Core owns immutable inputs, durable jobs, review actions, and episode application. A separate SDK worker claims and completes work through authenticated n8n forwarding routes. Telegram delivery never determines business success or whether Codex runs again.

**Tech Stack:** Existing NestJS, Prisma/PostgreSQL, TypeScript, Node `node:test`/`assert`, n8n, and a separately pinned `@openai/codex-sdk` dependency.

**Spec:** `docs/superpowers/specs/2026-09-11-rovelle-codex-n8n-integration-design.md`.

## Global constraints

- Planning baseline: checkout `586c494`, inspected 2026-09-11. Recheck at execution; this is not deployment evidence.
- The requested deliverable is this executable plan. It does not authorize implementation, production SQL, n8n MCP access, workflow changes, deployment, or paid smoke tests.
- Use automatic isolated execution as the concrete planning default. Manual handoff is not a second implementation in this plan.
- Phase-one acceptance stops at an approved saved episode plan. Image production and new video/render behavior require subsequent plans.
- Core owns state; n8n forwards and schedules; Codex proposes; the creator approves.
- Preserve the manual-shot path, existing generation/review/upload/render consumers, Veyra/Aegis behavior, private-user checks, and legacy `/rv`.
- No generic agent registry, provider abstraction, extra queue service, native creative subagents, or automatic approval/spending loop.
- Read `AGENTS.md`, `/home/unmeii/.codex/RTK.md`, `docs/veyra-database-schema.md`, actual Prisma models/migrations, and the spec before database work. Proposed models below are explicitly new Rovelle persistence.
- Do not run `npm build` or `npm run build` locally. Production build belongs in GitHub Actions. Test compilation is permitted.
- Preserve all pre-existing uncommitted/untracked files. In particular, `workflows/rovelle/creator-transport.cjs` and its test already exist locally; inspect and extend them, never overwrite them from the old plan.
- Run database tests only against a disposable isolated test database. Existing integration suites delete Rovelle rows. A skipped database suite is not a pass.

## Execution ownership and handoff

| Role | Model | Reasoning | Responsibility |
| --- | --- | --- | --- |
| Orchestrator and integration reviewer | `gpt-5.6-terra` | `high` | Baseline, contract freeze, task dispatch, dependency/file ownership, acceptance, integration |
| Implementer | `gpt-5.6-luna` | `max` | One bounded task, focused red/green checks, exact diff and evidence |
| Independent task reviewer | `gpt-5.6-luna` | `max` | Fresh context; verify spec compliance, then correctness/security/test quality |

These are development-agent settings, not assumed model identifiers or reasoning settings for the deployed creative SDK worker. Resolve that worker's actual available model during Task 1. Do not silently substitute another development model if either requested model is unavailable.

Start execution with Terra High selected in the app. A plan cannot change the current root model. Terra dispatches Luna using explicit overrides and bounded context:

```json
{
  "task_name": "rovelle_task_02_contract",
  "model": "gpt-5.6-luna",
  "reasoning_effort": "max",
  "fork_turns": "none",
  "message": "Implement Task 2 of docs/superpowers/plans/2026-09-11-rovelle-codex-n8n-integration.md. Read its Global constraints, frozen contracts, fixture, and Task 2 in full, plus the linked spec and applicable AGENTS/skills. Own only the listed Task 2 files. Run the named failing and passing checks. Do not alter workflows, deploy, call providers, or change shared contracts. Return changed files, test commands/results, and unresolved issues."
}
```

Use that template with the actual task number, file ownership, and dependency evidence. After each implementation: a fresh Luna reviews spec compliance, then code quality; Terra resolves findings before releasing dependent work. Reviewer messages are read-only and must include the actual diff, task requirements, and test evidence. Terra alone edits this plan's checkboxes and integration notes. Commit only task-owned files after review; never `git add .`. Do not commit unrelated user changes.

Dependency order:

```text
1 baseline/runtime contract
└─2 shared creative contract
  ├─3 persistence and lifecycle ─4 atomic intake ─5 review UI ─6 atomic approval
  └─7 SDK adapter and role ─8 durable worker transport
3 + 6 ─9 Core worker HTTP boundary
4 + 8 + 9 ─10 local n8n transport
6 + 10 ─11 full isolated acceptance
11 ─12 separately authorized rollout
```

Tasks 3 and 7 may run concurrently after Task 2 is reviewed. All creator edits are serialized. Task 9 owns module wiring and Core environment configuration, so it follows Task 6. At most two implementers plus Terra; reserve the fourth slot for a reviewer. Shared `package.json` and lockfile edits belong only to Tasks 7/8 in sequence; Task 11 alone owns any CI test changes.

## Decisions frozen for implementation

### Scope and compatibility

Add an opt-in `ROVELLE_CREATIVE_ENABLED=false` default. When off, the legacy creator behavior remains unchanged. When on, the existing `/new` brief flow offers **Draft with Codex — uses AI quota** and **Write shots myself** after canon selection. Both retain existing four-second increments. Automatic drafting accepts 4–120 seconds (1–30 shots); longer existing manual drafts remain supported. Explain this limit when presenting the choice.

Deduplication in this slice covers `/new` brief intake, choosing draft mode, creative feedback, creative preview/retry/approval callbacks, and creative `/mywork` responses. It does not retroactively promise atomic exactly-once semantics for legacy upload/provider/render actions. Keep those existing action contracts. Any broader receipt rollout needs its own review; do not wrap network/provider operations in a database transaction.

`updateId` is an optional decimal-string field for backwards compatibility, required before any enabled creative mutation. The server supplies a stable configured `ROVELLE_TELEGRAM_BOT_ID`; do not accept arbitrary bot identity from callers. Existing n8n branches must forward the real Telegram `update_id`. Same bot/update with different normalized content is HTTP 409, not a replay. Same content returns the saved reply, including original opaque tokens.

### Types and limits — Task 2 owns these definitions

Place wire types in `src/rovelle/creative/dto/creative.dto.ts`. These are plain types with no NestJS/Prisma imports, safe for the worker to import.

```ts
export interface CreativeInput {
  schemaVersion: 1;
  inputRevision: number;
  title: string;
  targetDurationSeconds: number;
  premise: string;
  learningGoal: string;
  tone: string;
  canon: Array<{
    entityId: string;
    versionId: string;
    code: string;
    definition: Record<string, unknown>;
  }>;
  previousResult: CreativeResult | null;
  feedback: string | null;
}
export interface CreativeResult {
  synopsis: string;
  script: string;
  shots: Array<{
    sequence: number;
    durationSeconds: 4;
    direction: string;
    narration: string;
    imagePrompt: string;
  }>;
}
export interface CreativeExecutionMetadata {
  instructionVersion: "storyboard-v1";
  sdkVersion: string;
  model: string;
  threadId: string | null;
  usage: { inputTokens: number; cachedInputTokens: number; outputTokens: number } | null;
}
export type CreativeExecutionOutcome = {
  metadata: CreativeExecutionMetadata;
} & (
  | { status: "COMPLETED"; result: CreativeResult }
  | { status: "FAILED"; errorCode: "AUTH_FAILED" | "INVALID_OUTPUT" | "EXECUTION_FAILED" }
);
export type CreativeCompletion = CreativeExecutionOutcome & {
  attemptToken: string;
  inputHash: string;
};
export interface CreativeExecutionRequest {
  jobId: string;
  task: "STORYBOARD";
  input: CreativeInput;
  inputHash: string;
}
export type CreativeClaim =
  | { claimed: false }
  | {
      claimed: true;
      jobId: string;
      task: "STORYBOARD";
      attemptToken: string;
      inputHash: string;
      leaseExpiresAt: string;
      input: CreativeInput;
    };
```

Required runtime validators:

```ts
normalizeCreativeInput(value: unknown): CreativeInput;
normalizeCreativeResult(value: unknown, input: CreativeInput): CreativeResult;
normalizeCreativeCompletion(value: unknown, input: CreativeInput): CreativeCompletion;
hashCreativeValue(value: unknown): string;
```

Use SHA-256 of deterministic recursively key-sorted JSON; preserve array order. Reject non-JSON values. Normalize input before hashing and persist it once. Normalize completion before computing replay digest. Tokens use 32 cryptographically random bytes, base64url encoding; never log them.

Reject unknown keys at every wire object, arrays where objects are expected, non-finite/non-integer numbers, empty required text, invalid UUIDs, unbounded decimal IDs, and oversized payloads. Limits: title 200; premise/learningGoal/tone/feedback 2,000 each; synopsis 2,000; script 12,000; direction 4,000; narration 2,000 (empty permitted); imagePrompt 4,000; at most 16 canon pins and 64 KiB serialized canon definitions; input/completion at most 512 KiB UTF-8. Configure the creative HTTP body limit explicitly without lowering unrelated route limits.

Shots must be ordered `1..N`, every duration exactly 4, sum exactly the immutable target, no extra/missing shots. No model-returned canon IDs or tool instructions are accepted. Core supplies the pinned reference list; free prose cannot be mechanically certified canon-consistent, so human review remains required. Version/hash comparisons enforce identity, not semantic story quality.

Transport `COMPLETED` maps explicitly to persisted `SUCCEEDED`; they are intentionally different enums. Metadata is bounded (version/model/thread strings ≤128, nonnegative safe integer token counts); usage may be unavailable and is not a dollar cost or billing guarantee.

### Persistence — exact additive shape

Task 3 creates `RovelleCreativeJob` mapped to `rovelle_creative_jobs` and `RovelleTelegramReceipt` mapped to `rovelle_telegram_receipts`, plus `RovelleCreativeJobStatus` with `QUEUED`, `RUNNING`, `SUCCEEDED`, `FAILED`, `OUTCOME_UNKNOWN`.

| Job field | Prisma shape / behavior |
| --- | --- |
| `id` | String UUID primary key, default UUID |
| `creatorSessionId` | UUID FK to `RovelleCreatorSession.id`, Restrict delete |
| `telegramUserId`, `chatId` | String VarChar(32), copied from authorized intake |
| `inputRevision` | Int, positive |
| `task` | String VarChar(32), exactly `STORYBOARD` |
| `input`, `inputHash` | Json, String VarChar(64), immutable |
| `status` | enum, default QUEUED |
| `attemptTokenHash` | nullable String VarChar(64); never expose on reads |
| `leaseExpiresAt` | nullable Timestamptz(6) |
| `result`, `completionMetadata`, `completionResponse` | nullable Json |
| `completionHash` | nullable String VarChar(64) |
| `failureCode` | nullable String VarChar(64) |
| `supersededAt` | nullable Timestamptz(6) |
| `episodeId` | nullable unique UUID FK to `RovelleEpisode.id`, Restrict delete |
| `approvedAt` | nullable Timestamptz(6) |
| `createdAt`, `updatedAt` | Timestamptz(6), existing defaults/conventions |

Add reverse relation arrays to creator session and optional reverse relation on episode. Add unique `(creatorSessionId, inputRevision)`, index `(status, createdAt, id)`, index `(telegramUserId, createdAt)`. New SQL columns use snake_case `@map` names consistently. Add CHECKs for positive revision, task, and coherent approval (`approved_at` and `episode_id` both null or both non-null).

Receipt fields: `id` UUID PK; `botId`, `updateId`, `telegramUserId`, `chatId` VarChar(32); `requestHash` VarChar(64); `response` Json; `createdAt` Timestamptz(6). Unique `(botId, updateId)`. No PROCESSING receipt state: insert the completed receipt in the same transaction as the creative mutation. Exceptions roll back both. Persist no raw Telegram update, bearer URL, or provider log.

Use a migration-owned partial unique index for one unresolved execution per creator:

```sql
CREATE UNIQUE INDEX rovelle_creative_jobs_one_active_creator
ON rovelle_creative_jobs (telegram_user_id)
WHERE status IN ('QUEUED', 'RUNNING', 'OUTCOME_UNKNOWN');
```

Unknown outcomes block another job until an explicit user retry resolves the old row to FAILED with `failure_code='RETRY_AUTHORIZED_OUTCOME_UNKNOWN'` and creates the next revision in the same transaction. This records the acknowledged duplicate-cost risk. A definitive FAILED result requires an explicit retry too. Never retry model execution automatically.

Core transactions serialize on the creator session row; job operations use conditional writes and serializable transactions with at most three retries for genuine transaction-conflict errors only. Reuse the existing `CreatorRepository` conflict classification, extracting it only if both repositories need it. No shared generic unit-of-work framework.

On new brief or revision after a resolved job: increment revision, replace the session's current job pointer, invalidate prior creative buttons, and mark the old job superseded. A queued superseded job becomes FAILED (`SUPERSEDED_BEFORE_START`). While a job is RUNNING or OUTCOME_UNKNOWN, reject `/new`, mode changes, and feedback edits with a recovery reply; do not change the session input, revision, or pointer. This launch constraint avoids a second pending-input state. Explicit unknown-outcome Retry copies the old immutable input, increments its revision exactly once, resolves/supersedes the old job, and creates the replacement atomically. An identical Telegram/action replay returns that same replacement. The creator can edit again after the active outcome is resolved. Test edit-versus-claim races under the same session lock.

### Lifecycle and HTTP contracts

- Lease: 10 minutes, no heartbeat in this slice. Worker execution timeout: 8 minutes. An elapsed lease becomes OUTCOME_UNKNOWN, never QUEUED. `/mywork`, claim, and queued discovery each reconcile expired leases through Core.
- Claim atomically changes QUEUED to RUNNING and returns a fresh attempt token once. Duplicate claim is `{claimed:false}`. If the claim response is lost, do not issue another token or run Codex: the job becomes unknown and follows explicit recovery.
- A completion with the same normalized digest and correct token returns the stored reply. Changed completion is 409. Wrong token is 403. Unknown job is 404. Invalid schema is 400. Unknown task or input hash mismatch is 409.
- A retained completion can resolve OUTCOME_UNKNOWN with the original token only before the user authorizes replacement. After replacement/supersession it cannot become an approvable result.
- List queued work: oldest first, fixed maximum 20, `status=QUEUED` only, `{jobs:[{id}]}`. Do not return user text, tokens, or context. Exclude superseded/ineligible jobs.
- Core routes: `POST /api/rovelle/creative-jobs/:id/claim`, `POST /api/rovelle/creative-jobs/:id/result`, `GET /api/rovelle/creative-jobs?status=QUEUED`.
- Use `{ok:true,data:...}` envelopes and explicit HTTP 200 for Core success. Result data is `{chatId,reply:{text,inlineKeyboard?}}`; destination is loaded from Core, never supplied by worker output.
- These three routes use a dedicated fail-closed `x-rovelle-worker-key` guard, skipping the broad global Core-key guard with the existing decorator. n8n holds this key; the SDK subprocess does not. Missing configuration must deny access, unlike the existing global guard's development fallback.
- n8n→worker: `POST /jobs`, `{jobId}` only, dedicated `x-codex-dispatch-key`, HTTP 202 once accepted for local processing. Invalid UUID 400, unauthorized 401, local capacity full 503. A replay of a locally accepted ID returns 202 without another run.
- worker→n8n: fixed authenticated `/webhook/rovelle-codex-claim` and `/webhook/rovelle-codex-result` routes; n8n forwards to the static Core routes. Separate `x-codex-callback-key`; no redirects, arbitrary URLs, or caller-provided path suffixes beyond validated job UUIDs.
- Short transport timeout: 10 seconds; dispatch responds before generation. Result forwarding must return the Core acknowledgement to worker before attempting Telegram delivery. A Telegram failure never changes job success and never reruns Codex.

### Approval/application boundary

New creative approvals bypass legacy `confirmDraft`; leave that manual path's existing behavior intact. Keep the saved creative episode at PREPRODUCTION with ordered shots and pinned locked canon. Store `synopsis`, `script`, complete storyboard (including narration/imagePrompt), `creativeJobId`, and revision in existing episode `brief` JSON alongside premise/learningGoal/tone/canonCodes. No invented shot columns.

One transaction verifies owner/current revision/success/not superseded, consumes the exact action token, calls transaction-aware existing episode/canon domain operations, stores `episodeId`/`approvedAt`, advances creator session to IDLE with that episode ID, and stores the receipt and reply. All-or-nothing application eliminates the old create/checkpoint crash window for this new path. Keep existing standalone repository transactions for old callers.

No video preflight, generation submission, asset mutation, render call, or provider call occurs here. `/mywork` says “Episode plan saved” and returns the same episode ID. It does not expose generation controls for this new plan in phase one. Existing operator APIs continue to work independently.

## Common test workflow and fixture

Every task follows: add the named failing assertion, compile/run and observe the intended failure, implement the specified boundary, compile/run again, review, commit only owned files. Compilation failures from missing planned symbols count for the initial contract task; behavioral tasks must fail on the target assertion. Use existing Node tests, no new test framework.

```bash
rtk npm run prisma:generate
rtk proxy npx tsc -p tsconfig.test.json
rtk proxy node --test --test-concurrency=1 dist-test/src/rovelle/creative/creative-validation.spec.js
rtk git diff --check
```

Substitute the exact test file named in each task for the third command. The full test command is `rtk npm test`; run once at final integration, not after every edit. New DB tests must use `ROVELLE_TEST_DATABASE_URL` with an explicitly verified disposable DB, clean only their own fixtures, and fail the release gate when absent. Never point test cleanup at `DATABASE_URL` from a deployed service.

Task 2 creates this test fixture in `src/rovelle/creative/creative.fixture.ts` for test-only imports (or embeds it in the spec if that avoids cross-suite use; worker tests may import the shared fixture only in tests):

```ts
import type { CreativeInput, CreativeResult } from "./dto/creative.dto";
export const creativeInput: CreativeInput = {
  schemaVersion: 1, inputRevision: 1, title: "Sharing", targetDurationSeconds: 4,
  premise: "Two friends share a toy.", learningGoal: "Taking turns", tone: "Warm",
  canon: [], previousResult: null, feedback: null,
};
export const creativeResult: CreativeResult = {
  synopsis: "Two friends learn to take turns.", script: "One toy, two happy friends.",
  shots: [{ sequence: 1, durationSeconds: 4, direction: "Wide shot of friends sharing.",
    narration: "There is a turn for everyone.", imagePrompt: "A warm scene of two friends." }],
};
```

## Task 1: Establish execution baseline and runtime evidence

**Owner:** Terra High; Luna may inspect SDK types as a read-only bounded assignment.

**Files:** Read `AGENTS.md`, spec, this plan, `package.json`, `tsconfig*.json`, `src/render-worker/main.ts`, `src/common/guards/api-key.guard.ts`, current workflow helpers. Create `docs/rovelle/codex-runtime-verification.md` during execution.

**Interfaces:** Produces a recorded exact SDK/runtime version, verified import strategy, runtime-model setting, isolation configuration, and test baseline. Does not change the frozen business contract.

- [x] Record `rtk git status --short` and `rtk git log -1 --format='%h %s'`. Use the worktree skill when execution starts; carry required untracked source/design files explicitly, preserve originals, and do not assume they appear in a new worktree.
- [x] Run existing creator/production tests through test compilation and record failures separately from changes. Check `ROVELLE_TEST_DATABASE_URL` availability without printing secrets. Missing DB blocks database acceptance, not pure contract work.
- [x] Resolve/fetch current official Codex SDK documentation with Context7, at most three CLI commands per question, outside sandbox as required by AGENTS. Inspect the exact package types/export map in a temporary directory; do not guess CommonJS support.
- [x] Record exact package version and bundled CLI/runtime version before pinning. Verify a native dynamic ESM import if required by the current CommonJS build; use a worker-specific NodeNext `.mts` boundary only if ordinary import cannot load. Prove the selected strategy in compiled test output, not just TypeScript acceptance. Do not migrate the whole project to ESM.
- [x] Configure a required `CODEX_CREATIVE_MODEL` contract for the deployed worker. The task can verify types/configuration without a live model call. A real isolated structured-result smoke needs authorized credentials and permission to incur usage; if unavailable, mark that one check pending and continue mocked implementation.
- [x] Record actual supported isolation/tool settings and observed usage fields. No assumed SDK `maxTurns` or dollar-budget argument. One SDK execution per claim, timeout, bounded input/output, and external account controls are the launch limits; label the absence of a hard per-job billing cap.

**Gate:** Terra confirms package-loading strategy before Task 7. Production SDK capability remains unverified until the real smoke passes. No deployment or n8n inspection is needed for Tasks 2–11.

## Task 2: Freeze and test creative input/output contract

**Owner:** Luna Max. **Depends:** 1.

**Files:** Create `src/rovelle/creative/dto/creative.dto.ts`, `creative-validation.ts`, `creative-validation.spec.ts`, `creative.fixture.ts` under the same creative directory.

**Interfaces:** Produces the four validators/hash function and wire types defined above. Export `creativeOutputSchema` from `creative-validation.ts` only if it can stay dependency-free; otherwise put that constant in `dto/creative.dto.ts`. Core runtime validation remains mandatory.

- [ ] Add the fixture and this initial behavioral test, then run the common commands:

```ts
import * as assert from "node:assert/strict";
import { test } from "node:test";
import { creativeInput, creativeResult } from "./creative.fixture";
import { normalizeCreativeResult } from "./creative-validation";
test("rejects an otherwise valid storyboard with the wrong duration", () => {
  assert.throws(() => normalizeCreativeResult({ ...creativeResult,
    shots: [{ ...creativeResult.shots[0], durationSeconds: 8 }] }, creativeInput));
});
```

- [ ] Implement the exact definitions/limits above using existing string/object validation style and `node:crypto`; no new validation library. Generate a strict JSON Schema with `additionalProperties:false` and all required fields for SDK output.
- [ ] Add table-driven assertions for unknown top-level/nested keys, sequence gap/duplicates/order, target mismatch, text/byte caps, null/array input, invalid canon UUID, non-JSON definition, metadata limits, malformed token/hash, and stable hash across reordered object keys.
- [ ] Run `creative-validation.spec.js`; all valid fixture fields round-trip, including empty narration and full script. Terra freezes exports before parallel tasks start.

## Task 3: Add durable jobs and atomic lifecycle

**Owner:** Luna Max. **Depends:** 2.

**Files:** Modify `prisma/schema.prisma`; create `prisma/migrations/20260911120000_rovelle_creative_jobs/migration.sql` (choose a later unique timestamp only if occupied); create `src/rovelle/creative/creative.repository.ts`, `creative.repository.spec.ts`, `creative.integration.spec.ts`.

**Interfaces:** `CreativeRepository.claim(jobId: string, now: Date): Promise<CreativeClaim>`, `complete(jobId: string, completion: CreativeCompletion, now: Date): Promise<{chatId: string; reply: CreatorTelegramReply}>`, `listQueued(now: Date): Promise<Array<{id: string}>>`. Intake creates jobs inside its shared transaction in Task 4; repository exports a transaction-client-based `createQueued` method with input `{sessionId,telegramUserId,chatId,input}`. It computes/stores the hash, never trusts a caller's hash.

- [ ] Write a DB test that concurrently claims one queued fixture and asserts exactly one `claimed:true`; first demonstrate missing model/lifecycle failure. Use fixture-scoped cleanup in FK order.
- [ ] Add the models, relations, checks, partial unique index, and migration described above. Review generated SQL: additions to Rovelle only; no Veyra drift, enum recreation, or destructive schema changes. Validate/generate Prisma. Apply only to the verified disposable DB using the existing migration workflow.
- [ ] Implement claim with a guarded QUEUED update inside the transaction; generate token only for the successful claim and persist its SHA-256. For completion lock/read the job, verify attempt token/hash/metadata/schema, save output and completion response atomically. The response can initially be the deterministic `/mywork` recovery reply; Task 5 supplies review buttons without changing replay identity after first commit.
- [ ] Implement expired-lease reconciliation and bounded queued discovery exactly as frozen. Reject unknown `status` filters in Task 9. Never move an expired job back to QUEUED.
- [ ] Add DB assertions: parallel creates enforce active-job index; one creator cannot claim twice; identical result replay gives identical response; conflicting replay/wrong token/input hash rejected; expired RUNNING becomes unknown; retained result resolves unknown; explicitly replaced attempt cannot apply; superseded results remain unapprovable.

Concrete concurrency assertion inside the DB suite (the test creates a real queued row and uses the real repository):

```ts
const claims = await Promise.all([repository.claim(job.id, now), repository.claim(job.id, now)]);
assert.equal(claims.filter((claim) => claim.claimed).length, 1);
```

**Checks:** `creative.repository.spec.js`, `creative.integration.spec.js`, `rtk npm run prisma:validate`. Report DB test count and skips explicitly.

## Task 4: Make creative intake and Telegram receipts atomic

**Owner:** Luna Max. **Depends:** 3.

**Files:** Modify `src/rovelle/creator/dto/creator.dto.ts`, `creator-validation.ts`, `creator-validation.spec.ts`, `creator.service.ts`, `creator.repository.ts`; create `creator-creative.service.ts`, `creator-creative.service.spec.ts`, `creator-creative.integration.spec.ts` in `src/rovelle/creator/`.

**Interfaces:** `CreatorCreativeService.handle(request: CreatorTelegramRequest): Promise<CreatorTelegramReply | null>` returns null only for legacy paths. `CreatorTelegramReply` gains optional `creativeJob: {id:string; action:"DISPATCH"}`. Its handler is called after existing private-user/chat authorization and before legacy routing. The creative handler does not import CreatorService (avoid circular injection).

- [ ] Extend request normalization to preserve/validate optional `updateId` on both message and callback branches. Test zero-valued update string, oversized ID, numeric instead of string, and callback prefix stripping unchanged.
- [ ] Extract only `/new` brief progression needed by both routes into a pure helper if required to avoid a second wizard. Keep legacy manual confirmation/provider operations outside the creative handler. Add the mode choice and `CREATIVE_FEEDBACK`/`CREATIVE_REVIEW` session steps; store `creativeInputRevision` and `creativeJobId` in session JSON, not new unrelated tables.
- [ ] Implement receipt processing in one serializable transaction: authorize already checked; find same bot/update; verify request hash; return stored response on replay; lock/upsert current session; perform local progression/action/job writes; store full reply receipt. A uniqueness/serialization conflict retries the whole transaction at most three times. No provider calls inside the closure.
- [ ] On Draft with Codex, resolve selected canon versions to their currently LOCKED exact IDs/definitions in the same snapshot transaction. Empty selected canon remains allowed for a text-only plan. Never select newer versions during revision or approval. Add queued job and response dispatch metadata in the same commit.
- [ ] Add regression assertions that duplicate delivery does not turn the title into the duration answer, two concurrent Draft clicks create one job, same update with changed text is 409, bot identities are server-owned, missing updateId cannot start creative work, manual path retains its 3600-second limit, and changed brief invalidates prior buttons/results.

```ts
assert.deepEqual(await service.handle(request), await service.handle(request));
assert.equal(await prisma.client.rovelleTelegramReceipt.count({ where: { botId, updateId: request.updateId } }), 1);
assert.equal((await prisma.client.rovelleCreatorSession.findUniqueOrThrow({ where: { telegramUserId } })).step, "NEW_DURATION");
```

Use an authorized title-answer request after setup for the assertion above. Include rollback injection between session write and receipt insert: neither change may persist. Check legacy creator test suite in addition to both new suites.

## Task 5: Full preview, revision, and explicit unknown-outcome retry

**Owner:** Luna Max. **Depends:** 4.

**Files:** Modify `creator-creative.service.ts` and its tests; create `src/rovelle/creative/creative-preview.ts`, `creative-preview.spec.ts`; modify `creative.repository.ts` completion-response construction.

**Interfaces:** `renderCreativePages(input: CreativeInput, result: CreativeResult): string[]`; creative actions use existing `RovelleCreatorAction` with payload `{jobId,inputRevision,inputHash,page}` and kinds `CREATIVE_PAGE`, `CREATIVE_REVISE`, `CREATIVE_APPROVE`, `CREATIVE_RETRY`.

- [ ] Write a preview test that concatenates page bodies and finds the complete synopsis/script/every shot direction/narration/imagePrompt, including a 12,000-character script. Test emoji near split boundaries. Each Telegram text is at most 3,500 UTF-16 code units including labels; split at code-point boundaries, never truncate content.
- [ ] Persist opaque page/action buttons with normal action TTL and owner/revision/hash binding. First completion response contains first page; `/mywork` can regenerate expired page tokens from the stored exact revision. Next/Previous navigation is deterministic. Only the final page offers Approve plan; expose it only after earlier page navigation has been recorded for that job/revision. For a single-page result, serving page 1 satisfies this gate and that same reply includes Approve. For multiple pages, record page 1 when the first reply is committed and subsequent pages when navigation replies commit. This proves content was made available, not that a human read it. Test both one-page and multi-page approval explicitly.
- [ ] Record review progress in session JSON for the current job only. Revision/new brief resets it. Reject forged page indexes, cross-owner actions, expired actions, superseded jobs, and mismatched revision/hash. Return saved responses on identical receipt replay.
- [ ] Revise stores feedback, creates a new job/revision using the same locked canon snapshot plus the previous validated output, invalidates prior buttons, and returns dispatch metadata. One execution per explicit revision. No director/writer multi-call loop.
- [ ] For FAILED offer explicit Retry. For OUTCOME_UNKNOWN show “The previous run may have used AI quota. Retry may use quota again.” A separate opaque Retry button acknowledges that risk; atomically resolve old attempt and create the new revision. No automatic retries on `/mywork` or queued discovery.
- [ ] Test all page content accessible before approval, one revision after duplicate feedback, old approval fails after revision, unknown outcome blocks new dispatch until explicit retry, and result replay returns the originally stored response.

**Checks:** `creative-preview.spec.js`, `creator-creative.service.spec.js`, `creator-creative.integration.spec.js`, `creative.integration.spec.js`.

## Task 6: Apply an approved plan in one database transaction

**Owner:** Luna Max. **Depends:** 5. Terra reviews the transaction seam before implementation.

**Files:** Modify `src/rovelle/production/episode.service.ts`, `episode.repository.ts` and their specs; `src/rovelle/canon/canon-pin.service.ts`, `canon-pin.repository.ts` and their specs; create `src/rovelle/creative/creative-approval.service.ts`, `creative-approval.integration.spec.ts`; modify `creator-creative.service.ts` and its tests.

**Interfaces:** `CreativeApprovalService.approve(tx: Prisma.TransactionClient, input: {telegramUserId:string; token:string}): Promise<CreatorTelegramReply>`. It runs inside Task 4's receipt transaction. Add optional trailing `tx?: Prisma.TransactionClient` only to existing episode methods needed below and `CanonPinService.pinEpisode`/repository reads; production callers keep existing signatures. Repository code uses `tx ?? prisma.client` and runs inner transactions only when no transaction was supplied. Never cast a transaction into PrismaService or mutate singleton repository state.

- [ ] Before adapting anything, add a failure-injection characterization of legacy `confirmDraft` immediately after episode creation and before `persistConfirmation`. Record the duplicate/orphan risk; do not claim checkpoints make that sequence atomic. The new path must not call it.
- [ ] Pass the same optional transaction through `createEpisode`, `getEpisode`, `updateBrief`, `approveBrief`, `startPreproduction`, `replaceShots`, and canon pin/read operations. Factor each existing transaction closure into a local function and execute it directly when `tx` is provided. Preserve validators, transition guards, and standalone transactions for existing callers.
- [ ] Implement approval owner/revision/token/preview-progress checks, then use this exact operation order within the outer receipt transaction:

```text
lock creator session and current job; replay stored approval if already approved
verify pending CREATIVE_APPROVE action matches successful unsuperseded job/hash/revision
create episode with Core-generated code (<=32 chars)
update brief with original fields plus synopsis/script/storyboard/job ID/revision
approve brief; start preproduction; replace ordered four-second shots
pin every immutable selected locked canon version
persist job episodeId/approvedAt; consume action and invalidate sibling creative actions
persist session IDLE + episodeId + saved creative job reference; return saved-plan reply
outer caller inserts Telegram receipt; commit once
```

- [ ] Inject failure after every mutation, especially after episode create and shot replacement. Assert no episode/job approval/action consumption/receipt survives rollback. Re-run the same request and assert exactly one episode and one shot set. Concurrent approvals with different update IDs still create one episode; duplicate token returns the stored saved-plan reply.
- [ ] Assert episode PREPRODUCTION, complete JSON content preserved, pinned versions unchanged, no generation/preflight/render calls, and missing video images do not turn saved-plan success into failure. Manual creator/generation regression tests remain green.

**Checks:** `creative-approval.integration.spec.js`, existing episode/canon repository/service specs, `creator.service.spec.js`, new creator creative suites. DB rollback tests are mandatory acceptance evidence.

## Task 7: Single-execution SDK adapter and fixed creative role

**Owner:** Luna Max. **Depends:** 1 and 2; may parallel Task 3.

**Files:** Modify `package.json`, `package-lock.json` only for the pinned SDK; create `src/codex-worker/codex-executor.ts`, `codex-executor.spec.ts`, `creative-role.ts`, `worker-config.ts`, `worker-config.spec.ts`. If Task 1 proves a separate ESM boundary necessary, list its exact `.mts`/test compiler changes in the runtime evidence before editing.

**Interfaces:** `executeStoryboard(request: CreativeExecutionRequest, config: WorkerConfig): Promise<CreativeExecutionOutcome>`. `WorkerConfig` has required model and exact runtime version metadata, execution timeout (480000 ms), work directory, and explicit child environment allowlist. Task 8 transport converts its claimed context into this token-free request. Transport credentials are not part of the SDK child environment.

- [ ] Add a fake SDK dependency through a small function parameter, not a provider hierarchy. Test that unknown task rejects before starting a thread, one claim makes one run, strict output schema is passed, output is validated, and metadata captures instruction version and actual usage.
- [ ] Pin the verified exact SDK version; use its direct SDK execution, no custom CLI wrapper. The established SDK surface supports `thread.run(prompt, {outputSchema, signal})`; `signal` is the timeout cancellation mechanism. Inspect the pinned types for thread sandbox/approval options rather than inventing fields.
- [ ] Implement `storyboard-v1` as a version-controlled TypeScript string: combine director and writer duties, preserve supplied locked canon, return only schema JSON, no approvals/spending/deployment/tool use, and treat user fields as delimited data rather than permissions. No user-controlled instruction file paths, model choice, role names, URLs, or tools.
- [ ] Use a clean per-job work directory and clean dedicated Codex configuration/home. No production checkout, DB credential, n8n key, Core key, Docker socket, host user config, plugins, or MCP servers are visible to the SDK subprocess. Read-only workspace and no approval prompts; disable command/tool/network capabilities using supported configuration plus OS isolation. Prompt text alone is not an isolation control. If forbidden tools cannot be disabled/enforced, stop runtime release rather than weaken this requirement.
- [ ] Pass a bounded serialized immutable input; run once; parse `finalResponse`; validate with Task 2; map definitive errors to controlled codes. Timeout/abort after start is an unknown outcome for Core lease handling, never an automatic FAILED→retry. Record only safe metadata, not full SDK logs.

```ts
const turn = await thread.run(prompt, {
  outputSchema: creativeOutputSchema,
  signal: AbortSignal.timeout(480_000),
});
const result = normalizeCreativeResult(JSON.parse(turn.finalResponse), request.input);
```

The surrounding thread construction follows Task 1's verified pinned SDK types. Test malicious brief text requesting credentials, shell/network access, canon lock, and approval: permissions stay fixed and returned unknown fields fail validation.

**Checks:** `codex-executor.spec.js`, `worker-config.spec.js`, compiled SDK import smoke without provider call. No live execution required for this task.

## Task 8: Private worker server and durable completion delivery

**Owner:** Luna Max. **Depends:** 7 and reviewed Task 3 contract.

**Files:** Create `src/codex-worker/main.ts`, `worker-server.ts`, `worker-server.spec.ts`, `completion-store.ts`, `completion-store.spec.ts`, `job-processor.ts`, `job-processor.spec.ts`, `execution-server.ts`, `execution-server.spec.ts`; extend worker config/spec and `package.json` with `start:codex-worker` and `start:codex-executor`. Create `Dockerfile.codex-worker`, `ops/codex-worker/compose.yaml`, `ops/codex-worker/network-policy.nft`, and `ops/codex-worker/isolation.test.cjs`. Do not edit deployment workflows to start it automatically.

**Interfaces:** `processJob(jobId:string): Promise<void>` claims via the fixed n8n URL, executes at most once, persists completion, and retries only completion delivery. `CompletionStore` uses a dedicated persistent spool directory keyed by validated job UUID, never caller paths.

**Concrete runtime refinement:** One worker application has two isolated processes/containers: transport and SDK execution. This is a privilege boundary, not another business/state service. The transport process owns spool and n8n credentials; the executor owns only provider authentication. `execution-server.ts` exposes private `POST /execute` accepting `CreativeExecutionRequest` after transport has claimed the job. It returns `CreativeExecutionOutcome`; transport alone adds the Core attempt token and input hash to form `CreativeCompletion`. No automatic HTTP retries on this endpoint. A connection loss is an unknown outcome. Executor has no claim/result routes, Core token, or authoritative persistence. Its runtime validates the input/hash and fixed role before invoking Task 7's SDK adapter. Restrict ingress to the transport container through the owned network policy; do not publish the executor port to the host.

The owned Compose manifest defines non-root transport/executor containers, read-only root filesystems, dropped capabilities, no Docker socket or repository bind, and separate PID namespaces. Only transport mounts the 0700 persistent spool. Only executor receives provider credentials; its work directory is a size-limited tmpfs. No host Codex home/config is mounted. Execution listens only on the dedicated internal execution bridge; transport's dispatch listener binds only its separate private n8n bridge address. Host-enforced rules in `network-policy.nft` allow transport to initiate executor:8081 and n8n forwarding connections, and allow executor outbound only to a deployment-configured inference egress proxy. Deny executor-initiated connections to transport, n8n, Core, PostgreSQL, host/metadata addresses, and all other destinations; allow established response traffic. The inference proxy allowlists only the provider endpoints verified in Task 1 and denies arbitrary CONNECT/redirect destinations. The manifest must not attach executor to the Core/n8n network. Host policy/proxy installation is a rollout operation, not a local automatic action.

`isolation.test.cjs` exercises the built runtime in an isolated CI/staging network: forbidden spool/config files absent, no transport keys in executor env, denied connections to instrumented fake Core/n8n/DB/metadata listeners, allowed fixture inference-proxy response, and no provider call. If the target host cannot enforce this network policy, the runtime release gate fails. Do not replace it with prompt-only restrictions. CI builds the two targets; never build them through local npm commands.

- [ ] Use Node HTTP/fetch/fs/crypto; no new server/queue library. Authenticate before parsing body; maximum `/jobs` body 1 KiB; queue capacity one running plus one pending; reject excess with 503. Never expose Core DB dependencies in the worker module/runtime.
- [ ] Persist local accepted/claimed markers before execution. Send the token-free request to executor once only; a transport restart does not resend it. If dispatch repeats, consult markers and Core claim; never rerun a locally started job after restart. Lost markers still cannot cause a second Core claim. Core remains authoritative. A process-local executor ID set rejects duplicate `/execute` IDs while alive; after restart the transport marker still prohibits a resend.
- [ ] After successful claim, persist token/context with filesystem permissions 0600 in the private spool. SDK child cannot read the spool or callback credentials. Separate process permissions/mount boundaries must enforce this; merely choosing another subdirectory is insufficient.
- [ ] Persist completed envelope by temporary-file write, fsync, rename before HTTP delivery. Startup retries stored envelopes only; it never resumes/reruns SDK from a started marker. Delivery backoff 1s, 5s, 30s, then every 60s; retry network/5xx, quarantine 4xx conflicts/auth errors, preserve original envelope/token. Stop retry on a valid Core acknowledgement.
- [ ] Retain acknowledged entries 24 hours; unacknowledged entries remain until acknowledged or operator reconciliation, bounded by disk capacity with fail-closed refusal of new jobs. Report spool failures safely. A process crash before durable output remains unknown; do not promise recovery of lost output.
- [ ] On shutdown stop intake, abort running SDK work, and preserve local records. Do not send a false definitive failure for ambiguous execution. Test crash after claim, after execution before persistence, after persistence before send, and after Core commit before HTTP acknowledgement.

```ts
assert.equal(executeCalls, 1);
assert.deepEqual(secondDelivery.body, firstDelivery.body);
assert.equal(secondDelivery.body.attemptToken, firstDelivery.body.attemptToken);
```

Use a fake executor and intercepted HTTP server for the assertion; restart the processor between delivery attempts. Prove no transport secret reaches the SDK invocation. Container startup compilation/build is CI-only; local tests compile test output.

## Task 9: Mount the Core worker boundary and module wiring

**Owner:** Luna Max. **Depends:** 3 and 6.

**Files:** Create `src/rovelle/creative/creative.controller.ts`, `creative.controller.spec.ts`, `creative-worker.guard.ts`, `creative-worker.guard.spec.ts`, `creative.module.ts`; modify `src/rovelle/creator/creator.module.ts`, `src/rovelle/rovelle.module.ts` and relevant module specs; modify `src/config/env.ts` and its existing test file if present (otherwise create `src/config/env.spec.ts`).

**Interfaces:** Implements the three frozen Core HTTP routes; exports CreativeRepository and CreativeApprovalService to creator wiring. Creative module never imports CreatorModule; reply types are type-only imports. Creator creative service is provided in CreatorModule.

- [ ] Write guard assertions for missing expected key, absent header, wrong key, correct key; all but correct key deny. Use timing-safe comparison with explicit equal-length handling. Apply existing skip decorator only to this dedicated guarded controller.
- [ ] Implement UUID/body/status validation, explicit 200 responses and normal envelope. Enforce body byte limit before costly validation. Return only bounded queued IDs and Core-owned reply destination. Normalize controlled errors without exposing tokens or content.
- [ ] Wire feature flag, stable bot ID, dedicated worker key with config validation. Flag off keeps old creator path. Flag on with missing bot ID/key fails startup; do not silently enable unauthenticated routes.
- [ ] Test HTTP-level request through Nest: unauthorized request cannot call repository; valid claim works; malformed output returns 400; wrong ownership/token/hash rejects; duplicate completion response unchanged; module boots without circular dependencies. Run existing module/controller regressions.

**Checks:** new creative controller/guard specs, `rovelle.module.spec.js`, `creator.module.spec.js`, `creator.controller.spec.js`, environment specs.

## Task 10: Prepare and test local n8n transport

**Owner:** Luna Max. **Depends:** 4, 8, 9.

**Files:** Extend existing `workflows/rovelle/creator-transport.cjs` and `.test.cjs`; create `workflows/rovelle/creative-transport.cjs`, `creative-transport.test.cjs`, `docs/rovelle/n8n-codex-storyboard.md`. These are local adapter functions/tests and documentation, not fabricated production workflow exports.

**Interfaces:** Existing normalized creator requests gain real `updateId`; new exported pure functions `buildCreativeDispatch(response)`, `buildCreativeClaimForward(body)`, `buildCreativeResultForward(body)`, `buildCreativeQueuedDispatches(response)` return validated fixed-route HTTP descriptions. HTTP/send execution stays in actual n8n nodes.

- [ ] Inspect current helper exports and tests before changing them. Preserve `/rv`, operator/private allowlists, text answers, callback acknowledgement, URL/callback keyboards, error handling, and original credential references.
- [ ] Add tests that extract `update_id` for both messages and callbacks, preserve it as decimal string, dispatch only exact Core `creativeJob.action === 'DISPATCH'` with valid UUID, and reject model-provided URLs/unknown actions. Acknowledgement precedes Core for callbacks.
- [ ] Implement claim/result forwarding with fixed routes, dedicated credentials by reference, 10-second timeout, redirects off, and body caps. Result webhook acknowledges Core persistence before Telegram sending. Result/Telegram replay may redeliver text but must not rerun Codex or approval.
- [ ] Prepare recovery mapping: scheduled GET of queued work every minute, at most 20 IDs, dispatch only returned IDs; Core owns expiry/eligibility. No text parsing to decide retry or spending. No new production Telegram Trigger.
- [ ] Document exact node changes to existing RV-00 and worker webhooks/recovery trigger; do not call n8n MCP or synthesize a fake live graph. Actual workflow IDs/version and installed node settings are verified only in Task 12.

```json
{"telegramUserId":"976684739","chatId":"976684739","updateId":"987654321","messageText":"/new"}
```

```json
{"ok":true,"data":{"text":"Creative draft queued. Check /mywork for progress.","creativeJob":{"id":"00000000-0000-4000-8000-000000000001","action":"DISPATCH"}}}
```

```json
{"jobId":"00000000-0000-4000-8000-000000000001"}
```

The documentation must include completed/failed envelopes matching Task 2, response/destination mapping, config names, credential direction, timeouts, retention, queued recovery, and which old nodes stay. Configure actual n8n execution retention off for sensitive creator/worker payloads at rollout; never put spool tokens, raw SDK logs, or bearer links in alerts.

**Check:** `rtk proxy node --test workflows/rovelle/creator-transport.test.cjs workflows/rovelle/creative-transport.test.cjs`. Intercept all network/provider/Telegram side effects. No production calls.

## Task 11: Prove the full local acceptance loop

**Owner:** Luna Max implements test; Terra High signs off.

**Files:** Create `src/rovelle/creative/creative-flow.integration.spec.ts`; update `docs/rovelle/n8n-codex-storyboard.md` with observed results and limitations. Extend existing CI test configuration only if needed to execute the new tests against an isolated service database; never add an automatic deployment step.

**Interfaces:** Real Core/Prisma state plus intercepted n8n HTTP/Telegram and fake SDK. Use real DTOs/actions, never bypass approval by inserting an already-approved row.

- [ ] Drive authorized `/new`, title/duration/premise/learning goal/tone/canon, Draft choice, dispatch, claim, fake structured completion, every preview page, Revise feedback, second completion, final-page approval, and `/mywork`.
- [ ] Assert one saved PREPRODUCTION episode from the second job, full script/storyboard content, exact pinned versions, revision-one button rejected, and zero video/render/provider submissions. Duplicate each delivery boundary and verify stable job/episode counts.
- [ ] Exercise unknown execution outcome, lost initial dispatch recovered by queued discovery, result transport failure recovered from spool, Telegram failure recovered through `/mywork`, approval rollback, foreign owner, malformed SDK output, and missing update ID.
- [ ] Run the focused DB acceptance suite with no skips, workflow tests, full `rtk npm test`, and `rtk git diff --check`. Record pre-existing failures separately; unresolved new failures block completion. Production build evidence comes from GitHub Actions only.
- [ ] Review permissions with a deliberately malicious brief. Prove forbidden tool attempts cannot read transport secrets or reach production services. Mock assertions alone do not establish OS isolation; record the isolated worker runtime check separately.

**Local acceptance:** Tests demonstrate the business loop and failure behavior. A real Codex run, live workflow integration, and deployed end-to-end acceptance are separate evidence, not inferred from fixture success.

## Task 12: Authorized runtime verification and rollout

**Owner:** Terra High. **Depends:** 11. This task waits for explicit live-access/paid-test/deployment authorization; it does not block preparation of all earlier deliverables.

**Files:** Update runtime-verification and n8n integration docs with actual versions, sanitized evidence, and rollback procedure. Edit actual production graph/deployment files only inside specifically authorized rollout scope.

- [ ] Verify deployed Core SHA, applied migration list, exact SDK/runtime/model/auth, worker OS isolation, feature flag, private addresses, persistent spool, key bindings, and public upload origin. Do not print credentials. Run one explicitly authorized isolated Codex storyboard result and verify structured output, cancellation behavior, output retrieval, and available usage metadata.
- [ ] When n8n inspection is authorized, fetch the actual current RV-00 graph and installed node definitions; compare to the September 9 historical evidence and local helper assumptions. Capture protected rollback version by credential reference. Rebase only the proposed transport changes onto that graph.
- [ ] Present exact reviewed migration/workflow/deployment diff and checks before requesting any still-missing rollout approval. Keep the feature disabled until Core, worker, and n8n adapters are ready together.
- [ ] Roll out only the authorized components; enable the creative feature; run one authorized brief→revision→approval journey. Record saved episode/job IDs and confirm no video charge was initiated. Do not remove legacy routes.
- [ ] Rollback disables new creative intake/dispatch first while preserving result forwarding and `/mywork` recovery for in-flight jobs. Do not drop new tables or delete spool state. Restore the captured gateway version only after reconciling running jobs; disabling a feature cannot undo already-incurred usage.

## Definition of done and continuation boundary

- [ ] Terra has reviewed all task-owned diffs and evidence; no unresolved contract/file conflicts.
- [ ] Local end-to-end acceptance and DB uniqueness/rollback tests pass with no database skips.
- [ ] Manual creator, Veyra/Aegis, uploads, and existing video/review/render regressions remain unchanged.
- [ ] SDK import/version pinning, worker secret isolation, complete review content, revision binding, and no automatic repeat spend are demonstrated.
- [ ] Payload docs state local versus deployed evidence honestly. If Task 12 is unauthorized, report “implementation ready for rollout” rather than “live integration complete.”

Images, scoped artifact upload, first-frame propagation, media preview, and final-render continuation from design stages 4–5 are intentionally not executable tasks here. After this storyboard acceptance passes, produce separate image and video-continuation plans against actual deployed capability; do not imply this plan delivers the whole design roadmap.

## Sources and execution launch prompt

Repository baseline and schema are authoritative for existing behavior. SDK research for this plan used [official SDK documentation](https://developers.openai.com/codex/sdk/) and [the official TypeScript SDK README](https://github.com/openai/codex/blob/main/sdk/typescript/README.md), fetched through Context7 `/openai/codex` on 2026-09-11. They establish structured output and SDK execution; version pinning and actual deployed capability are Task 1 evidence, not assumed here.

Paste into a Terra High execution task after authorizing local implementation:

```text
Execute docs/superpowers/plans/2026-09-11-rovelle-codex-n8n-integration.md.
Use gpt-5.6-terra with high reasoning as orchestrator and gpt-5.6-luna
with max reasoning for bounded implementation and fresh review tasks.
Follow the dependency graph, frozen contracts, file ownership, and review gates.
Local implementation and isolated testing of Tasks 1–11 are authorized.
Preserve existing uncommitted work. Do not run a local npm build.
Do not call n8n MCP, alter production, deploy, or incur provider usage without
separate explicit authorization. Complete all independent local work before
reporting any blocked live checks. Task 12 remains separately gated.
```
