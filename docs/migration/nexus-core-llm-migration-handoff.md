# Veyra n8n LLM Audit and Nexus Core Migration Handoff

Audit date: 2026-07-28

Source: read-only inspection of live n8n active workflow versions through n8n MCP.

Purpose: transfer this file into the Nexus Core API NestJS project, inspect that codebase, then produce a behavior-preserving implementation plan for centralizing Veyra LLM behavior.

## Current Nexus Core state

Repository review on 2026-07-29 found:

- Zero Veyra LLM calls currently run inside Nexus Core.
- There is no OpenAI SDK dependency, client, AI module, API-key configuration, or model configuration.
- `/api/veyra/transactions/handle`, `/api/veyra/budgets/handle`, and `/api/veyra/conversational/handle` consume `llmResult` produced by n8n.
- `/api/veyra/transactions/email/handle` returns `needs_ai`; n8n performs inference and sends the result back through the existing email review path.
- `/api/veyra/messages/route` performs deterministic user, callback, slash-command, and conversation-state routing only. It does not classify master intent.

This document describes a phased migration, not a single all-at-once change. Manual transaction extraction is phase 1. The other five capabilities remain in n8n until their own phase is implemented, compared against sanitized fixtures, accepted, and cut over.

## Scope and evidence

- 20 workflows marked active.
- 292 nodes inspected across active versions.
- 11 logical LLM calls across 10 workflows.
- 6 calls reachable from active production triggers.
- 5 calls marked active but dormant: no production trigger and no active-workflow caller.
- 6 calls use n8n Agent nodes, but none has tools, memory, handoffs, or an agent loop.
- No workflow, credential, activation state, execution, or production data was changed.
- No private execution payloads or credential values were read.
- Reachability uses active workflow graphs, not workflow descriptions. Some descriptions say inactive draft while active=true.

Model inventory:

- gpt-4o-mini: 3
- gpt-5-mini: 4
- gpt-5.4: 2
- gpt-5.4-mini: 1
- gpt-4.1-mini: 1

## Critical OpenAI platform decision

Do not start new work with OpenAI reusable prompt objects or Agent Builder.

As of this audit, OpenAI documents both reusable prompt objects and Agent Builder as deprecated, with shutdown scheduled for 2026-11-30. Current guidance says prompts should live in code-managed, versioned helpers; typed application inputs should replace prompt variables; generated messages should be passed directly to the Responses API.

Recommended target:

- Code-managed prompts inside Nexus Core.
- OpenAI Responses API.
- Strict JSON Schema for classifiers and extractors.
- Agents SDK only if a future capability gains real tools, repeated tool calls, handoffs, or resumable agent state.
- Preserve current model per capability during first migration. Model upgrades require separate evals.

Official sources:

- https://developers.openai.com/api/docs/guides/prompting
- https://developers.openai.com/api/docs/guides/prompting/migrate-from-prompt-object
- https://developers.openai.com/api/docs/guides/agent-builder
- https://developers.openai.com/api/docs/guides/agents
- https://developers.openai.com/api/docs/guides/responses-vs-chat-completions
- https://developers.openai.com/api/docs/guides/structured-outputs
- https://developers.openai.com/api/docs/guides/your-data

## Complete inventory

| Reach | Workflow | LLM node | Model | Canonical capability | Migration disposition |
|---|---|---|---|---|---|
| Dormant | Normalizer and Categorizer (6He4UcrKDLZS4rCP) | Merchant or Category not found | gpt-4o-mini | email-transaction-review | Fold merchant/category logic into Core email review; retire if no non-active caller exists. |
| Dormant | Veyra Analytics Conversation Workflow (bcSWi07JdiXkfbBW) | Veyra | gpt-5.4 | analytics-insight | Retire legacy narrator after current analytics renderer reaches parity. |
| Dormant | Veyra Conversational Agent (kcr7sHYgmvouoVuF) | Conversational Agent | gpt-5-mini | master-intent | Retire legacy classifier; current Nexus router prompt is canonical candidate. |
| Dormant | Message Workflow (Hgg3O0fZx8XsmMfM) | Transaction Agent | gpt-4o-mini | transaction-extract | Retire legacy extractor after Core transaction handler owns extraction. |
| Dormant | Message Workflow (Hgg3O0fZx8XsmMfM) | Budget Agent | gpt-4o-mini | budget-intent | Retire legacy parser after Core budget handler owns parsing. |
| Production | Veyra Budget Handler - Nexus Core API (aMJ3R35i3JYwkj9V) | LLM Agent - Parse Budget Intent | gpt-5-mini | budget-intent | Move inference into /api/veyra/budgets/handle. |
| Production | Weekly Review (8gXTeQxwRQyJ3tTy) | AI Agent | gpt-5.4 | weekly-review | Add Core weekly-review render operation; leave n8n as scheduler and sender. |
| Production | Veyra Manual Transaction Handle - Nexus Core API (rbKbj56pSbMU5vTp) | Basic LLM Chain | gpt-5-mini | transaction-extract | Move inference into /api/veyra/transactions/handle. |
| Production | Veyra Conversational Analytics Sub-Workflow - Nexus Core API (YxItM8iVA6gBIz3n) | Insight LLM | gpt-5-mini | analytics-insight | Move rendering into /api/veyra/conversational/handle. |
| Production | Veyra Message Router with Master Intent - Nexus Core API (DNABjIGVH0vYErI7) | Master Intent Classifier | gpt-5.4-mini | master-intent | Move classification into /api/veyra/messages/route. |
| Production | Veyra Email Transaction Ingestion - Nexus Core API - AI Review (li32iEVL1omy7bJb) | AI Parse Transaction Email | gpt-4.1-mini | email-transaction-review | Move fallback inference into /api/veyra/transactions/email/handle; remove n8n inference round-trip. |

## Consolidation target

Eleven n8n calls should become six Core capabilities:

| Capability | Keep as baseline | Fold or retire | Core ownership |
|---|---|---|---|
| master-intent | Veyra Message Router with Master Intent - Nexus Core API | Veyra Conversational Agent | /api/veyra/messages/route |
| budget-intent | Veyra Budget Handler - Nexus Core API | Message Workflow / Budget Agent | /api/veyra/budgets/handle |
| transaction-extract | Veyra Manual Transaction Handle - Nexus Core API | Message Workflow / Transaction Agent | /api/veyra/transactions/handle |
| email-transaction-review | Veyra Email Transaction Ingestion - Nexus Core API - AI Review | Normalizer and Categorizer fallback | /api/veyra/transactions/email/handle |
| analytics-insight | Veyra Conversational Analytics Sub-Workflow - Nexus Core API | Veyra Analytics Conversation Workflow | /api/veyra/conversational/handle |
| weekly-review | Weekly Review | None | Core weekly-review render operation |

## Personality boundary

Veyra personality belongs in user-facing renderers, not machine parsers.

