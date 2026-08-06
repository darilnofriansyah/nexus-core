# Watchdog Production Verification

Observed from PostgreSQL catalog checks, the approved production migration,
and n8n rollout verification on 2026-08-04 and 2026-08-05. This is the
authoritative production verification record.

## Decision

| Check | Outcome | Evidence |
| --- | --- | --- |
| Migration approval | `APPROVED` | The user explicitly approved production execution on 2026-08-04 before the command ran. |
| Base table | `CURRENT` | `public.transaction_risk_reviews` has the validated eight-value response constraint and both required indexes. |
| `2026-07-12-large-transaction-risk-review-v1.sql` | `APPLIED` | Applied to production database `veyra`; postchecks passed at `2026-08-04T09:55:27.714Z`. |
| Review data | Recorded | 32 reviews and zero non-null or unsupported `user_response` values at postcheck. |
| Callback workflow | Structurally compatible | `oXuLf0DvtlinpcvK` forwards callback data to `/api/veyra/transactions/callback/handle`, but its 25 retained executions contain no `veyra_risk:*` callback. |
| Parent callback router | `PASS` | Active workflow `DNABjIGVH0vYErI7`, version `8f39587a-826b-490c-ab90-53d6c38bce74`, already routes Core `callback` results to `oXuLf0DvtlinpcvK`. Pinned execution `3959` confirmed a synthetic `veyra_risk:7:planned` update reaches only that branch with the callback query and normalized IDs. |
| Callback ownership | `PASS` | The parent only invokes the callback workflow. `oXuLf0DvtlinpcvK` owns one callback answer, one Core callback POST, and one Telegram Reliable Editor call. Retained production executions `3938` and `3939` confirm that chain for an existing transaction callback. |
| Callback behavior checks | `PASS` | Focused Core tests passed for `planned`, `necessary`, `regret`, `ignore`, duplicate/resolved, invalid data, regret-note routing, note persistence, and final review resolution. |
| Notification delivery | `PASS` | Core commit `7f18873` deployed successfully. Manual version `9599e670-a3f5-4a54-ac75-17f9ca1077e1` and email version `ad909cad-4ccb-48f3-8219-aa588479455d` are active. Controlled executions `3949` and `3954` each delivered base, `risk_review`, `budget_alert`, and `burn_rate` in order with unchanged risk-review markup. |
| Live Telegram callback E2E | `PASS` | On 2026-08-05, `planned`, `necessary`, `ignore`, and a resolved-review stale callback passed. The initial `regret` attempt exposed an older deployed Core image. After the corrected image was deployed, the full regret click and follow-up note flow passed on 2026-08-06. |
| Production decision | `PASS` | Ordered outbound delivery, all four callbacks, resolved-review safety, regret-note routing, note persistence, delayed review resolution, and final state reset have fresh production evidence. |

The local Core mapping contract is
`src/veyra/transactions/test/fixtures/watchdog/n8n-mapping.json`. It specifies
the required `risk_review`, `budget_alert`, then `burn_rate` notification order
and all four `veyra_risk:*` callback actions. It is evidence of the Core
contract and matches the deployed n8n delivery evidence above.

## Applied migration evidence

- Target: PostgreSQL 16.14 database `veyra`, resolved from the running Core API
  configuration without printing credentials.
- Precheck: table present; one named legacy `user_response` check; 32 rows with
  `user_response IS NULL`; zero unsupported values; neither target index existed.
- Operator role: PostgreSQL role `daril`, verified as the target table owner.
- Command result: `ALTER TABLE`, `ALTER TABLE`, `CREATE INDEX`, `CREATE INDEX`;
  exit code `0`.
- Postcheck timestamp: `2026-08-04T09:55:27.714Z`.
- Constraint: `transaction_risk_reviews_user_response_check` is validated and
  permits `planned`, `necessary`, `regret`, `ignore`, `impulse`,
  `wrong_category`, `note_added`, and `ignored`.
- Indexes: `idx_transaction_risk_reviews_risk_type` and
  `idx_transaction_risk_reviews_fingerprint` both report
  `indisready = true` and `indisvalid = true`, with the expected definitions.
- Data postcheck: 32 null responses and zero unsupported responses.

Database work must not be repeated for any later callback test.

## Parent callback router evidence

- Production parent: `Veyra Message Router with Master Intent - Nexus Core API`
  (`DNABjIGVH0vYErI7`), active on version
  `8f39587a-826b-490c-ab90-53d6c38bce74` when inspected on 2026-08-05.
