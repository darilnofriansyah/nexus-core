# Project Review

## Review Metadata

- Reviewed: 2026-08-06 Asia/Jakarta
- Branch: `main`
- Commit: `32d0d66` (`fix(transactions): complete regret workflow`)
- Review scope: remaining credit-card access migration, migration test, project documentation, and recursive test-script fix.
- Checks run: `npm test` passed 20/20 spec files; `npm run build` and `npm run lint` passed.

## Completed Work

- NestJS modules cover health, Aegis alerting, Telegram routing, dashboard overview, budgets, conversation state, transactions, email review, conversational analytics, and AI integration.
- Recent feature commits added dashboard credit-card cycle summaries and confirmed-email credit-card usage, with reversal handling documented separately.
- OpenAI SDK-based LLM integration and callback fixes are present in merged history and current source.
- Veyra transaction Watchdog v1 runs after confirmed transaction creation, confirmation, category confirmation, and managed edits. It combines budget alerts, burn-rate projection, and deterministic large-transaction risk reviews with idempotent persistence and Telegram callback responses.
- The Watchdog risk-review migration is applied in production. Outbound notification delivery and parent callback routing are rolled out and verified.
- README endpoint contracts, schema/migration documentation, the parity checklist, and 20 focused `*.spec.ts` files provide implementation evidence.

## Remaining Tasks

- Apply the credit-card cycle-summary access grant only after production approval; its migration contract test passes locally.
- Complete the explicit open production work in `docs/migration/actionable-parity-checklist.md`: email AI orchestration and approved SQL rollout, confirmation cutover verification, cycle-aware intent fixtures/parity, and n8n HTTP/network error branches.
- Live-retest the Watchdog `regret` follow-up after the `32d0d66` automatic deployment.
- Keep legacy n8n paths restorable until production fixture coverage confirms each Core API cutover.

### Transaction Watchdog Actions

- [x] Confirm `2026-07-06-transaction-risk-reviews.sql` and `2026-07-12-large-transaction-risk-review-v1.sql` are approved and applied in production.
- [x] Fixture-test the n8n mapping that sends ordered `risk_review`, `budget_alert`, and `burn_rate` notifications and routes `veyra_risk:*` callbacks.
  - [x] Local fixture: `src/veyra/transactions/test/fixtures/watchdog/n8n-mapping.json`.
  - [x] Ordered outbound notification delivery is live.
  - [x] The parent Telegram callback router invokes the existing callback workflow.
- [x] Connect the `regret` callback to bounded `veyra_regret_note` state without resolving the review immediately.
- [ ] Live-retest the `regret` callback after automatic deployment.
- [ ] Decide whether the undocumented `POST /transactions/risk-reviews/regret-detector` endpoint is still used; remove it if all evaluations originate from `evaluateTransactionWatchdog()`.
- [ ] Add failure recovery for Watchdog evaluation; it currently logs errors and returns no notifications, with no retry or persisted failure state.
- [ ] Decide whether transaction-time evaluation is sufficient or whether n8n needs a scheduled reconciliation sweep for missed or historical confirmed transactions.

## Needed Improvements

- Keep the actionable checklist as the authoritative current backlog.
- Record rollout owner, applied environment, and rollback evidence beside every production SQL activation.

## Summary

Core API has broad implemented coverage, focused tests, and completed Watchdog migration, outbound delivery, and callback routing. The regret follow-up fix needs a post-deploy live retest, while the credit-card access SQL still requires production approval before application.