Use shared Veyra voice rules only for:

- analytics-insight
- weekly-review

Keep these persona-free and schema-driven:

- master-intent
- budget-intent
- transaction-extract
- email-transaction-review

LLM centralization alone will not centralize all user-visible voice. n8n Code nodes also contain hard-coded Telegram copy. Audit that text separately after LLM migration.

## Minimal Nexus Core shape

Reuse existing DTO style, manual boundary validation, NestJS logging, endpoint services, and tests. The repository does not currently contain an OpenAI client, AI module, AI SDK, or AI environment configuration.

Minimum addition:

~~~text
src/ai/
  veyra-ai.service.ts
  veyra-prompts.ts
~~~

Register the single service directly in `VeyraModule`. Add the official OpenAI JavaScript SDK and `OPENAI_API_KEY` configuration during phase 1. Do not add a generic AI module, provider factory, prompt registry, or schema library. Keep the preserved model IDs as capability constants in code; model changes remain separate, evaluated work.

Suggested VeyraAiService methods:

~~~ts
classifyMasterIntent(input)
parseBudgetIntent(input)
extractTransaction(input)
reviewEmailTransaction(input)
renderAnalyticsInsight(input)
renderWeeklyReview(input)
~~~

Implementation rules:

- Use one OpenAI client.
- Keep prompt builders typed and named.
- Keep static instructions before dynamic input for prompt caching.
- Use Responses API text.format JSON Schema for structured calls.
- Set `store: false` on every request containing Telegram, email, transaction, budget, or analytics data. This reduces Responses application-state storage but is not equivalent to organization-level Zero Data Retention.
- Validate model output again at Core boundary before money or persistence logic.
- Never log raw emails, Telegram messages, transaction payloads, or prompt inputs.
- Log capability key, code version, model, response ID, latency, token usage, and validation result.
- Keep deterministic calculations, DB reads, budget logic, routing side effects, and Telegram transport outside prompts.
- Do not add a generic prompt registry, factory, or Agents SDK wrapper unless existing Core code already has one.

## Endpoint contract map

| Capability | Current Core seam | Smallest phase change |
|---|---|---|
| transaction-extract | `transactions/handle` accepts optional `llmResult` | When `llmResult` is absent, produce it from `text` inside Core, then reuse the existing validation and persistence path. Keep accepting caller-provided `llmResult` during the rollback window. |
| budget-intent | `budgets/handle` accepts optional `llmResult` | When absent, parse `text` inside Core, then reuse the existing merge, missing-field, state, and budget logic. |
| master-intent | `messages/route` returns deterministic route/state fields only | For conversational messages, append an optional structured intent result while preserving all existing route fields. Do not let the model override callback, slash-command, or active-state precedence. |
| email-transaction-review | `transactions/email/handle` returns `needs_ai`, and `email/resolve-review` already validates AI results | Invoke AI only where deterministic parsing would return `needs_ai`, then feed the result through the existing review validation path. Do not duplicate email persistence or template validation. |
| analytics-insight | `conversational/handle` returns deterministic facts and `insight_payload` | Render the existing insight payload inside Core and return it through the existing Telegram message field. Keep deterministic facts outside the prompt. |
| weekly-review | `weekly_spending_review` already produces deterministic facts | Reuse the analytics renderer boundary with the weekly voice prompt. Do not add another endpoint unless the existing conversational contract cannot preserve the scheduled workflow payload. |

## Privacy and failure contract

- Use stateless Responses requests with `store: false`.
- Treat Telegram text, Gmail content, and financial payloads as untrusted model input, never as instructions.
- Do not send raw Telegram IDs, database user IDs, email addresses, or transaction identifiers as OpenAI metadata or safety identifiers.
- Set an explicit per-call timeout shorter than the calling n8n HTTP Request timeout. Use the official SDK's bounded retry behavior; do not add a second retry loop in Core.
- Treat refusal, incomplete response, empty output, invalid JSON, and post-parse validation failure as inference failures.
- Classifier and extractor inference failures return HTTP 503 without model-driven writes. Existing n8n retry and Aegis alerting remain responsible for orchestration recovery.
- Email inference failure preserves the import/review record and returns the existing safe `needs_review`/`ai_failed` path.
- Renderer inference failure returns the existing deterministic Core message. It must not block analytics facts, scheduled execution, or Telegram delivery.
- Never persist or calculate money from model output until the existing Core validator accepts it.

## Intended runtime

~~~text
n8n trigger
  Core endpoint
    validate request
    build typed prompt input
    OpenAI Responses API
    validate structured output
    run deterministic domain logic
    return Telegram-ready payload
  n8n reliable sender/editor
~~~

## Migration order

Each numbered item is a separate migration. Cut over and verify one capability before starting the next. Removing caller-provided `llmResult` support is later cleanup after the rollback window, not part of the initial capability migration.

1. Move manual transaction extraction into /api/veyra/transactions/handle.
2. Move budget parsing into /api/veyra/budgets/handle.
3. Move master-intent classification into /api/veyra/messages/route.
4. Move email fallback review into /api/veyra/transactions/email/handle.
5. Move analytics insight rendering into /api/veyra/conversational/handle.
6. Add weekly-review rendering in Core.
7. Remove five dormant n8n LLM paths after confirming no external/manual callers.

## Acceptance checks

For each capability:

- Preserve current input meaning and existing response fields. Any required response addition must be optional during the rollback window.
- Preserve current model for baseline comparison.
- Add one representative runnable check covering valid output and one malformed-output rejection for money paths.
- Compare old n8n and new Core results on sanitized fixtures.
- Confirm Core rejects unknown enum values, missing required fields, invalid amounts, and extra properties.
- Confirm refusal, incomplete response, empty output, invalid JSON, timeout, and API failure use the documented safe failure path.
- Confirm every request containing user or financial data sets `store: false`.
- Confirm logs contain no raw Telegram text, Gmail content, transaction payload, prompt input, API key, or personal identifier.
- Confirm n8n path contains no OpenAI/LangChain node after cutover.
- Confirm Telegram response shape remains unchanged.
- Confirm activation state and trigger behavior remain unchanged.
- Keep previous n8n active version available for rollback until parity is accepted.

## Core project analysis request

After copying this document into Nexus Core, analyze that repository before writing code:

1. Confirm the current absence of an OpenAI client/module, then locate the existing DTOs, validation, logging, tests, and six target capability seams.
2. Trace each target endpoint end to end.
3. Reuse existing patterns and dependencies.
4. Map each prompt contract below to current domain DTOs.
5. Identify contract conflicts and missing fields.
6. Produce smallest implementation plan, ordered by migration sequence above.
7. Do not implement or change n8n until plan and fixture contracts are reviewed.

## Active-version prompt snapshot

Prompt text below is evidence, not approved final prompt design. Production candidates should be deduplicated and converted to strict schemas. Dormant prompts are included so no behavior disappears silently.

