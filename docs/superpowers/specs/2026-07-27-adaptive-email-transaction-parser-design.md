# Adaptive Email Transaction Parser Design

## Goal

Make email transaction parsing resilient to changing bank templates without
calling AI repeatedly for formats a user has already confirmed.

The system remains confirmation-first for AI-parsed transactions. A confirmed
AI result may teach a safe, declarative parser template that handles later
matching emails deterministically.

## Scope

This design covers:

- transaction-email detection;
- existing hard-coded parser reuse;
- user-scoped learned parser templates;
- AI fallback and AI-assisted corrections;
- Telegram review actions;
- template validation, activation, disablement, and diagnostics;
- focused Core API and n8n integration changes.

This design does not include:

- executable AI-generated code, SQL, or unrestricted regular expressions;
- global or cross-user template promotion;
- embeddings or vector search;
- a parser-template administration dashboard;
- Gmail triggers, Gmail credentials, Telegram sending, or callback ownership
  moving out of n8n;
- production database migration or n8n deployment.

## Current Behavior

`POST /api/veyra/transactions/email/handle` currently:

1. deduplicates by Gmail message ID;
2. normalizes plain text and HTML;
3. detects BCA, Mandiri, or Krom templates;
4. runs one of five hard-coded parsers;
5. validates extracted transaction fields;
6. resolves merchant aliases and categories;
7. confirms safe deterministic results or returns a review status;
8. records parse diagnostics.

Known-provider emails with an unfamiliar structure return
`unsupported_template`. The handler does not currently call AI or execute
database-driven parser templates.

## Architecture

Parsing uses this fixed order:

1. existing hard-coded parser;
2. active learned template for the user and sender;
3. AI structured extraction fallback.

Hard-coded parsers retain priority and remain unchanged unless a separate
migration explicitly modifies them.

### Transaction Detection

Before AI fallback, Core API determines whether the message is probably a
transaction. Detection uses:

- an exact previously trusted sender address or domain;
- passing sender-authentication metadata from Gmail when available;
- known bank/provider signals;
- amount or currency signals;
- transaction language in the subject or body;
- negative signals for marketing and promotional messages.

Detection is conservative. An untrusted or weakly classified email is not
automatically saved and cannot create an active template.

A learned template may auto-save only when the sender matches and Gmail reports
the provider domain as authenticated. If authentication metadata is unavailable,
the template may parse the email but the result still requires confirmation.

### Learned Template Interpreter

Learned templates are declarative data interpreted by Core API. A template may
contain:

- exact sender address or domain;
- provider and transaction kind;
- ordered literal anchors;
- required and forbidden literal anchors;
- field rules using literal `after` and optional `before` boundaries;
- built-in field types such as `idr_amount`, `datetime`, and `text`;
- a fixed supported transaction type where appropriate.

Templates cannot contain JavaScript, SQL, shell commands, arbitrary expressions,
or unrestricted regular expressions.

Matching requires the same user, compatible sender, and matching anchors.
Extracted values must pass the existing transaction validation:

- positive amount;
- supported transaction type;
- valid transaction date;
- non-empty merchant where required;
- integer confidence from 0 through 100.

If no learned template produces a valid result, processing falls back to AI.

## AI Contract

Email content is untrusted input. The AI receives it as data and must return a
strict structured response containing:

- whether the email is a transaction;
- provider;
- transaction type;
- amount and currency;
- merchant;
- transaction date;
- payment type;
- confidence and warnings;
- a declarative template proposal.

Core API validates the structured response. It then runs the proposed template
against the current email and verifies that the result reproduces the proposed
amount, merchant, date, and transaction type.

The AI cannot insert, update, activate, or disable database templates directly.
It only proposes data that Core API validates.

## Review and Learning Flow

An AI-parsed transaction is always presented to the user with:

- Save;
- Edit details;
- Change category;
- Cancel.

### Save

On confirmation, Core API:

1. saves the reviewed transaction;
2. activates the already validated proposal for that user;
3. records the parser source and learned-template identifier.

If the proposal did not pass validation, the transaction may still be
confirmed, but no template is activated.

### Edit Details

The user sends one natural-language correction. The AI may change:

- amount;
- merchant;
- transaction date;
- transaction type.

The correction reuses the existing transaction change schema. n8n refetches
the original Gmail message by message ID and sends the email, existing
candidate, and correction to Core API. Core API validates the revised
candidate and revised template, then shows the complete transaction for
confirmation again.

The previous candidate remains unchanged if correction parsing fails.

### Change Category

Category review continues through the existing category flow. Category changes
may teach merchant categorization, but do not modify or disable the email
extraction template.

### Cancel

Cancellation saves neither the transaction nor the proposed learned template.

## Automatic Parsing After Learning

A valid result from an active learned template behaves like an existing
deterministic parser. It may save automatically only when the existing merchant
alias, category, amount, date, transaction type, deduplication, and confidence
guards pass.

Any failed guard routes the email to the existing review or AI fallback path.

## Storage

Add one `email_parser_templates` table through a separate migration. The
minimum persisted information is:

- user ID;
- provider;
- exact sender address or domain;
- template name or key;
- template version;
- declarative matching and extraction rules in JSONB;
- structural fingerprint;
- status: `active` or `disabled`;
- created, updated, last-matched, and disabled timestamps.