- Rollback snapshot: the same version ID, `active = true`, updated at
  `2026-07-06T14:08:59.936Z`. No workflow update was necessary, so this
  snapshot remains the active production state.
- Route topology: `Telegram Trigger` -> `Normalize Telegram Input` ->
  `POST Core API Message Route` -> `Build Route Envelope` -> `Switch Route`.
  The `callback` output invokes `Call Veyra Callback Sub-Workflow`, whose
  target is exactly `oXuLf0DvtlinpcvK`. All six non-callback switch outputs
  and their connections were left unchanged.
- Parent payload: the full Telegram callback query is retained as
  `callbackQuery` and inside `rawTelegram.callback_query`; the envelope also
  carries normalized `telegramUserId`, resolved `userId` when available,
  `chatId`, callback data as `text`, and `messageId`. The callback workflow's
  `Extract Callback Payload` node normalizes those values to
  `telegramUserId`, `userId`, `callbackData`, `chatId`, and `messageId` before
  calling Core.
- Single owner: the parent has no callback-answer, transaction-callback HTTP,
  or Telegram edit node on this branch. The child sequence is exactly
  `Answer Telegram Callback` -> `POST Core API Transaction Callback` ->
  `Build Telegram Edit Payload` -> `Call Telegram Reliable Editor`.
- Retained production evidence: parent execution `3938` invoked child
  execution `3939`; the child normalized all five callback fields, answered
  once, received HTTP `201` from Core, built one edit payload, and called the
  reliable editor once.
- Safe risk-branch check: manual execution `3959` used synthetic pin data for
  every external node. It routed `veyra_risk:7:planned` to only
  `Call Veyra Callback Sub-Workflow`, preserving callback data, chat ID,
  message ID, Telegram user ID, resolved application user ID, and the full
  callback query. It did not call Core or Telegram.
- Focused verification on 2026-08-05: `npx tsc -p tsconfig.test.json` passed;
  six transaction callback tests passed for immediate actions, regret state,
  unavailable regret state, duplicate/resolved callbacks, regret note
  capture/resolution, and invalid callback data; two message-route tests
  passed for callback routing and `veyra_regret_note` returning through the
  record route.
- No n8n workflow was created, updated, published, unpublished, activated, or
  deactivated during routing verification.

## Live Telegram callback E2E evidence

Authorized production testing ran on 2026-08-05 and stopped on the first
defect. Every click below traversed active parent workflow
`DNABjIGVH0vYErI7`, callback workflow `oXuLf0DvtlinpcvK`, and Telegram Reliable
Editor `AIct5A5gDbILeqVU`. Each callback execution contained exactly one
`Answer Telegram Callback`, one `POST Core API Transaction Callback`, and one
`Call Telegram Reliable Editor`; each editor sub-execution made exactly one
successful `HTTP Edit Message` call.

| Action | Controlled record | Telegram message | Executions (parent / callback / editor) | Outcome |
| --- | --- | --- | --- | --- |
| `planned` | transaction `375`, review `37` | `1823` | `3960` / `3961` / `3962`, started `2026-08-05T15:51:31.140Z` | `PASS`: Core returned `Noted. This purchase was planned.`; review changed from pending/null to resolved/`planned`; transaction note remained the controlled test label; conversation state remained `idle`. |
| resolved-review stale callback | review `37` | `1824` | `3963` / `3964` / `3965`, started `2026-08-05T15:52:54.928Z` | `PASS`: Core returned `This transaction review was already answered.`; status, response, notes, and original resolution timestamp were unchanged. |
| `necessary` | transaction `376`, review `38` | `1825` | `3966` / `3967` / `3968`, started `2026-08-05T16:02:39.558Z` | `PASS`: Core returned `Noted. This purchase was necessary.`; review changed from pending/null to resolved/`necessary`; transaction note stayed unchanged; conversation state remained `idle`. |
| `ignore` | transaction `377`, review `39` | `1826` | `3969` / `3970` / `3971`, started `2026-08-05T16:04:22.023Z` | `PASS`: Core returned `Ignored.`; review changed from pending/null to resolved/`ignore`; transaction note stayed unchanged; conversation state remained `idle`. |
| `regret` click | transaction `378`, review `40` | `1827` | `3972` / `3973` / `3974`, started `2026-08-05T16:07:45.486Z` | `FAIL`: Core returned `Recorded as a regretted purchase.` and immediately changed the review to resolved/`regret`. Expected `What note should I add?`, a pending review, null response/note, and `veyra_regret_note`. Conversation state remained `idle`; no follow-up note was sent. |

