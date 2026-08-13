# Watchdog Risk Button Route Coverage Design

## Goal

Preserve the existing Watchdog risk-review keyboard on every Telegram route
that confirms or materially edits a transaction.

## Approaches Considered

1. Patch each broken callback independently. This is the smallest immediate
   diff, but repeats the mistake that left sibling routes behind.
2. Reuse one service helper that selects the first `risk_review` notification
   with `reply_markup`, then use it at callback delivery boundaries. This is the
   recommended minimum because the notification contract already exists.
3. Redesign every transaction response around a new delivery DTO. This would
   be broader than the bug and is not needed.

## Design

- Add one private selector for the existing Watchdog notifications.
- Use it for `save_transaction`, `catid`, and completed managed edits.
- Keep risk-action callbacks unchanged; they intentionally clear keyboards.
- Keep direct manual, email, confirm, and set-category response contracts:
  ordered `notifications[]` remain the delivery source.
- Update local manual and email n8n exports to deliver the base message followed
  by each notification with its original `reply_markup`.
- Do not add Watchdog side effects to the web-only `PATCH /transactions/:id`;
  that route has no Telegram delivery boundary and needs a separate product
  decision.

## Testing

- Prove `catid` returns the exact four-button risk keyboard.
- Prove managed edit confirmation returns that keyboard at the public delivery
  field.
- Preserve null markup when no risk notification exists.
- Validate modified workflow JSON and run focused transaction/controller tests,
  then the repository verification suite.

## Scope

No database, schema, DTO, dependency, or live n8n workflow changes. Existing
unrelated worktree changes remain untouched.