Pending proposals do not require another table. Store the validated proposal,
candidate values, Gmail message ID, and structural fingerprint in the pending
transaction's existing `raw_payload`.

Do not persist the full email body. Existing trimmed diagnostic samples may
remain. n8n refetches the Gmail message for asynchronous AI corrections.

Transactions produced by a learned template record `parserSource = "learned"`
and the template ID in `raw_payload`. Other parser sources are `hardcoded` and
`ai`.

## Template Disablement

If the user later edits the amount, merchant, transaction date, or transaction
type of a transaction created automatically by a learned template, Core API
disables that user-scoped template. The next matching email uses AI
confirmation again.

Category-only edits do not disable the extraction template.

No automatic cross-user promotion occurs in this version.

## Failure Handling

- AI unavailable or invalid output: record `needs_review`; do not auto-save or
  activate a template.
- AI identifies a non-transaction: retain diagnostics and do not save.
- Valid candidate with invalid proposal: allow confirmation, but do not learn.
- Learned template does not match or extract valid fields: fall back to AI.
- AI correction fails: retain the previous candidate and ask the user to retry.
- Duplicate Gmail message ID: return the existing transaction or review state;
  never create a second transaction or active proposal.
- Database template activation fails after transaction confirmation: keep the
  confirmed transaction and report/log the learning failure for retry; do not
  roll back a valid user-confirmed transaction.

### Idempotency and Retry

The existing unique `(user_id, source, source_reference)` import key remains
authoritative. Terminal confirmed or cancelled imports are never reprocessed.
Retryable AI failures and pending reviews resume the existing import by review
identifier instead of returning a permanent duplicate or inserting another
transaction. Repeated initial delivery returns the existing review state and
does not call AI again when a valid candidate is already stored.

## n8n Boundary

n8n keeps:

- Gmail Trigger nodes;
- Gmail message fetching and refetching;
- extracting sender-authentication results from Gmail headers;
- Telegram message sending;
- callback routing;
- simple HTTP Request orchestration;
- credentials and retries.

Core API owns:

- transaction detection;
- hard-coded and learned parser selection;
- learned-template interpretation;
- AI structured extraction and correction;
- candidate and proposal validation;
- template activation and disablement;
- transaction persistence and diagnostics.

The implementation documentation must include example n8n HTTP Request
payloads for:

1. initial email handling;
2. AI fallback review;
3. AI-assisted detail correction with the refetched email;
4. confirmation, cancellation, and category routing.

The initial email payload includes normalized sender-authentication results
when Gmail exposes them. No credentials or raw authentication headers are
stored.

## Proposed Files

Keep the change focused. Expected files are:

- `src/veyra/transactions/email-parsers.ts` for the safe declarative
  interpreter and shared extraction primitives;
- `src/veyra/transactions/transaction.service.ts` for parser ordering,
  AI-review orchestration, learning, and disablement;
- email transaction DTOs for structured AI, proposal, and correction
  contracts;
- one migration SQL file for `email_parser_templates`;
- focused transaction/parser tests and fixtures;
- `docs/veyra-database-schema.md` after the migration is approved;
- `README.md` for n8n HTTP Request payloads and node boundaries.

No new dependency should be added unless the existing runtime cannot perform
the required structured HTTP call safely.

## Test Plan

Focused runnable tests must demonstrate:

1. existing hard-coded parsers retain priority;
2. a matching learned template parses without calling AI;
3. an unknown or changed structure calls AI;
4. AI results cannot auto-save before confirmation;
5. confirmation activates only a previously validated proposal;
6. a corrected candidate revalidates its proposal;
7. invalid rules and prompt-injection text cannot activate templates;
8. bad amounts, dates, and transaction types fail validation;
9. duplicate Gmail message IDs remain idempotent;
10. category-only corrections do not disable extraction templates;
11. material corrections disable the responsible learned template;
12. no full email body is stored.

Fixtures should include known successful templates, changed-anchor variants,
marketing messages, HTML-only emails, conflicting amounts, missing fields, and
prompt-injection text inside the email body.

## Risks and Mitigations

- **Overfitted template:** match exact sender plus several stable ordered
  anchors, and fall back to AI on any validation failure.
- **Incorrect but syntactically valid extraction:** require the proposal to
  reproduce confirmed values and disable the template after a later material
  correction.
- **Prompt injection in email content:** use strict structured output, treat
  email content as data, whitelist template operations, and validate every
  output locally.
- **Sensitive email retention:** store no full email body and refetch from
  Gmail only when a correction requires it.
- **One user affecting another:** keep learned templates user-scoped.
- **Unreviewed production changes:** create migration and n8n changes
  separately; do not apply or deploy them without explicit approval.

## Success Criteria

The design succeeds when:

- the first unsupported transaction format uses AI and requires confirmation;
- confirmation produces a validated user-scoped template;
- a later matching email parses without AI and may auto-save through existing
  guards;
- changing formats fall back safely to confirmation;
- user corrections improve or disable learning without corrupting confirmed
  transactions;
- raw email bodies are not retained;
- existing n8n trigger, fetch, callback, and Telegram responsibilities remain
  intact.