The four controlled transactions used amount `Rp37.000`, category `iCloud`,
distinct `Watchdog E2E` merchants, and explicit
`WATCHDOG_E2E_<ACTION>_2026-08-05` transaction-note labels. They and reviews
`37` through `40` remain in production; no cleanup or deletion was attempted.

### Regret defect diagnosis

- Production Core image `sha256:f031ec8a8037...` was created at
  `2026-08-05T15:00:02.553776488Z`.
- Its compiled callback handler does not pass a state store into
  `handleRiskCallback` and resolves every risk action immediately.
- The required local callback change adds the state-store parameter and the
  `veyra_regret_note` branch, but the source file was modified at
  `2026-08-05T15:01:36.972873256Z`, after the production image was created,
  and the change remains uncommitted.
- Therefore production is running the pre-change regret callback behavior.
  n8n routing, callback answering, Core POST ownership, and Telegram editing
  all executed once and succeeded; the defect is the deployed Core behavior.

Not tested in the initial run because of the stop-on-defect rule: regret
follow-up text routing through `record`, transaction-note replacement, final
review resolution after the note, and final conversation-state reset after
that note. No workflow, schema, application code, or deployment change was
made during the initial E2E run.

## Regret deployment retest evidence

The corrected production Core image `sha256:e8e6d3bfe4dd...`, created at
`2026-08-06T01:49:48.280494705Z`, was inspected before retesting. Its compiled
handler passes the state store into `handleRiskCallback` and contains the
two-stage `regret` branch.

- Controlled transaction `379`, review `41`, and Telegram message `1828` used
  amount `Rp37.000`, category `iCloud`, merchant
  `Watchdog E2E Regret Retest`, and transaction-note label
  `WATCHDOG_E2E_REGRET_RETEST_2026-08-06`.
- Before the click, review `41` was pending with null response, review note,
  and resolution timestamp; conversation state was `idle`.
- The regret click traversed parent `3975`, callback `3976`, and editor `3977`,
  starting at `2026-08-06T02:34:14.246Z`. Each relevant node ran exactly
  once: one callback answer, one Core callback POST, one editor invocation,
  and one successful Telegram `HTTP Edit Message`.
- Core returned `What note should I add?`. Review `41` remained pending with
  null response, note, and resolution timestamp. The transaction note was
  unchanged, and conversation state became `veyra_regret_note` with
  `review_id = 41` and `transaction_id = 379`.
- The exact follow-up text
  `WATCHDOG E2E regret follow-up verified 2026-08-06` entered parent execution
  `3978` at `2026-08-06T02:35:35.601Z`. Core message routing returned
  `route = record` with the stored regret state and invoked record workflow
  execution `3979` exactly once.
- Record execution `3979` called Core once. Core returned
  `status = regret_note_added`, transaction `379`, `Note added.`, and next
  state `idle`. Telegram Reliable Sender execution `3980` made one successful
  first-attempt HTTP send and delivered confirmation message `1830`.
- Final database evidence: review `41` is resolved with response `regret`; its
  review note and transaction `379` note both exactly equal the follow-up
  text; resolution occurred at `2026-08-06T02:35:35.727862Z`; conversation
  state is `idle` with empty state data.
- The controlled transaction and review remain in production. No cleanup,
  workflow update, schema change, application-code edit, or deployment was
  performed by this retest.

## Production migration procedure

Do not run this procedure without explicit production approval. Use a
dedicated `psql` session from the repository root. Do not use `BEGIN`, `-1`,
or `--single-transaction`; the migration builds indexes concurrently.

### 1. Precheck

Run these read-only queries and attach the output to the approval record:

```sql
SELECT to_regclass('public.transaction_risk_reviews') IS NOT NULL
  AS table_exists;

SELECT conname, convalidated, pg_get_constraintdef(oid) AS definition
FROM pg_catalog.pg_constraint
WHERE conrelid = 'public.transaction_risk_reviews'::regclass
  AND contype = 'c'
ORDER BY conname;

SELECT index_class.relname AS index_name,
       index_catalog.indisready,
       index_catalog.indisvalid,
       pg_get_indexdef(index_catalog.indexrelid) AS definition
FROM pg_catalog.pg_index AS index_catalog
JOIN pg_catalog.pg_class AS index_class
  ON index_class.oid = index_catalog.indexrelid
WHERE index_catalog.indrelid = 'public.transaction_risk_reviews'::regclass
ORDER BY index_class.relname;

SELECT COALESCE(user_response, '<NULL>') AS user_response, count(*) AS rows
FROM public.transaction_risk_reviews
GROUP BY user_response
ORDER BY user_response NULLS FIRST;

SELECT count(*) AS unsupported_response_count
FROM public.transaction_risk_reviews
WHERE user_response IS NOT NULL
  AND user_response NOT IN (
    'planned',
    'necessary',
    'regret',
    'ignore',
    'impulse',
    'wrong_category',
    'note_added',
    'ignored'
  );
```

