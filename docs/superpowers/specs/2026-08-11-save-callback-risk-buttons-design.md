# Save Callback Risk Buttons Design

## Goal

Show the existing large-transaction risk-review buttons after a user confirms a
pending transaction through `save_transaction:{transactionId}`.

The buttons must appear on the current combined confirmation message. This
change must not create a separate Telegram message or require an n8n workflow
change.

## Current Behavior

`confirmTransaction()` runs the transaction Watchdog and returns:

- an aggregated `editMessage.text` containing the confirmation, risk-review
  text, and any multiline budget warning;
- ordered `notifications`, where a pending `risk_review` owns the inline
  keyboard for `planned`, `necessary`, `regret`, and `ignore`.

The `save_transaction` callback adapter keeps the aggregated text but discards
the notifications and explicitly passes `replyMarkup: null` to the Telegram
callback response. The existing n8n callback workflow faithfully forwards that
null value, so Telegram displays the risk-review question without its buttons.

## Design

In the successful `save_transaction` callback branch, find the first returned
notification whose `type` is `risk_review` and use its `reply_markup` as the
callback response's `replyMarkup`.

Keep every other response field and behavior unchanged:

- Continue editing the original Telegram confirmation message.
- Continue using the existing aggregated confirmation text.
- Do not expose or deliver additional notification messages.
- Keep `reply_markup` null when no pending risk review was created.
- Preserve the generated callback data without reconstruction or sorting.
- Leave the n8n callback workflow unchanged; it already forwards
  `telegram.reply_markup`.

## Data Flow

1. Telegram sends `save_transaction:{transactionId}`.
2. Core confirms the transaction and evaluates Watchdog.
3. Watchdog may return a pending `risk_review` notification with its keyboard.
4. The transaction callback adapter returns the existing combined text and the
   risk-review keyboard in `telegram.reply_markup`.
5. n8n edits the original Telegram message using both fields.
6. A later `veyra_risk:{reviewId}:{action}` click follows the existing risk
   callback flow.

## Callback Outcomes

- `planned`, `necessary`, and `ignore` resolve the review immediately, replace
  the combined message with the acknowledgement, and remove the keyboard.
- `regret` replaces the combined message with the note prompt, removes the
  keyboard, and enters `veyra_regret_note` for 15 minutes.
- Repeated or stale callbacks retain the existing already-answered behavior.

Replacing the combined message after a button click is an accepted consequence
of the selected same-message design.

## Files

- Modify `src/veyra/transactions/transaction.service.ts` to propagate the
  pending risk-review keyboard from the confirm result.
- Modify `src/veyra/transactions/transaction.service.spec.ts` with focused
  callback behavior coverage.
- Modify `README.md` to document the save-callback keyboard behavior.

No DTO, database, schema, dependency, or n8n workflow changes are required.

## Testing

Add focused service tests that prove:

1. A successful save callback with a pending `risk_review` returns the exact
   Watchdog `reply_markup`.
2. A successful save callback without a pending risk review still returns
   `reply_markup: null`.
3. Existing `planned`, `necessary`, `regret`, and `ignore` callback behavior
   remains unchanged.

Run the focused transaction tests, the full test suite, build, lint, and
`git diff --check` before completion.

## Risks and Controls

- **Wrong keyboard selected:** Filter specifically by `type === "risk_review"`
  and use its existing `reply_markup` unchanged.
- **Stale keyboard:** Only a newly returned pending risk review has notification
  markup; idempotent or already-resolved evaluations do not notify.
- **Regression for ordinary confirmations:** Preserve the explicit null fallback
  and cover it with the existing test.
- **Unintended n8n scope:** Make no workflow edits or production changes.