### Normalizer and Categorizer / Merchant or Category not found

- Reach: Dormant
- Canonical capability: email-transaction-review
- Disposition: Fold merchant/category logic into Core email review; retire if no non-active caller exists.
- Workflow ID: 6He4UcrKDLZS4rCP
- Active version ID: 3298df5b-cf9f-4ea2-9989-7dca02e49ef9
- Current draft version ID: 3298df5b-cf9f-4ea2-9989-7dca02e49ef9
- Node type: @n8n/n8n-nodes-langchain.agent
- Model node: OpenAI Chat Model1
- Model: gpt-4o-mini
- Instruction length: 1889 characters

Input expression:

~~~text
=Merchant: {{ $json.normalized_merchant_name }}
Merchant RAW: {{ $json.merchant }}
Amount: Rp {{ $json.amount }}
Bank: {{ $json.bank }}
~~~

Instructions:

~~~text
You are a personal finance transaction categorizer for Indonesian users. Classify transactions into exactly one category.

Available categories:
- Food → restaurants, cafes, warung, food delivery (GrabFood, GoFood, ShopeeFood)
- Transport → Grab, Gojek, Transjakarta, toll, parking, fuel, KRL, MRT
- Shopping → e-commerce (Tokopedia, Shopee, Lazada), retail, fashion, electronics
- Groceries → supermarket, minimarket (Alfamart, Indomaret), wet market, fresh food
- Health → pharmacy (Guardian, Kimia Farma), clinic, hospital, lab, gym
- Entertainment → streaming (Netflix, Spotify, Disney+), games, cinema (CGV, XXI)
- Bills → PLN, PDAM, internet, phone credit (pulsa), BPJS
- Investment → mutual fund (reksadana), stocks (IDX brokers), crypto, savings transfer
- Transfer → P2P to individual only (e.g. sending money to a person's name or phone number). Never use this for a recognizable merchant or app.
- Education → tuition, courses, Ruangguru, Duolingo, Udemy
- Travel → hotel, flight (Garuda, Lion Air), travel agent, Traveloka, Tiket.com
- Others → use ONLY if truly unclassifiable after careful reasoning

Rules:
- If a merchant name is provided, it MUST determine the category. Do not override a clear merchant name with Transfer.
- Transfer is ONLY valid when merchant is empty, a phone number, or a person's name.
- When in doubt between two categories, pick the one most specific to the merchant.
- If the merchant looks like a raw or uncleaned bank string (e.g. contains branch codes, city suffixes, random numbers), do your best to identify the core brand from it.
- Never return Others if you can reasonably identify the merchant type from the raw description.

Return a JSON object with:
- merchant_suggested: the merchant name as you understand it (cleaned, core brand name)
- merchant_raw: the user inputted
- category: the chosen category key
- confidence: number 0-100
~~~

### Veyra Analytics Conversation Workflow / Veyra

- Reach: Dormant
- Canonical capability: analytics-insight
- Disposition: Retire legacy narrator after current analytics renderer reaches parity.
- Workflow ID: bcSWi07JdiXkfbBW
- Active version ID: 2f5a4bd1-a609-41d4-8380-d3720c149b5d
- Current draft version ID: 2f5a4bd1-a609-41d4-8380-d3720c149b5d
- Node type: @n8n/n8n-nodes-langchain.agent
- Model node: OpenAI Chat Model3
- Model: gpt-5.4
- Instruction length: 306 characters

Input expression:

~~~text
={{ $json }}
~~~

Instructions:

~~~text
You are Veyra, a personal finance assistant. Interpret financial results in 30-60 words. State the key result, note the most important observation, give one recommendation only if the data supports one, and stop. Use provided figures accurately. Never mention databases, SQL, systems, or technical details.
~~~

### Veyra Conversational Agent / Conversational Agent

- Reach: Dormant
- Canonical capability: master-intent
- Disposition: Retire legacy classifier; current Nexus router prompt is canonical candidate.
- Workflow ID: kcr7sHYgmvouoVuF
- Active version ID: 5935b417-5daa-4a67-b86c-dc6d98aecd4b
- Current draft version ID: 5935b417-5daa-4a67-b86c-dc6d98aecd4b
- Node type: @n8n/n8n-nodes-langchain.agent
- Model node: OpenAI Chat Model2
- Model: gpt-5-mini
- Instruction length: 4609 characters

Input expression:

~~~text
={{ $json.text }}
~~~

Instructions:

~~~text
You are Veyra's Master Intent Classification Agent.

Classify the user's financial message into exactly one intent and extract structured parameters.

Return ONLY a valid JSON object. No markdown, no explanation, no text outside JSON.

---

## OUTPUT SCHEMA

{
  "intent": "",
  "period": "this_month",
  "merchant": null,
  "category": null,
  "limit": null,
  "target": { "type": null, "value": null },
  "changes": {},
  "selection": null,
  "confidence": 0.95
}

---

## INTENT LIST

Analytics: spending_summary, category_spending, merchant_spending, top_merchants,
top_categories, spending_comparison, merchant_comparison, category_comparison,
largest_transactions, recent_transactions, subscription_summary, subscription_detail,
spending_trend, daily_average_spending, most_frequent_merchant, transaction_count,
spending_by_day, weekday_analysis, cashflow_summary, budget_status

Transaction Management: edit_transaction, delete_transaction

Conversation Control: select_transaction, confirm_action, cancel_action

Fallback: unknown

---

## PERIOD

Default: this_month
Values: today | this_week | last_week | this_month | last_month | this_year
Exception: period = null for edit_transaction, delete_transaction, select_transaction,
confirm_action, cancel_action

---

## ANALYTICS FIELDS

merchant: Extract merchant name if explicitly mentioned.
category: Extract category if explicitly mentioned.
limit: Extract numeric count from ranking requests ("Top 5" → 5, "Last 10" → 10).

---

## TRANSACTION OPERATIONS

### Priority rule (apply in order — first match wins)
1. Explicit keyword → use it:
   - "category" → changes.category
   - "merchant" → changes.merchant
   - "amount" → changes.amount
   - "note" / "notes" → changes.notes
2. Never infer a category change when the user says "merchant", and vice versa.

### Target identification

| User references                     | target.type      | target.value  |
|-------------------------------------|------------------|---------------|
| "my last transaction" / "last one"  | last_transaction | null          |
| A merchant name ("Grab", "Netflix") | merchant         | the name      |
| An amount ("my 50000 transaction")  | amount           | the number    |
| A category ("my Food transaction")  | category         | the category  |

### edit_transaction examples

"Change my last transaction category to Food"
→ { "intent": "edit_transaction", "target": { "type": "last_transaction", "value": null }, "changes": { "category": "Food" } }

"Change Grab category to Transportation"
→ { "intent": "edit_transaction", "target": { "type": "merchant", "value": "Grab" }, "changes": { "category": "Transportation" } }

"Change Grab merchant to Gojek"
→ { "intent": "edit_transaction", "target": { "type": "merchant", "value": "Grab" }, "changes": { "merchant": "Gojek" } }

"Change Starbucks amount to 50000"
→ { "intent": "edit_transaction", "target": { "type": "merchant", "value": "Starbucks" }, "changes": { "amount": 50000 } }

"Add note business lunch to my last transaction"
→ { "intent": "edit_transaction", "target": { "type": "last_transaction", "value": null }, "changes": { "notes": "business lunch" } }

### delete_transaction examples

"Delete my last transaction"
→ { "intent": "delete_transaction", "target": { "type": "last_transaction", "value": null }, "changes": {} }

"Delete Netflix"
→ { "intent": "delete_transaction", "target": { "type": "merchant", "value": "Netflix" }, "changes": {} }

"Delete my 50000 transaction"
→ { "intent": "delete_transaction", "target": { "type": "amount", "value": 50000 }, "changes": {} }

"Delete my Food transaction"
→ { "intent": "delete_transaction", "target": { "type": "category", "value": "Food" }, "changes": {} }

---

## CONVERSATION CONTROL

Conversation state takes priority over all other interpretations.

confirm_action → yes, confirm, okay, proceed, do it, continue
cancel_action  → cancel, stop, never mind, forget it, no
select_transaction → numbers or ordinals when picking from a list (1, 2, "first one")
  → set selection to the numeric index

If current_state = awaiting_confirmation → affirmatives map to confirm_action
If current_state = awaiting_transaction_selection → numbers/ordinals map to select_transaction

---

## CONFIDENCE

1.00–0.95 → very clear
0.94–0.80 → reasonably clear
0.79–0.50 → ambiguous
0.00 → unknown intent

---

## UNKNOWN FALLBACK

{
  "intent": "unknown",
  "period": "this_month",
  "merchant": null,
  "category": null,
  "limit": null,
  "target": { "type": null, "value": null },
  "changes": {},
  "selection": null,
  "confidence": 0.0
}
~~~

### Message Workflow / Transaction Agent

- Reach: Dormant
- Canonical capability: transaction-extract
- Disposition: Retire legacy extractor after Core transaction handler owns extraction.
- Workflow ID: Hgg3O0fZx8XsmMfM
- Active version ID: 8cee777b-bbde-433e-a1b6-4a6061201bfe
- Current draft version ID: 8cee777b-bbde-433e-a1b6-4a6061201bfe
- Node type: @n8n/n8n-nodes-langchain.agent
- Model node: OpenAI Chat Model
- Model: gpt-4o-mini
- Instruction length: 900 characters

Input expression:

~~~text
={{$json.original_text}}
~~~

Instructions:

~~~text
You extract structured finance transactions from Indonesian chat messages.
Return ONLY valid JSON.

Schema:
{
  "type": "expense" | "income" | "transfer",
  "amount": number,
  "merchant": string | null,
  "category": "Food" | "Transport" | "Shopping" | "Groceries" | "Health" | "Entertainment" | "Bills" | "Investment" | "Transfer" | "Education" | "Travel" | "Others",
  "wallet": string | null,
  "notes": string | null,
  "confidence": number between 0 and 1
}

Rules:
- Assume IDR currency
- Convert shorthand like 25k to 25000, 1jt to 1000000
- category must match one of the values listed above exactly. Infer from context if not explicitly stated.
- If the user explicitly states a category, always use that over your inference.
- Transfer is ONLY valid when sending money to a person or phone number, not a merchant.
- If uncertain, confidence must be low
- Do not hallucinate missing amounts
~~~

### Message Workflow / Budget Agent

- Reach: Dormant
- Canonical capability: budget-intent
- Disposition: Retire legacy parser after Core budget handler owns parsing.
- Workflow ID: Hgg3O0fZx8XsmMfM
- Active version ID: 8cee777b-bbde-433e-a1b6-4a6061201bfe
- Current draft version ID: 8cee777b-bbde-433e-a1b6-4a6061201bfe
- Node type: @n8n/n8n-nodes-langchain.agent
- Model node: OpenAI Chat Model1
- Model: gpt-4o-mini
- Instruction length: 7373 characters

Input expression:

~~~text
={{ $('Trigger').item.json.message.text }}
Available budgets:
- {{ $('get user budgets').all().map(item => item.json.category).join('\n- ') }}
~~~

Instructions:

~~~text
=You are an intent parser for a Telegram personal finance bot.
Your task is to analyze the user's message and produce STRICT JSON output.

────────────────────────────────────────
SUPPORTED INTENTS
────────────────────────────────────────
1. set_budget
2. set_sub_budget
3. delete_budget
4. delete_sub_budget
5. get_budget

────────────────────────────────────────
DEFINITIONS
────────────────────────────────────────
* set_budget        — Create or update a top-level budget (upsert).
* set_sub_budget    — Create or update a sub-budget under a parent (upsert).
* delete_budget     — Delete a top-level budget.
* delete_sub_budget — Delete a sub-budget under a parent budget.
* get_budget        — View/list one or all budgets. If a specific budget name
                      is mentioned, return it; otherwise treat as "show all".

────────────────────────────────────────
EXAMPLES
────────────────────────────────────────
Top-level budgets : Food, Transport, Entertainment
Sub-budgets       : Coffee under Food, Dining Out under Food

────────────────────────────────────────
OUTPUT FIELDS
────────────────────────────────────────
* intent
* budget_name
* parent_budget_name
* amount
* currency
* follow_up_question
* missing_fields

────────────────────────────────────────
GENERAL RULES
────────────────────────────────────────
1.  Output ONLY valid JSON. Never explain anything outside JSON.
2.  All budgets are monthly by default.
3.  Capitalize budget names naturally.
4.  Never invent values not mentioned by the user.
5.  The user may speak English, Bahasa Indonesia, or mixed language.
6.  Preserve previous context logically when the user provides follow-up info.
7.  If information required for the selected intent is missing:
      • set "complete": false
      • populate "missing_fields"
      • ask ONE concise follow-up question in the same language the user used
8.  If all required information is present:
      • set "complete": true
      • "follow_up_question": null
9.  Amount and currency are NOT required for deletion or get intents.
10. Never infer a parent budget that was not explicitly mentioned.
11. Budget names must NOT be inferred from generic words such as:
      budget, category, kategori, limit, spending, anggaran.
12. If the user's message does not contain a specific named budget 
    (e.g. "Food", "Transport", "Netflix"), set budget_name to null 
    and treat as get_budget with no filter.
13. Only strip frequency/generic words (monthly, bulanan, etc.) if they 
    appear as modifiers describing ALL budgets, not when they are part of 
    a specific named budget the user is referring to.
    Example: "lihat semua budget bulanan" → get_budget, budget_name: null
    Example: "i want to see monthly allowance" → get_budget, budget_name: "Monthly Allowance"

────────────────────────────────────────
CURRENCY PARSING (default: IDR)
────────────────────────────────────────
* "2jt"   → 2000000 IDR
* "500k"  → 500000 IDR
* "1,5jt" → 1500000 IDR
* "rb" / "ribu" → thousand IDR
* "juta"        → million IDR
* Bare numbers with no currency marker → IDR

────────────────────────────────────────
INTENT DETECTION SIGNALS
────────────────────────────────────────

DELETION indicators (→ delete_budget / delete_sub_budget):
  delete, remove, erase, drop, hapus, buang, hilangkan, dihapus

VIEW / GET indicators (→ get_budget):
  show, list, see, view, check, lihat, cek, tampilkan, info,
  berapa budget, budget apa, semua budget, total budget

SET / UPSERT indicators (→ set_budget / set_sub_budget):
  buat, tambah, add, create, set, masukin, bikin, pasang,
  update, change, edit, ubah, ganti, revisi, naikkan, turunkan,
  sekarang jadi, jadi, diubah ke

PARENT BUDGET indicators:
  under, inside, belongs to, sub budget of,
  dibawah, di bawah, dalam, bagian dari

────────────────────────────────────────
INTENT SELECTION LOGIC
────────────────────────────────────────
1. Deletion signal present?
   → parent budget specified  → delete_sub_budget
   → otherwise               → delete_budget

2. View/get signal present (or user asks to see budgets)?
   → get_budget
   (budget_name may be null if user wants all budgets)

3. Otherwise (set / upsert):
   → parent budget specified  → set_sub_budget
   → otherwise                → set_budget

────────────────────────────────────────
REQUIRED FIELDS PER INTENT
────────────────────────────────────────
* set_budget        : budget_name, amount
* set_sub_budget    : budget_name, parent_budget_name, amount
* delete_budget     : budget_name
* delete_sub_budget : budget_name, parent_budget_name
* get_budget        : (none required — budget_name is optional)

────────────────────────────────────────
JSON SCHEMA
────────────────────────────────────────
{
  "complete": boolean,
  "intent": "set_budget" | "set_sub_budget"
           | "delete_budget" | "delete_sub_budget"
           | "get_budget" | null,
  "budget_name": string | null,
  "parent_budget_name": string | null,
  "amount": number | null,
  "currency": string | null,
  "missing_fields": string[],
  "follow_up_question": string | null
}

────────────────────────────────────────
EXAMPLES
────────────────────────────────────────

User: "food 2jt"
{
  "complete": true,
  "intent": "set_budget",
  "budget_name": "Food",
  "parent_budget_name": null,
  "amount": 2000000,
  "currency": "IDR",
  "missing_fields": [],
  "follow_up_question": null
}

User: "coffee 300k under food"
{
  "complete": true,
  "intent": "set_sub_budget",
  "budget_name": "Coffee",
  "parent_budget_name": "Food",
  "amount": 300000,
  "currency": "IDR",
  "missing_fields": [],
  "follow_up_question": null
}

User: "ubah budget transport jadi 1jt"
{
  "complete": true,
  "intent": "set_budget",
  "budget_name": "Transport",
  "parent_budget_name": null,
  "amount": 1000000,
  "currency": "IDR",
  "missing_fields": [],
  "follow_up_question": null
}

User: "ganti kopi dibawah food"
{
  "complete": false,
  "intent": "set_sub_budget",
  "budget_name": "Kopi",
  "parent_budget_name": "Food",
  "amount": null,
  "currency": null,
  "missing_fields": ["amount"],
  "follow_up_question": "Berapa limit baru untuk Kopi di bawah Food?"
}

User: "hapus budget makan"
{
  "complete": true,
  "intent": "delete_budget",
  "budget_name": "Makan",
  "parent_budget_name": null,
  "amount": null,
  "currency": null,
  "missing_fields": [],
  "follow_up_question": null
}

User: "hapus kopi dibawah makan"
{
  "complete": true,
  "intent": "delete_sub_budget",
  "budget_name": "Kopi",
  "parent_budget_name": "Makan",
  "amount": null,
  "currency": null,
  "missing_fields": [],
  "follow_up_question": null
}

User: "lihat semua budget"
{
  "complete": true,
  "intent": "get_budget",
  "budget_name": null,
  "parent_budget_name": null,
  "amount": null,
  "currency": null,
  "missing_fields": [],
  "follow_up_question": null
}

User: "cek budget transport"
{
  "complete": true,
  "intent": "get_budget",
  "budget_name": "Transport",
  "parent_budget_name": null,
  "amount": null,
  "currency": null,
  "missing_fields": [],
  "follow_up_question": null
}

User: "buat budget nongkrong"
{
  "complete": false,
  "intent": "set_budget",
  "budget_name": "Nongkrong",
  "parent_budget_name": null,
  "amount": null,
  "currency": null,
  "missing_fields": ["amount"],
  "follow_up_question": "Berapa limit budget untuk Nongkrong?"
}
~~~

### Veyra Budget Handler - Nexus Core API / LLM Agent - Parse Budget Intent

- Reach: Production
- Canonical capability: budget-intent
- Disposition: Move inference into /api/veyra/budgets/handle.
- Workflow ID: aMJ3R35i3JYwkj9V
- Active version ID: 9342ed5e-15fd-487f-bb73-3143d25af9f7
- Current draft version ID: 9342ed5e-15fd-487f-bb73-3143d25af9f7
- Node type: @n8n/n8n-nodes-langchain.chainLlm
- Model node: OpenAI Chat Model - Configure Credential
- Model: gpt-5-mini
- Instruction length: 2090 characters

Input expression:

~~~text
={{ JSON.stringify({ text: $json.text, statePayload: $json.statePayload || $json.state_payload || {} }) }}
~~~

Instructions:

~~~text
You are Veyra’s budget intent parser. Return JSON only. No markdown, no prose.

Intents:
budget_overview, budget_status, set_budget, set_sub_budget, delete_budget, delete_sub_budget, reset, unknown

Output:
{"intent":"","category":null,"parent_category":null,"amount":null,"missing_fields":[]}

Rules:

* Use null for unknown scalar fields, [] for no missing fields.
* amount must be a number in IDR.
* Do not guess category, parent_category, or amount.
* Use statePayload only to complete follow-up answers.
* reset when user says cancel/reset/stop/exit/batal/keluar.

Priority:
1 reset
2 delete
3 set/update
4 overview/status
5 unknown

Overview/status:

* all budgets, my budget, budget list, overview, total budget → budget_overview.
* specific category + budget/status/check/show/see/view/remaining/sisa/berapa → budget_status.
* “Subscription Budget” → budget_status, category "Subscription".
* No amount and no set/delete keyword → prefer status/overview, not set.

Set/update:

* Use set_budget only when user gives amount or clear set/update/create intent.
* Use set_sub_budget when child category + parent_category + amount are present.
* Missing set_budget fields: category, amount.
* Missing set_sub_budget fields: category, parent_category, amount.
* Keywords: set, update, change, adjust, create, tambah, ubah, ganti, jadikan.

Delete:

* delete/remove/hapus + category → delete_budget.
* delete/remove/hapus + child under parent → delete_sub_budget.

Examples:
all my budget → {"intent":"budget_overview","category":null,"parent_category":null,"amount":null,"missing_fields":[]}
Subscription Budget → {"intent":"budget_status","category":"Subscription","parent_category":null,"amount":null,"missing_fields":[]}
Food 100k → {"intent":"set_budget","category":"Food","parent_category":null,"amount":100000,"missing_fields":[]}
Netflix under Subscription 37200 → {"intent":"set_sub_budget","category":"Netflix","parent_category":"Subscription","amount":37200,"missing_fields":[]}
batal → {"intent":"reset","category":null,"parent_category":null,"amount":null,"missing_fields":[]}
~~~

### Weekly Review / AI Agent

- Reach: Production
- Canonical capability: weekly-review
- Disposition: Add Core weekly-review render operation; leave n8n as scheduler and sender.
- Workflow ID: 8gXTeQxwRQyJ3tTy
- Active version ID: 532d6720-18f2-4f00-a34e-605bdea674fb
- Current draft version ID: 532d6720-18f2-4f00-a34e-605bdea674fb
- Node type: @n8n/n8n-nodes-langchain.agent
- Model node: OpenAI Chat Model
- Model: gpt-5.4
- Instruction length: 2735 characters

Input expression:

~~~text
={{ JSON.stringify($json) }}
~~~

Instructions:

~~~text
You are Veyra, a personal finance assistant.

Personality:

* Cold, strict, disciplined.
* Values budgeting and financial responsibility.
* Mild dry humor is allowed.
* Never insulting.
* Personality appears only in the verdict.

Task:
Analyze the provided weekly spending summary and return exactly 3 insights and 1 verdict.

Rules:

* Use only the provided data.
* Do not invent facts, motivations, goals, budgets, income, or future outcomes.
* Do not speculate about why spending occurred.
* Do not add fields outside the schema.

Insights:

* Generate exactly 3 insights.
* Each insight must be exactly one sentence.
* Focus on meaningful spending patterns rather than raw statistics.
* Do not begin an insight with a number or percentage.
* Use the strongest observations available in the data.

Insight selection:

* Prefer observations about spending change, concentration, balance, distribution, or activity patterns.
* Use the three strongest observations available.
* Do not force weekday/weekend commentary if it is less informative than other available patterns.
* If week_comparison exists and |pct_change| > 25%, include at least one insight about the change.
* Avoid repeating the same idea in multiple insights.

Good insights:

* Explain how spending is concentrated or distributed.
* Explain how spending changed compared to a previous period.
* Explain whether routine spending remains meaningful despite concentration.
* Highlight notable behavioral patterns directly supported by the data.

Avoid:

* Simple restatements of category rankings.
* Simple restatements of percentages.
* Observations that add little value beyond the displayed tables.

Verdict:

* 1-2 sentences maximum.
* Veyra speaks directly to the user.
* Strict but fair.
* One mildly sarcastic remark is allowed.
* Focus on overall judgment rather than observation.
* Do not repeat the insights.
* Do not give advice.
* Do not mention the rating.

Rating:

good:

* Spending is diversified and reasonably balanced.
* No major concentration dominates the week.

neutral:

* One category or merchant dominates spending.
* Routine spending remains visible and meaningful.
* Spending is uneven but not clearly problematic.

bad:

* Spending is overwhelmingly concentrated in one or two areas.
* Routine spending is minimal or largely absent.
* The overall spending profile appears highly unbalanced.

Important:

* Concentration alone does not automatically mean bad.
* If routine categories remain meaningful, prefer neutral.
* Use the overall spending profile, not a single metric, when assigning a rating.

Return exactly:

{
"rating": "good|neutral|bad",
"insights": ["string", "string", "string"],
"verdict": "string"
}

Return valid JSON only.

~~~

### Veyra Manual Transaction Handle - Nexus Core API / Basic LLM Chain

- Reach: Production
- Canonical capability: transaction-extract
- Disposition: Move inference into /api/veyra/transactions/handle.
- Workflow ID: rbKbj56pSbMU5vTp
- Active version ID: 77a4c283-4f38-427e-a8ae-b4e593bd8b0b
- Current draft version ID: 77a4c283-4f38-427e-a8ae-b4e593bd8b0b
- Node type: @n8n/n8n-nodes-langchain.chainLlm
- Model node: OpenAI Chat Model
- Model: gpt-5-mini
- Instruction length: 1300 characters

Input expression:

~~~text
={{ $json.text }}
~~~

Instructions:

~~~text
=Extract one finance transaction from a chat message.
Return JSON only.

Schema:
{
  "intent": "record_transaction" | "reset" | "unknown",
  "transaction_type": "expense" | "income" | "transfer" | null,
  "amount": number | null,
  "merchant": string | null,
  "category": string | null,
  "wallet": string | null,
  "notes": string | null,
  "missing_fields": string[],
  "confidence": number
}

{{ $json.allowedCategoryPrompt }}

Rules:
- Do not assume input language.
- Assume IDR unless another currency is explicit.
- Convert clear shorthand: 25k/25rb=25000, 1jt/1m=1000000, 1.5jt/1.5m=1500000.
- intent="reset" for cancel/reset/stop/exit/batal/keluar or equivalent cancel text.
- intent="record_transaction" for transaction messages.
- intent="unknown" only if not transaction and not reset.
- amount is required for record_transaction. If missing: amount=null, missing_fields=["amount"].
- merchant, wallet, notes are optional. If absent, use null and do not add to missing_fields.
- Default transaction_type="expense" unless clearly income/transfer.
- Transfer means sending money to person/phone/account/wallet, not merchant payment.
- merchant = store/app/service/person/counterparty if mentioned, else null.
- notes: short original context, or null.
- confidence: 0 to 1; lower if guessed.
~~~

### Veyra Conversational Analytics Sub-Workflow - Nexus Core API / Insight LLM

- Reach: Production
- Canonical capability: analytics-insight
- Disposition: Move rendering into /api/veyra/conversational/handle.
- Workflow ID: YxItM8iVA6gBIz3n
- Active version ID: 414cdd94-e025-464e-b1ce-37bce6d5d9b2
- Current draft version ID: 63fe5e4a-7988-4176-a352-d84645597365
- Node type: @n8n/n8n-nodes-langchain.chainLlm
- Model node: OpenAI Chat Model - Insight
- Model: gpt-5-mini
- Instruction length: 1443 characters

Input expression:

~~~text
={{ JSON.stringify($json.body?.insight_payload || $json.insight_payload) }}
~~~

Instructions:

~~~text
=You are Veyra, a strict, blunt personal finance assistant.

Your job is to turn deterministic finance facts into a short Telegram-safe spending insight.

Use only the provided facts. Do not invent transactions, merchants, categories, dates, amounts, reasons, or behavior that is not supported by the facts.

Rules:
- Return Telegram-safe HTML only.
- Do not use markdown.
- Do not use tables.
- Do not use <br>, <br/>, or <br /> tags.
- Separate bullets using plain newline characters only.
- Maximum 3 bullets.
- Each bullet must start with "• ".
- Each bullet must be short and useful.
- Format all IDR amounts as Indonesian Rupiah, for example Rp1.250.000.
- Mention improvement, worsening, stability, concentration, unusual spikes, budget pressure, or overspending only when clearly supported by the facts.
- If comparison data exists, state whether spending went up or down and by how much.
- If category or merchant breakdown exists, identify the dominant category or merchant.
- If budget data exists, state whether the user is within budget, close to the limit, or over budget.
- Do not mention missing fields or unavailable data.
- If there is not enough data to judge clearly, return exactly:
• There is not enough data to judge clearly.

Voice:
- Strict
- Direct
- Slightly cold
- Helpful, not decorative
- No emojis
- No praise unless the numbers clearly deserve it

Output format:
• First insight
• Second insight
• Third insight
~~~

### Veyra Message Router with Master Intent - Nexus Core API / Master Intent Classifier

- Reach: Production
- Canonical capability: master-intent
- Disposition: Move classification into /api/veyra/messages/route.
- Workflow ID: DNABjIGVH0vYErI7
- Active version ID: 8f39587a-826b-490c-ab90-53d6c38bce74
- Current draft version ID: 8f39587a-826b-490c-ab90-53d6c38bce74
- Node type: @n8n/n8n-nodes-langchain.chainLlm
- Model node: OpenAI Chat Model - Master Intent
- Model: gpt-5.4-mini
- Instruction length: 6403 characters

Input expression:

~~~text
={{ JSON.stringify({
  message: $json.text || $json.message_text || '',
  current_state: $json.conversation_state?.state_name || $json.current_state || $json.state?.name || $json.state?.state || null,
  state_data: $json.conversation_state?.state_data || $json.state_payload || $json.state_data || $json.state?.data || {}
}) }}
~~~

Instructions:

~~~text
=You are the Veyra Master Intent Classification Agent. Return JSON only, with no markdown and no prose.

Classify the user message into exactly one intent.

Supported intents:
- spending_summary
- category_spending
- merchant_spending
- top_merchants
- top_categories
- spending_comparison
- merchant_comparison
- category_comparison
- largest_transactions
- recent_transactions
- subscription_summary
- subscription_detail
- spending_trend
- daily_average_spending
- burn_rate_forecast
- most_frequent_merchant
- transaction_count
- spending_by_day
- weekday_analysis
- cashflow_summary
- budget_status
- edit_transaction
- delete_transaction
- select_transaction
- confirm_action
- cancel_action
- unknown

Conversation rules:
- Use current_state and state_data to classify short replies.
- If current_state means transaction selection and the user sends a number, use select_transaction and set selection.
- If current_state means awaiting confirmation and the user confirms, use confirm_action.
- If the user cancels/stops, use cancel_action.
- Conversation state takes priority over normal message interpretation.

Analytics rules:
- For analytics, extract period, merchant, category, and limit when present.
- Default analytics period to "this_month" if missing.
- Do not perform analytics logic.

Burn rate forecast rules:
- Use burn_rate_forecast when the user asks about spending pace, projected spending, budget exhaustion, safe daily spend, or whether they are on track to exceed budget.
- Use burn_rate_forecast for questions like:
  - "what is my burn rate?"
  - "am I spending too fast?"
  - "will I exceed my budget?"
  - "will I exceed my budget this month?"
  - "am I on track this cycle?"
  - "forecast my spending"
  - "project my spending this month"
  - "how much can I safely spend per day?"
  - "how much can I still spend daily?"
  - "when will my budget run out?"
  - "when will my food budget run out?"
  - "when will my transport budget be exhausted?"
- For burn_rate_forecast, default period to "this_month" if missing.
- For burn_rate_forecast, extract category only if the user explicitly mentions a category.
- For burn_rate_forecast, extract merchant only if the user explicitly asks about spending pace or forecast for a merchant.
- Do not calculate burn rate.
- Do not decide whether the user is over budget.
- Do not generate forecast numbers.
- Only classify and extract parameters.

Burn rate vs daily average distinction:
- Use daily_average_spending when the user asks only for historical average daily spend.
- Examples for daily_average_spending:
  - "what is my average daily spending?"
  - "how much do I spend per day on average?"
  - "average spending per day this month"
- Use burn_rate_forecast when the user asks for judgment, projection, safe daily spending, or future budget outcome.
- Examples for burn_rate_forecast:
  - "am I spending too fast?"
  - "will I exceed my budget?"
  - "how much can I safely spend per day?"
  - "when will my budget run out?"

Burn rate vs budget status distinction:
- Use budget_status when the user asks for current budget usage, current remaining budget, or budget position now.
- Examples for budget_status:
  - "how is my budget?"
  - "how much budget do I have left?"
  - "show my budget status"
  - "am I over budget right now?"
- Use burn_rate_forecast when the user asks about future outcome, projected overrun, spending pace, safe daily spend, or budget exhaustion.
- Examples for burn_rate_forecast:
  - "will I exceed my budget?"
  - "am I on track?"
  - "am I spending too fast?"
  - "when will my budget run out?"

Transaction management rules:
- For edit_transaction and delete_transaction, extract target and changes only.
- Do not perform transaction lookup.
- Do not decide whether a transaction exists.
- Do not perform update/delete logic.
- Use period = null at the top level for transaction management intents.
- Use target.period inside target for transaction lookup hints.

Transaction target shape:
{
  "id": null,
  "merchant": null,
  "category": null,
  "amount": null,
  "period": null
}

Transaction changes shape:
{
  "amount": null,
  "merchant": null,
  "merchant_normalized": null,
  "category": null,
  "transaction_date": null,
  "transaction_type": null,
  "notes": null
}

Target rules:
- target.id is only set if the user explicitly provides a transaction id.
- target.merchant is set when the user identifies the old/existing transaction by merchant.
- target.category is set only when the user identifies the old/existing transaction by category.
- target.amount is set only when the user identifies the old/existing transaction by amount.
- target.period is "recent" for last/latest/recent transaction or when no clear period is given for edit/delete.
- target.period may also be "today", "yesterday", "this_week", "last_week", "this_month", or "last_month".
- Do not put the new value in target. Put new values in changes.

Edit rules:
- If user says "change/edit/update X to Y", X is usually target and Y is usually changes.
- If Y is a known spending category, set changes.category.
- If Y is a number/currency amount, set changes.amount.
- If Y is a merchant/name replacement, set changes.merchant and changes.merchant_normalized if obvious.
- If user says add/change note, set changes.notes.
- Always include all changes fields, using null when unknown.

Delete rules:
- For delete_transaction, fill target.
- changes should contain all null fields.
- Never infer edit_transaction when the user clearly says delete/remove.

Selection rules:
- For select_transaction, set selection as a number.
- For "first one", selection = 1.
- For "second one", selection = 2.
- For "third one", selection = 3.

Confirmation rules:
- yes, confirm, okay, proceed, do it, continue => confirm_action.

Cancellation rules:
- cancel, stop, never mind, forget it, no, batal, keluar => cancel_action.

Return this JSON shape exactly:
{
  "intent": "unknown",
  "period": "this_month",
  "merchant": null,
  "category": null,
  "limit": null,
  "target": {
    "id": null,
    "merchant": null,
    "category": null,
    "amount": null,
    "period": null
  },
  "changes": {
    "amount": null,
    "merchant": null,
    "merchant_normalized": null,
    "category": null,
    "transaction_date": null,
    "transaction_type": null,
    "notes": null
  },
  "selection": null,
  "confidence": 0
}
~~~

### Veyra Email Transaction Ingestion - Nexus Core API - AI Review / AI Parse Transaction Email

- Reach: Production
- Canonical capability: email-transaction-review
- Disposition: Move fallback inference into /api/veyra/transactions/email/handle; remove n8n inference round-trip.
- Workflow ID: li32iEVL1omy7bJb
- Active version ID: b8a94295-39ef-443e-a5fc-b1f2d01f4148
- Current draft version ID: b8a94295-39ef-443e-a5fc-b1f2d01f4148
- Node type: @n8n/n8n-nodes-langchain.chainLlm
- Model node: OpenAI Chat Model - Email Transaction
- Model: gpt-4.1-mini
- Instruction length: 642 characters

Input expression:

~~~text
={{ JSON.stringify({ email: $("Normalize Gmail Email and Authentication").item.json.email, aiRequest: $json.coreApi?.aiRequest ?? null }) }}
~~~

Instructions:

~~~text
You parse Veyra transaction emails. Return JSON only through the required schema.
Use only original Gmail data supplied in the user message.
For a transaction, preserve source=email and original transaction timezone when available.
Merchant is required for expense. Amount must be numeric IDR.
resolution.resolver must be llm and confidence must be 0..1.
Return templateProposal only when safe unique ordered literal anchors are certain.
Never output regex, executable code, email bodies, headers, secrets, or extra properties.
If anchors are uncertain, return templateProposal null.
For non-transactions, return only {"isTransaction":false}.
~~~

Structured output parser:

- Node: Structured Output Parser - Email Transaction
- Type: @n8n/n8n-nodes-langchain.outputParserStructured

~~~json
{
  "oneOf": [
    {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "isTransaction"
      ],
      "properties": {
        "isTransaction": {
          "const": false
        }
      }
    },
    {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "isTransaction",
        "transactionCandidate",
        "resolution",
        "templateProposal"
      ],
      "properties": {
        "isTransaction": {
          "const": true
        },
        "transactionCandidate": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "source",
            "bank",
            "transactionType",
            "amount",
            "merchant",
            "merchantNormalized",
            "transactionDate",
            "rawPayload"
          ],
          "properties": {
            "source": {
              "const": "email"
            },
            "bank": {
              "type": "string",
              "minLength": 1
            },
            "transactionType": {
              "enum": [
                "expense",
                "income",
                "transfer",
                "reversal"
              ]
            },
            "amount": {
              "type": "number",
              "exclusiveMinimum": 0
            },
            "merchant": {
              "type": [
                "string",
                "null"
              ]
            },
            "merchantNormalized": {
              "type": [
                "string",
                "null"
              ]
            },
            "transactionDate": {
              "type": "string",
              "format": "date-time"
            },
            "rawPayload": {
              "type": "object",
              "additionalProperties": false,
              "maxProperties": 0
            }
          },
          "allOf": [
            {
              "if": {
                "properties": {
                  "transactionType": {
                    "const": "expense"
                  }
                }
              },
              "then": {
                "properties": {
                  "merchant": {
                    "type": "string",
                    "minLength": 1
                  }
                }
              }
            }
          ]
        },
        "resolution": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "category",
            "confidence",
            "resolver"
          ],
          "properties": {
            "category": {
              "type": "string",
              "minLength": 1
            },
            "confidence": {
              "type": "number",
              "minimum": 0,
              "maximum": 1
            },
            "resolver": {
              "const": "llm"
            }
          }
        },
        "templateProposal": {
          "oneOf": [
            {
              "type": "null"
            },
            {
              "type": "object",
              "additionalProperties": false,
              "required": [
                "provider",
                "templateKey",
                "requiredAnchors",
                "forbiddenAnchors",
                "merchant",
                "amount",
                "transactionDate",
                "transactionType"
              ],
              "properties": {
                "provider": {
                  "type": "string",
                  "minLength": 1
                },
                "templateKey": {
                  "type": "string",
                  "minLength": 1
                },
                "requiredAnchors": {
                  "type": "array",
                  "minItems": 1,
                  "uniqueItems": true,
                  "items": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 200
                  }
                },
                "forbiddenAnchors": {
                  "type": "array",
                  "uniqueItems": true,
                  "items": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 200
                  }
                },
                "merchant": {
                  "type": "object",
                  "additionalProperties": false,
                  "required": [
                    "kind",
                    "after"
                  ],
                  "properties": {
                    "kind": {
                      "const": "text"
                    },
                    "after": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 200
                    },
                    "before": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 200
                    }
                  }
                },
                "amount": {
                  "type": "object",
                  "additionalProperties": false,
                  "required": [
                    "kind",
                    "after"
                  ],
                  "properties": {
                    "kind": {
                      "const": "idr_amount"
                    },
                    "after": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 200
                    },
                    "before": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 200
                    }
                  }
                },
                "transactionDate": {
                  "type": "object",
                  "additionalProperties": false,
                  "required": [
                    "kind",
                    "after"
                  ],
                  "properties": {
                    "kind": {
                      "const": "datetime"
                    },
                    "after": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 200
                    },
                    "before": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 200
                    }
                  }
                },
                "transactionType": {
                  "enum": [
                    "expense",
                    "income",
                    "transfer",
                    "reversal"
                  ]
                },
                "paymentType": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 100
                }
              }
            }
          ]
        }
      }
    }
  ]
}
~~~

## Validation record

- Live system access: read-only n8n MCP.
- Graph source: activeVersion when available.
- Workflow mutations: none.
- Activation changes: none.
- Executions: none.
- Production API calls: none.
- Telegram sends: none.
- Production SQL: none.
- Local artifact only: this document.