Proceed only when:

- `table_exists` is `true`;
- `unsupported_response_count` is `0`;
- the deployed response check is the recorded legacy form, or already matches
  the eight-value target;
- neither target index name exists with an unexpected definition or with
  `indisready = false` or `indisvalid = false`.

### 2. Migration

After approval, run exactly:

```bash
PGOPTIONS='-c lock_timeout=5s -c statement_timeout=15min' \
  psql "$DATABASE_URL" -X --set=ON_ERROR_STOP=1 \
  --file=docs/migration/2026-07-12-large-transaction-risk-review-v1.sql
```

The constraint replacement is one atomic `ALTER TABLE`. `NOT VALID` keeps the
exclusive-lock phase short while still enforcing the new check for subsequent
writes; the next statement validates existing rows. The index statements use
`CONCURRENTLY IF NOT EXISTS`. A completed run is safe to repeat.

If validation fails, the new constraint remains installed but unvalidated and
still protects subsequent writes. Stop and investigate existing rows; do not
drop the constraint. If concurrent index creation is interrupted, inspect
`indisready` and `indisvalid`; PostgreSQL can retain an invalid same-name index
that `IF NOT EXISTS` will skip. After approval, remove only that invalid index
with `DROP INDEX CONCURRENTLY` and rerun the migration.

### 3. Postcheck

Repeat the constraint and index catalog queries from the precheck. Require:

- `transaction_risk_reviews_user_response_check` has `convalidated = true`
  and contains exactly the eight approved values;
- `idx_transaction_risk_reviews_risk_type` has `indisready = true`,
  `indisvalid = true`, and indexes `(risk_type)`;
- `idx_transaction_risk_reviews_fingerprint` has `indisready = true`,
  `indisvalid = true`, indexes
  `((risk_metrics ->> 'evaluationFingerprint'::text))`, and is partial on
  `risk_type = 'large_transaction'`;
- `unsupported_response_count` remains `0`.

Record the approver, operator, UTC timestamp, migration command result, and
postcheck output. Do not claim application from Git history alone.

### 4. Rollout

1. Complete and record the migration postcheck.
2. Separately approve the n8n change that maps every ordered `notifications`
   item to Telegram while preserving the risk-review keyboard.
3. Run an authorized delivery/callback test for `planned`, `necessary`,
   `regret`, and `ignore`.
4. Keep the prior n8n paths restorable until ordered delivery and all four
   callbacks pass.

No Core or n8n cutover is approved by this document.

### 5. Rollback

First stop or restore the callback path under separate n8n authorization. Then
run this read-only gate:

```sql
SELECT user_response, count(*) AS rows
FROM public.transaction_risk_reviews
WHERE user_response IN ('necessary', 'regret', 'ignore')
GROUP BY user_response
ORDER BY user_response;
```

If this returns any row, do not restore the legacy constraint; doing so would
reject stored production history. Prefer a forward fix or obtain explicit
data-remediation approval. Only when it returns zero rows may an authorized
operator run:

```sql
ALTER TABLE public.transaction_risk_reviews
  DROP CONSTRAINT IF EXISTS transaction_risk_reviews_user_response_check,
  ADD CONSTRAINT transaction_risk_reviews_user_response_check
  CHECK (
    user_response IS NULL OR user_response IN (
      'planned',
      'impulse',
      'wrong_category',
      'note_added',
      'ignored'
    )
  ) NOT VALID;

ALTER TABLE public.transaction_risk_reviews
  VALIDATE CONSTRAINT transaction_risk_reviews_user_response_check;
```

Leave the two indexes in place: they do not change callback behavior, and the
precheck may have found matching indexes that predated this rollout. Repeat the
catalog and response-distribution checks, record the rollback evidence, and
keep Watchdog callbacks disabled until compatibility is restored.
