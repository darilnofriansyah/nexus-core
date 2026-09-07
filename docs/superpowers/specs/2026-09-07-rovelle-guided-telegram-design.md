# Rovelle guided Telegram creator design

## Goal

Replace UUID-heavy operator commands with a private Telegram creator flow:
canon setup, a guided free episode draft, explicit paid per-shot generation,
human per-shot selection, and final render handoff. No dashboard.

## Ownership

Core owns every creator session, button action, request UUID, spend decision,
and Rovelle state transition. n8n owns the Telegram Trigger, callback-query
acknowledgement, Core HTTP call, and delivery of Core-provided text/buttons.
n8n never stores a conversation, builds an idempotency key, infers a paid
intent, or writes Rovelle tables.

## Telegram contract

RV-00 accepts both `message` and `callback_query`, after checking private
chat and Telegram user ID `976684739`. It sends one normalized request to
Core:

```json
{
  "telegramUserId": "976684739",
  "chatId": "976684739",
  "messageText": "/new"
}
```

or:

```json
{
  "telegramUserId": "976684739",
  "chatId": "976684739",
  "callbackToken": "rv_opaque_token"
}
```

Core replies with safe Telegram text and optional inline-button rows. Buttons
contain only an opaque, short-lived callback token (`rv:<token>`), never IDs,
costs, prompts, or request UUIDs. n8n answers the callback query immediately,
then sends the returned message to the authenticated originating chat.

## Core persistence and safety

Add Prisma-backed Rovelle-only tables:

- `rovelle_creator_sessions`: one current JSON step/data record per Telegram
  operator; user ID is unique.
- `rovelle_creator_actions`: random opaque token, target Telegram user,
  action payload, expiry, and consumed time. Token values are unique.

Actions are consumed atomically. A duplicate click returns the stored safe
result or an expired/already-used response, never repeats a paid submission.
Core creates a stable request UUID before any state-changing action. New
Rovelle migration is additive and requires the approved design/plan only.

## Guided flow

`/start` shows `New episode`, `Canon`, and `My work`.

`/canon` first asks for an entity code and type. Core creates/updates only a
draft canon record, then returns a one-time Rovelle upload-page URL for the
selected image. The page opens a file picker, exchanges its opaque action
token for a short-lived direct R2 upload URL, confirms the asset with Core,
attaches it to the draft version, and returns to Telegram.
The user locks canon explicitly after reviewing its references. Existing
locked codes such as `KOKO` remain reusable by comma-separated selection.

`/new` collects a title, target duration, premise, learning goal, tone, and
selected existing canon codes. It then asks for one short shot direction per
message; `done` produces a readable episode/shot draft. Core creates the
episode code and `DRAFT` episode only after at least one direction exists.
There is no AI call, model cost, or automatic creative rewrite. `Confirm
draft` advances only the existing brief/preproduction/shot flow; it creates
no provider request and costs nothing.

After a confirmed shot plan, Core shows one button at a time:
`Generate shot N · est. $0.22`. Consuming that button explicitly authorizes
one DRAFT provider submission. It is not a preview. Core records the attempt
and existing budget accounting remains authoritative.

When Runware completion makes an attempt reviewable, `/my work` lists it.
Core returns `Approve shot` and `Regenerate shot · est. $0.22` actions.
Approve calls the existing generation-review endpoint semantics. Regenerate
creates a fresh paid request only after its own token is consumed; no refund,
and old attempts remain historical. Each approved shot unlocks the next
review/generation step.

After every shot is approved, `/audio` returns the same one-time mobile upload
page for one `AUDIO_MASTER` file. `Render episode` appears only after that
asset is available. It queues the existing render job; it never generates
video. Captions are deferred.

## Core API

Add one API-key-protected controller namespace:

`POST /api/rovelle/creator/telegram`

It validates exactly one of `messageText` or `callbackToken`, the normalized
numeric Telegram IDs, and returns:

```json
{
  "ok": true,
  "data": {
    "text": "Shot 1 is ready for review.",
    "inlineKeyboard": [[{"text":"Approve shot","callbackData":"rv:..."}]]
  }
}
```

The controller internally calls existing production, asset, canon, generation,
review, and render services; it does not duplicate their domain validation.
This is n8n's only creator-flow Core call. Existing domain endpoints remain
available for authenticated webhooks and operator recovery.

## Error handling and privacy

Reject non-private or non-allowlisted Telegram updates before Core. Core does
not return R2 presigned URLs in Telegram text or callback data. Expired,
foreign-user, malformed, and consumed tokens return a safe message. Core
errors preserve no prompts, URLs, tokens, headers, or provider errors in
Telegram replies. n8n continues using Aegis error handling and disables
execution data retention.

## Tests

Cover session step transitions, manual shot collection and `done`, token user
binding/expiry/single consumption, duplicate paid callback safety, exact spend
label, no-spend draft confirmation, canon/audio upload handoffs, per-shot
approval/regeneration behavior, input validation, controller envelope, and
n8n callback normalization. Test providers remain fakes; no paid generation
or R2 upload runs in tests.

## Deferred

- Captions.
- Social publication, scheduling, dashboard, and analytics.
- Multi-user operator/audit model.
