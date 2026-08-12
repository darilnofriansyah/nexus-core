# Project Review

## Review Metadata

- Reviewed: 2026-08-10 09:01 Asia/Jakarta
- Branch: `main`
- Commit: `d12bd1c7c530aeeb06c78c86ac9b03c60e846bc0` (`feat(veyra): migrate master intent routing`)
- Working tree: clean before this review
- Review scope: current source and history, top-level documentation, migration checklist and plans, tests, and explicit task markers.
- Checks run: repository inspection only; tests, build, and lint were not run for this review.

## Completed Work

- The NestJS API has implemented modules for health, Aegis alerting, Telegram routing, dashboard overview, budgets, conversation state, transactions/email review, conversational analytics, and AI integration. The repository currently contains 20 recursive `*.spec.ts` files.
- The Watchdog risk-review migration, ordered outbound notifications, parent callback routing, and regret follow-up note flow have production evidence recorded in `docs/migration/watchdog-production-verification.md`. The report also records the applied SQL migration and the decision to keep Telegram delivery retry in n8n.
- Credit-card cycle-summary read access for Veyra and confirmed-email credit-card usage are represented in the current migration/docs history; reversal handling is documented separately.
- `POST /api/veyra/transactions/email/handle` now invokes the preserved `gpt-4.1-mini` fallback in Core for authenticated likely transaction emails, validates the result through the identity-bound review path, and keeps AI-created candidates pending until confirmation. The email parser-template migration was verified as already matching production on 2026-08-06, with no DDL rerun.
- `POST /api/veyra/messages/route` now classifies only the deterministic `conversational` branch with strict `gpt-5.4-mini` Responses API output (`store: false`); callbacks, slash commands, active states, and unresolved users remain deterministic. A sanitized 27-intent fixture and service tests provide local contract evidence.
- README endpoint contracts, schema/migration docs, the actionable parity checklist, and the LLM handoff document record the current n8n ownership and rollback boundaries.

## Remaining Tasks

- Treat `docs/migration/actionable-parity-checklist.md` as the authoritative backlog. Its open items are: approve/fixture-test/activate the production Gmail/AI/callback workflow; add `merchant_review_queue` writes only if that side effect is migrated; verify confirmation-payload cutover; add cycle-day-aware period output if replacing n8n logic; capture and approve sanitized legacy master-intent outputs (`liveOutputsCaptured: false`); and cut over the production Master Intent Classifier only after parity acceptance.
- Add n8n branches/documentation for Core HTTP `400` and `404` responses and network-error retry/fallback behavior. Keep the existing n8n branches restorable until each cutover has fixture evidence and a pilot run.
- Decide whether transaction-time Watchdog evaluation is sufficient or whether n8n needs a scheduled reconciliation sweep for missed or historical confirmed transactions.
- No production deployment, n8n workflow edit, or production cutover is evidenced by the 2026-08-09 master-intent commit; the repository implementation remains behind the documented rollback boundary.

## Needed Improvements

- Reconcile the legacy `/api/veyra/intents/classify` README wording with the newer `/api/veyra/messages/route` master-intent implementation so operators do not confuse the experimental deterministic helper with the production-cutover candidate.
- Keep every production SQL or workflow activation record beside its owner, target environment, approval, applied version/timestamp, and rollback evidence.
- Add the approved legacy-vs-Core master-intent comparison evidence and explicit HTTP failure-path behavior before removing n8n ownership.
- Keep generated project status concise and update it from the actionable checklist; unchecked boxes in older `docs/superpowers/plans/` files are historical implementation notes, not independent proof of unfinished code.

## Summary

At `d12bd1c7c530aeeb06c78c86ac9b03c60e846bc0`, Core has broad implemented coverage, documented Watchdog production evidence, and two recent AI moves (email fallback and master-intent route). Production AI cutover/parity, remaining n8n error branches, confirmation cutover, and Watchdog reconciliation remain open. Tests, build, and lint were not run during this review.
