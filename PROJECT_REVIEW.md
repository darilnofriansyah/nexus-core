# Project Review

## Review Metadata

- Reviewed: 2026-08-06 Asia/Jakarta
- Branch: `main`
- Commit: `a140f39` (`chore: finish rollout follow-up`)
- Review scope: production rollout evidence, Watchdog endpoint ownership, failure recovery ownership, and remaining migration work.
- Checks run: `npm test` passed 20/20 spec files; `npm run build` and `npm run lint` passed.

## Completed Work

- NestJS modules cover health, Aegis alerting, Telegram routing, dashboard overview, budgets, conversation state, transactions, email review, conversational analytics, and AI integration.
- Recent feature commits added dashboard credit-card cycle summaries and confirmed-email credit-card usage, with reversal handling documented separately.
- OpenAI SDK-based LLM integration and callback fixes are present in merged history and current source.
- Veyra transaction Watchdog v1 runs after confirmed transaction creation, confirmation, category confirmation, and managed edits. It combines budget alerts, burn-rate projection, and deterministic large-transaction risk reviews with idempotent persistence and Telegram callback responses.
- The Watchdog risk-review migration is applied in production. Outbound notification delivery and parent callback routing are rolled out and verified.
- The Watchdog `regret` callback and follow-up note flow passed live production E2E verification on 2026-08-06.
- The unused caller-supplied regret-detector endpoint was removed after repository and production n8n inspection found no consumers.
- Telegram delivery recovery remains in n8n's three-attempt reliable sender. Core evaluation recovery is deferred until an observed failure requires a dedicated idempotent re-evaluation path.
- README endpoint contracts, schema/migration documentation, the parity checklist, and 20 focused `*.spec.ts` files provide implementation evidence.

## Remaining Tasks

- Complete the explicit open production work in `docs/migration/actionable-parity-checklist.md`: email AI orchestration and approved SQL rollout, confirmation cutover verification, cycle-aware intent fixtures/parity, and n8n HTTP/network error branches.
- Keep legacy n8n paths restorable until production fixture coverage confirms each Core API cutover.

### Transaction Watchdog Actions

- [x] Confirm `2026-07-06-transaction-risk-reviews.sql` and `2026-07-12-large-transaction-risk-review-v1.sql` are approved and applied in production.
- [x] Fixture-test the n8n mapping that sends ordered `risk_review`, `budget_alert`, and `burn_rate` notifications and routes `veyra_risk:*` callbacks.
  - [x] Local fixture: `src/veyra/transactions/test/fixtures/watchdog/n8n-mapping.json`.
  - [x] Ordered outbound notification delivery is live.
  - [x] The parent Telegram callback router invokes the existing callback workflow.
- [x] Connect the `regret` callback to bounded `veyra_regret_note` state without resolving the review immediately.
- [x] Live-retest the `regret` callback after automatic deployment.
- [x] Remove the unused `POST /transactions/risk-reviews/regret-detector` endpoint; all configured production n8n paths originate evaluations from `evaluateTransactionWatchdog()`.
- [x] Keep Telegram delivery retry in n8n and defer Core evaluation recovery until observed failures justify a dedicated idempotent re-evaluation path. Do not retry transaction mutation endpoints.
- [ ] Decide whether transaction-time evaluation is sufficient or whether n8n needs a scheduled reconciliation sweep for missed or historical confirmed transactions.

## Needed Improvements

- Keep the actionable checklist as the authoritative current backlog.
- Record rollout owner, applied environment, and rollback evidence beside every production SQL activation.

## Summary

Core API has broad implemented coverage, focused tests, and completed Watchdog migration, outbound delivery, callback routing, regret follow-up verification, and production credit-card summary read access. Remaining work is the explicit production migration backlog and the decision on scheduled Watchdog reconciliation.
