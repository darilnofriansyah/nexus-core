# Rovelle Codex worker release status

Updated 2026-09-15. This records the current source state and distinguishes it
from staging or production evidence.

## Source state

- The separate transport and executor entrypoints are implemented under
  `src/codex-worker/`; `Dockerfile.codex-worker` keeps the SDK in the executor
  image only.
- The executor pins `@openai/codex-sdk@0.154.0`. It uses the worker-specific
  ESM boundary; Core remains on its existing build path.
- Creative jobs, Telegram receipts, claim/result/recovery routes, revision
  review, and atomic episode-plan approval are implemented. The feature flag
  defaults to `ROVELLE_CREATIVE_ENABLED=false`.
- CI provisions the disposable `rovelle_phase3a` database for the gated
  creative integration suites. Historical local acceptance exercised the
  storyboard loop without a live provider, n8n, Telegram, or deployment.
- Focused transport/executor server tests passed locally on 2026-09-15. A
  complete current CI run remains the release record.

## Required deployment configuration

Core requires `ROVELLE_TELEGRAM_BOT_ID` and
`ROVELLE_CREATIVE_WORKER_KEY` when creative mode is enabled. The worker
requires a model, provider credential, distinct dispatch and callback keys,
private n8n address, persistent spool, and an inference-proxy-only route. The
full configuration contract is in
[the n8n transport document](n8n-codex-storyboard.md#configuration-credentials-and-retention).

## Release gaps

- No staging or production run has verified model availability, provider
  authentication, one paid storyboard, completion delivery, or retained spool
  recovery.
- Static worker isolation is not proof of host enforcement. Run the opt-in
  runtime isolation test only on a prepared staging network with fake Core,
  n8n, PostgreSQL, metadata, and inference-proxy targets.
- The production deploy workflow currently starts `core-api` only. Worker
  deployment, health evidence, and rollback procedure must be added and
  approved separately.
- No production n8n graph has been inspected or changed. Record its version,
  credentials, execution-retention policy, and rollback version before
  enabling the feature.

Do not enable creative mode until every release gap above has current staging
evidence.
