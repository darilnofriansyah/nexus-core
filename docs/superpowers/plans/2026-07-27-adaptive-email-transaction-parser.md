# Adaptive Email Transaction Parser Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add user-confirmed, database-backed email parser templates so repeat bank formats parse without AI while n8n retains all AI invocation and Telegram orchestration.

**Architecture:** Existing hard-coded parsers remain first. Core API then tries a safe literal-anchor interpreter backed by user-scoped PostgreSQL templates; if neither parser succeeds, it returns `needs_ai` for n8n. n8n submits structured AI output to the existing review endpoint, Core API validates the candidate and proposed template, and only a later user confirmation activates the template.

**Tech Stack:** NestJS 10, TypeScript 5.7, PostgreSQL through `pg`, Node.js standard library, `node:test`, existing `html-to-text`.

## Global Constraints

- n8n owns Gmail triggers/fetching, AI model invocation and prompts, Telegram sending, callback routing, credentials, and retries.
- Core API never invokes an AI model and gains no AI SDK dependency.
- AI output is untrusted data and cannot write to the database directly.
- Learned rules allow literal anchors and built-in `idr_amount`, `datetime`, and `text` extractors only; no executable code or unrestricted regular expressions.
- AI-parsed transactions always remain pending until user confirmation.
- A learned template is user-scoped and may auto-save only for an exact sender address with aligned passing DKIM or DMARC metadata.
- Do not persist the full email body.
- Preserve Gmail message-ID idempotency through `transaction_imports`.
- Do not modify, activate, deactivate, or deploy production n8n workflows in this plan.
- Create migration SQL and schema documentation, but do not apply the migration or deploy.
- Do not add a dependency; use Node.js standard library functions and existing packages.
- Before implementing SQL, reread `docs/veyra-database-schema.md`.

---

## File Map

- Create `src/veyra/transactions/learned-email-parser.ts`: pure transaction detection, sender-authentication validation, literal-anchor extraction, proposal validation, and structural fingerprints.
- Create `src/veyra/transactions/learned-email-parser.spec.ts`: focused interpreter, detector, validation, and prompt-injection fixtures.
- Create `src/veyra/transactions/email-parser-template.repository.ts`: concrete PostgreSQL access for active, activate, touch, and disable operations.
- Create `src/veyra/transactions/email-parser-template.repository.spec.ts`: query and row-mapping checks.
- Create `docs/migration/2026-07-27-email-parser-templates.sql`: unapplied `email_parser_templates` migration.
- Modify `src/veyra/transactions/dto/email-transaction.dto.ts`: sender-authentication, template-proposal, AI handoff, correction, and edit-action contracts.
- Modify `src/veyra/transactions/transaction.service.ts`: parser ordering, `needs_ai`, AI-result validation, pending correction, activation, idempotency, and disablement.
- Modify `src/veyra/transactions/transaction.service.spec.ts`: service flow and persistence checks.
- Modify `src/veyra/veyra.module.ts`: register the concrete template repository.
- Modify `docs/veyra-database-schema.md`: document the new table after the migration definition exists.
- Modify `README.md`: document all Core API/n8n payloads and the exact node boundary.
- Modify `docs/migration/actionable-parity-checklist.md`: replace the old “no DB-driven parser” limitation with the implemented boundary.

---

### Task 1: Safe Learned-Template Interpreter

**Files:**
- Create: `src/veyra/transactions/learned-email-parser.ts`
- Create: `src/veyra/transactions/learned-email-parser.spec.ts`
- Modify: `src/veyra/transactions/dto/email-transaction.dto.ts`

**Interfaces:**
- Consumes: `EmailParserInput`, `normalizeEmailWhitespace`, `cleanAmount`, and `extractIndonesianDateTime` from `email-parsers.ts`.
- Produces:

```ts
export type EmailAuthenticationStatus = "pass" | "fail" | "unknown";

export interface EmailSenderAuthenticationDto {
  dkim: EmailAuthenticationStatus;
  spf: EmailAuthenticationStatus;
  dmarc: EmailAuthenticationStatus;
  domain?: string;
}

export interface EmailTemplateCaptureRuleDto {
  kind: "idr_amount" | "datetime" | "text";
  after: string;
  before?: string;
}

export interface EmailParserTemplateProposalDto {
  provider: string;
  templateKey: string;
  requiredAnchors: string[];
  forbiddenAnchors?: string[];
  amount: EmailTemplateCaptureRuleDto;
  merchant: EmailTemplateCaptureRuleDto;
  transactionDate: EmailTemplateCaptureRuleDto;
  transactionType: NormalizedTransactionType;
  paymentType: string;
}

export interface LearnedEmailTemplate {
  id: string;
  userId: string;
  senderAddress: string;
  fingerprint: string;
  proposal: EmailParserTemplateProposalDto;
}

export type EmailTemplateValidationResult =
  | {
      ok: true;
      fingerprint: string;
      parsed: ParsedEmailTransactionDto;
    }
  | { ok: false; reason: string };

export function isLikelyTransactionEmail(input: EmailParserInput): boolean;
export function hasAlignedSenderAuthentication(
  email: EmailTransactionMessageDto,
): boolean;
export function validateEmailTemplateProposal(
  input: EmailParserInput,
  proposal: EmailParserTemplateProposalDto,
): EmailTemplateValidationResult;
export function parseLearnedEmailTemplate(
  input: EmailParserInput,
  template: LearnedEmailTemplate,
): ParsedEmailTransactionDto | null;
```

- Extend `EmailTransactionMessageDto` with:

```ts
authentication?: EmailSenderAuthenticationDto;
```

- The fingerprint is SHA-256 over normalized sender address, provider,
  template key, ordered anchors, capture boundaries, transaction type, and
  payment type. It never contains the email body or extracted values.

- [ ] **Step 1: Write failing interpreter tests**

Create tests using the existing Krom fixture style:

```ts
function email(
  overrides: Partial<EmailTransactionMessageDto> = {},
): EmailTransactionMessageDto {
  return {
    messageId: "gmail-message-id",
    from: "no-reply@krom.id",
    subject: "Transaction notification",
    date: "2026-06-25T09:30:00+07:00",
    emailText: "Transaction body",
    ...overrides,
  };
}

function input(
  emailText: string,
  overrides: Partial<EmailTransactionMessageDto> = {},
): EmailParserInput {
  const message = email({ emailText, ...overrides });
  return {
    email: message,
    text: emailText,
    normalizedText: normalizeEmailWhitespace(emailText),
    bodySource: "text",
    bodyWarnings: [],
  };
}

function proposal(
  overrides: Partial<EmailParserTemplateProposalDto> = {},
): EmailParserTemplateProposalDto {
  return {
    provider: "Krom",
    templateKey: "learned-krom-qris",
    requiredAnchors: ["Merchant:", "Jumlah:"],
    merchant: { kind: "text", after: "Merchant:", before: "Jumlah:" },
    amount: { kind: "idr_amount", after: "Jumlah:" },
    transactionDate: { kind: "datetime", after: "Tanggal:" },
    transactionType: "expense",
    paymentType: "QRIS",
    ...overrides,
  };
}

test("validates and replays a literal-anchor proposal", () => {
  const parserInput = input(
    "Transaksi QRIS berhasil Merchant: Kopi Tuku Jumlah: Rp25.000 Tanggal: 25 Juni 2026 09:30",
    {
      from: "no-reply@krom.id",
      authentication: {
        dkim: "pass",
        spf: "pass",
        dmarc: "pass",
        domain: "krom.id",
      },
    },
  );
  const proposal: EmailParserTemplateProposalDto = {
    provider: "Krom",
    templateKey: "learned-krom-qris",
    requiredAnchors: ["Transaksi QRIS berhasil", "Merchant:", "Jumlah:", "Tanggal:"],
    forbiddenAnchors: ["Promo"],
    merchant: { kind: "text", after: "Merchant:", before: "Jumlah:" },
    amount: { kind: "idr_amount", after: "Jumlah:", before: "Tanggal:" },
    transactionDate: { kind: "datetime", after: "Tanggal:" },
    transactionType: "expense",
    paymentType: "QRIS",
  };

  const validated = validateEmailTemplateProposal(parserInput, proposal);

  assert.equal(validated.ok, true);
  if (!validated.ok) return;
  assert.equal(validated.parsed.merchant, "Kopi Tuku");
  assert.equal(validated.parsed.amount, 25000);
  assert.equal(validated.parsed.transactionDate, "2026-06-25T09:30:00+07:00");
  assert.equal(validated.fingerprint.length, 64);

  const replayed = parseLearnedEmailTemplate(parserInput, {
    id: "7",
    userId: "1",
    senderAddress: "no-reply@krom.id",
    fingerprint: validated.fingerprint,
    proposal,
  });
  assert.equal(replayed?.amount, 25000);
});
```

Also add exact tests that:

```ts
test("treats regex-looking anchors as literals", () => {
  const result = validateEmailTemplateProposal(
    input("Transaksi Rp25.000", { from: "bank@example.com" }),
    proposal({ requiredAnchors: [".*"], amount: { kind: "idr_amount", after: ".*" } }),
  );
  assert.deepEqual(result, { ok: false, reason: "required anchor was not found" });
});

test("rejects a forbidden marketing anchor", () => {
  const result = validateEmailTemplateProposal(
    input("Promo transaksi Merchant: Tuku Jumlah: Rp25.000", {
      from: "bank@example.com",
    }),
    proposal({ forbiddenAnchors: ["Promo"] }),
  );
  assert.deepEqual(result, { ok: false, reason: "forbidden anchor was found" });
});

test("detects transactions but rejects marketing email", () => {
  assert.equal(
    isLikelyTransactionEmail(
      input("Pembayaran berhasil sebesar Rp25.000", { from: "bank@example.com" }),
    ),
    true,
  );
  assert.equal(
    isLikelyTransactionEmail(
      input("Promo diskon belanja hingga Rp25.000", { from: "bank@example.com" }),
    ),
    false,
  );
});

test("requires aligned DKIM or DMARC for automatic learned parsing", () => {
  assert.equal(
    hasAlignedSenderAuthentication(
      email({
        from: "card@bca.co.id",
        authentication: {
          dkim: "pass",
          spf: "pass",
          dmarc: "unknown",
          domain: "bca.co.id",
        },
      }),
    ),
    true,
  );
  assert.equal(
    hasAlignedSenderAuthentication(
      email({
        from: "card@bca.co.id",
        authentication: {
          dkim: "pass",
          spf: "pass",
          dmarc: "unknown",
          domain: "evil.example",
        },
      }),
    ),
    false,
  );
});
```

- [ ] **Step 2: Run the new test and verify failure**

Run:

```bash
npx tsc -p tsconfig.test.json
node --test dist-test/src/veyra/transactions/learned-email-parser.spec.js
```

Expected: TypeScript fails because the DTOs and interpreter do not exist.

- [ ] **Step 3: Implement the minimum literal interpreter**

Use `indexOf` on a lower-cased copy while slicing the original normalized text:

```ts
function captureLiteral(
  text: string,
  rule: EmailTemplateCaptureRuleDto,
): string | null {
  const lower = text.toLowerCase();
  const start = lower.indexOf(rule.after.toLowerCase());
  if (start < 0) return null;

  const valueStart = start + rule.after.length;
  const tail = text.slice(valueStart);
  const end = rule.before
    ? tail.toLowerCase().indexOf(rule.before.toLowerCase())
    : -1;
  const value = (end < 0 ? tail : tail.slice(0, end)).trim();

  return value || null;
}
```

Interpret `idr_amount` with `cleanAmount`, `datetime` with
`extractIndonesianDateTime`, and `text` as normalized captured text. Reject:

- empty or duplicate required anchors;
- more than 20 anchors;
- anchors or boundaries longer than 200 characters;
- missing required anchors;
- present forbidden anchors;
- missing/invalid amount, merchant, date, transaction type, provider,
  template key, or payment type.

Use `node:crypto`:

```ts
const fingerprint = createHash("sha256")
  .update(JSON.stringify(canonicalTemplateShape))
  .digest("hex");
```

The transaction detector requires a money signal plus one of
`transaction`, `transaksi`, `pembayaran`, `payment`, `transfer`, `debit`,
`credit`, `top-up`, or `qris`, and rejects `promo`, `discount`, `diskon`,
`newsletter`, `offer`, and `penawaran`.

- [ ] **Step 4: Run focused and existing parser tests**

Run:

```bash
npx tsc -p tsconfig.test.json
node --test dist-test/src/veyra/transactions/learned-email-parser.spec.js
node --test dist-test/src/veyra/transactions/email-parsers.spec.js
```

Expected: both suites pass.

- [ ] **Step 5: Commit**

```bash
git add src/veyra/transactions/dto/email-transaction.dto.ts src/veyra/transactions/learned-email-parser.ts src/veyra/transactions/learned-email-parser.spec.ts
git commit -m "feat: validate learned email parser templates"
```

---

### Task 2: Template Repository and Unapplied Migration

**Files:**
- Create: `src/veyra/transactions/email-parser-template.repository.ts`
- Create: `src/veyra/transactions/email-parser-template.repository.spec.ts`
- Create: `docs/migration/2026-07-27-email-parser-templates.sql`
- Modify: `docs/veyra-database-schema.md`
- Modify: `src/veyra/veyra.module.ts`

**Interfaces:**
- Consumes: `DatabaseService`, `EmailParserTemplateProposalDto`, and
  `LearnedEmailTemplate`.
- Produces:

```ts
export interface ActivateEmailParserTemplateInput {
  userId: string;
  senderAddress: string;
  fingerprint: string;
  proposal: EmailParserTemplateProposalDto;
}

@Injectable()
export class EmailParserTemplateRepository {
  findActive(userId: string, senderAddress: string): Promise<LearnedEmailTemplate[]>;
  activate(input: ActivateEmailParserTemplateInput): Promise<LearnedEmailTemplate>;
  markMatched(templateId: string, userId: string): Promise<void>;
  disable(templateId: string, userId: string): Promise<void>;
}
```

- [ ] **Step 1: Write failing repository tests**

Use the existing repository fake:

```ts
test("findActive returns only active templates for the user and exact sender", async () => {
  const { calls, repository } = createRepository([[templateRow]]);

  const templates = await repository.findActive("1", "card@bca.co.id");

  assert.match(calls[0].text, /status = 'active'/);
  assert.match(calls[0].text, /lower\(sender_address\) = lower\(\$2\)/);
  assert.deepEqual(calls[0].values, ["1", "card@bca.co.id"]);
  assert.equal(templates[0].id, "7");
});

test("activate upserts a user fingerprint without executable fields", async () => {
  const { calls, repository } = createRepository([[templateRow]]);

  await repository.activate({
    userId: "1",
    senderAddress: "card@bca.co.id",
    fingerprint: "a".repeat(64),
    proposal,
  });

  assert.match(calls[0].text, /ON CONFLICT \(user_id, fingerprint\)/);
  assert.deepEqual(calls[0].values, [
    "1",
    "BCA",
    "card@bca.co.id",
    "learned-bca-card",
    "a".repeat(64),
    JSON.stringify(proposal),
  ]);
});

test("disable is user-scoped", async () => {
  const { calls, repository } = createRepository();
  await repository.disable("7", "1");
  assert.match(calls[0].text, /status = 'disabled'/);
  assert.deepEqual(calls[0].values, ["7", "1"]);
});
```

- [ ] **Step 2: Run the repository test and verify failure**

Run:

```bash
npx tsc -p tsconfig.test.json
node --test dist-test/src/veyra/transactions/email-parser-template.repository.spec.js
```

Expected: TypeScript fails because the repository does not exist.

- [ ] **Step 3: Add the migration and repository**

Create this migration without applying it:

```sql
CREATE TABLE IF NOT EXISTS email_parser_templates (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES telegram_users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  sender_address TEXT NOT NULL,
  template_key TEXT NOT NULL,
  template_version INTEGER NOT NULL DEFAULT 1,
  fingerprint TEXT NOT NULL,
  rules JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'disabled')),
  last_matched_at TIMESTAMPTZ NULL,
  disabled_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, fingerprint)
);

CREATE INDEX IF NOT EXISTS idx_email_parser_templates_active_sender
ON email_parser_templates (user_id, lower(sender_address))
WHERE status = 'active';
```

Repository rules:

- `findActive` orders by `updated_at DESC`;
- `activate` uses `ON CONFLICT (user_id, fingerprint) DO UPDATE`, restores
  `status = 'active'`, clears `disabled_at`, and updates sender/rules;
- `markMatched` changes only `last_matched_at` and `updated_at`;
- `disable` requires both template ID and user ID.

Register `EmailParserTemplateRepository` in `VeyraModule.providers`. Add the
exact table definition and invariants to `docs/veyra-database-schema.md`.

- [ ] **Step 4: Run repository tests and compile**

Run:

```bash
npx tsc -p tsconfig.test.json
node --test dist-test/src/veyra/transactions/email-parser-template.repository.spec.js
npm run build
```

Expected: repository tests and build pass. Do not run the migration.

- [ ] **Step 5: Commit**

```bash
git add src/veyra/transactions/email-parser-template.repository.ts src/veyra/transactions/email-parser-template.repository.spec.ts src/veyra/veyra.module.ts docs/migration/2026-07-27-email-parser-templates.sql docs/veyra-database-schema.md
git commit -m "feat: persist learned email parser templates"
```

---

### Task 3: Deterministic Learned Parsing and `needs_ai` Handoff

**Files:**
- Modify: `src/veyra/transactions/dto/email-transaction.dto.ts`
- Modify: `src/veyra/transactions/transaction.service.ts`
- Modify: `src/veyra/transactions/transaction.service.spec.ts`

**Interfaces:**
- Consumes:

```ts
EmailParserTemplateRepository.findActive(userId, senderAddress)
parseLearnedEmailTemplate(input, template)
isLikelyTransactionEmail(input)
hasAlignedSenderAuthentication(email)
```

- Produces:

```ts
export type EmailTransactionHandleStatus =
  | "confirmed"
  | "needs_review"
  | "needs_ai"
  | "duplicate"
  | "ignored_non_transaction"
  | "unsupported_provider"
  | "unsupported_template"
  | "parse_failed";

export interface EmailAiHandoffDto {
  reviewToken: string;
  reason: "unsupported_template" | "parse_failed";
}

// Added to EmailTransactionHandleResponseDto
aiRequest?: EmailAiHandoffDto;
```

- `reviewToken` is the existing Gmail message ID. The response does not echo
  the body; n8n already holds it.

- [ ] **Step 1: Write failing service tests for parser order and handoff**

Extend `createService` with an optional fake template repository. Add these
file-scope fixtures and fake:

```ts
function createTemplateRepository(
  templates: LearnedEmailTemplate[] = [],
  activateError?: Error,
) {
  const calls: Array<{ method: string; input: unknown }> = [];
  return {
    calls,
    repository: {
      findActive: async (userId: string, senderAddress: string) => {
        calls.push({ method: "findActive", input: { userId, senderAddress } });
        return templates;
      },
      activate: async (input: ActivateEmailParserTemplateInput) => {
        calls.push({ method: "activate", input });
        if (activateError) throw activateError;
        return { id: "7", ...input };
      },
      markMatched: async (templateId: string, userId: string) => {
        calls.push({ method: "markMatched", input: { templateId, userId } });
      },
      disable: async (templateId: string, userId: string) => {
        calls.push({ method: "disable", input: { templateId, userId } });
      },
    } as unknown as EmailParserTemplateRepository,
  };
}

const learnedProposal: EmailParserTemplateProposalDto = {
  provider: "Krom",
  templateKey: "learned-krom-qris",
  requiredAnchors: ["Pembayaran QR berhasil", "Merchant:", "Jumlah:", "Tanggal:"],
  merchant: { kind: "text", after: "Merchant:", before: "Jumlah:" },
  amount: { kind: "idr_amount", after: "Jumlah:", before: "Tanggal:" },
  transactionDate: { kind: "datetime", after: "Tanggal:" },
  transactionType: "expense",
  paymentType: "QRIS",
};

const learnedTemplate: LearnedEmailTemplate = {
  id: "7",
  userId: "1",
  senderAddress: "alerts@krom.id",
  fingerprint: "a".repeat(64),
  proposal: learnedProposal,
};

const authenticatedUnknownKromEmail: EmailTransactionHandleRequestDto = {
  telegramUserId: "976684739",
  userId: "1",
  source: "email",
  email: {
    messageId: "gmail-learned-1",
    from: "alerts@krom.id",
    subject: "Pembayaran berhasil",
    date: "2026-07-27T09:30:00+07:00",
    emailText:
      "Pembayaran QR berhasil Merchant: Kopi Tuku Jumlah: Rp25.000 Tanggal: 27 Juli 2026 09:30",
    authentication: {
      dkim: "pass",
      spf: "pass",
      dmarc: "pass",
      domain: "krom.id",
    },
  },
};

const authenticatedUnknownBankTransaction: EmailTransactionHandleRequestDto = {
  ...authenticatedUnknownKromEmail,
  email: {
    ...authenticatedUnknownKromEmail.email,
    messageId: "gmail-unknown-1",
    from: "alerts@newbank.id",
    subject: "Pembayaran berhasil",
    emailText: "Pembayaran berhasil sebesar Rp25.000",
    authentication: {
      dkim: "pass",
      spf: "pass",
      dmarc: "pass",
      domain: "newbank.id",
    },
  },
};

const unauthenticatedMatchingEmail: EmailTransactionHandleRequestDto = {
  ...authenticatedUnknownKromEmail,
  email: {
    ...authenticatedUnknownKromEmail.email,
    authentication: {
      dkim: "fail",
      spf: "unknown",
      dmarc: "fail",
      domain: "krom.id",
    },
  },
};
```

Then add:

```ts
test("uses a learned template after hard-coded parsers and skips AI", async () => {
  const templates = createTemplateRepository([learnedTemplate]);
  const { service } = createService(
    [
      [], // no existing import
      [{ canonical_name: "Kopi Tuku" }],
      [{ category: "Food" }],
      [{ id: "import-1" }],
      [{ id: "tx-1" }],
      [],
      [],
    ],
    undefined,
    undefined,
    templates.repository,
  );

  const result = await service.handleEmailTransaction(authenticatedUnknownKromEmail);

  assert.equal(result.status, "confirmed");
  assert.equal(result.templateKey, "learned-krom-qris");
  assert.equal(result.parsed?.raw.parserSource, "learned");
  assert.equal(templates.calls[0].method, "findActive");
});

test("returns needs_ai for a likely transaction with no deterministic parser", async () => {
  const templates = createTemplateRepository([]);
  const { service } = createService([[], [{ id: "import-1" }], []], undefined, undefined, templates.repository);

  const result = await service.handleEmailTransaction(authenticatedUnknownBankTransaction);

  assert.equal(result.status, "needs_ai");
  assert.deepEqual(result.aiRequest, {
    reviewToken: "gmail-unknown-1",
    reason: "unsupported_template",
  });
  assert.equal("emailText" in (result.aiRequest ?? {}), false);
});

test("does not auto-save a learned result without aligned sender authentication", async () => {
  const templates = createTemplateRepository([learnedTemplate]);
  const { service } = createService([[], [{ id: "import-1" }], []], undefined, undefined, templates.repository);

  const result = await service.handleEmailTransaction(unauthenticatedMatchingEmail);

  assert.equal(result.status, "needs_review");
  assert.equal(result.reason, "sender authentication is required for automatic import");
});
```

Add a regression test that a supported hard-coded parser does not call
`findActive`.

- [ ] **Step 2: Run the service test and verify failure**

Run:

```bash
npx tsc -p tsconfig.test.json
node --test --test-name-pattern="learned template|needs_ai|sender authentication|hard-coded parser" dist-test/src/veyra/transactions/transaction.service.spec.js
```

Expected: compile/test failure because the status, repository dependency, and
learned path do not exist.

- [ ] **Step 3: Implement parser ordering with one optional repository dependency**

Add the repository as the fourth constructor dependency:

```ts
constructor(
  private readonly database: DatabaseService,
  @Optional() private readonly budgetService?: BudgetService,
  @Optional() private readonly riskReviewRepository?: TransactionRiskReviewRepository,
  @Optional() private readonly emailParserTemplateRepository?: EmailParserTemplateRepository,
) {}
```

Keep current hard-coded parsing first. Only when it has no valid result:

```ts
const learnedAttempt = await this.parseLearnedEmail(parserInputs, validated);
if (learnedAttempt) {
  parsedAttempt = learnedAttempt;
}
```

`parseLearnedEmail` loads templates by `userId` and exact normalized `from`,
then tries each input/template pair until one validates. Set:

```ts
parsed.raw = {
  ...parsed.raw,
  parserSource: "learned",
  templateId: template.id,
};
```

Before saving a learned result, require
`hasAlignedSenderAuthentication(validated.email)`. Otherwise record
`needs_review`.

When neither deterministic path succeeds and any normalized body passes
`isLikelyTransactionEmail`, call the existing unconfirmed-attempt persistence
with `status = "needs_ai"` and return the `aiRequest`.

Unknown, non-transaction, and marketing messages retain the existing
unsupported/ignored behavior.

- [ ] **Step 4: Run focused service and parser tests**

Run:

```bash
npx tsc -p tsconfig.test.json
node --test --test-name-pattern="email|learned template|needs_ai|sender authentication" dist-test/src/veyra/transactions/transaction.service.spec.js
node --test dist-test/src/veyra/transactions/email-parsers.spec.js
node --test dist-test/src/veyra/transactions/learned-email-parser.spec.js
```

Expected: all selected tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/veyra/transactions/dto/email-transaction.dto.ts src/veyra/transactions/transaction.service.ts src/veyra/transactions/transaction.service.spec.ts
git commit -m "feat: hand unsupported transaction emails to n8n AI"
```

---

### Task 4: Validate AI Results, Corrections, and Review UI

**Files:**
- Modify: `src/veyra/transactions/dto/email-transaction.dto.ts`
- Modify: `src/veyra/transactions/transaction.service.ts`
- Modify: `src/veyra/transactions/transaction.service.spec.ts`

**Interfaces:**
- Extend the existing request rather than adding another endpoint:

```ts
export interface EmailTransactionResolveReviewRequestDto {
  telegramUserId: string;
  reviewToken?: string;
  transactionId?: string;
  email: EmailTransactionMessageDto;
  transactionCandidate?: EmailReviewTransactionCandidateDto;
  resolution?: EmailReviewResolutionDto;
  templateProposal?: EmailParserTemplateProposalDto;
  aiError?: string;
}

export interface EmailValidatedTemplatePayloadDto {
  fingerprint: string;
  proposal: EmailParserTemplateProposalDto;
}

// EmailTransactionResolveReviewResponseDto
reason?: "user_not_found" | "category_not_found" | "ai_failed";

export interface EmailReviewActionDto {
  action?:
    | "save_transaction"
    | "cancel_transaction"
    | "change_categories"
    | "edit_email_details";
  transactionId?: string;
}

// EmailTransactionResolveReviewResponseDto
actions?: {
  confirm: EmailReviewActionDto;
  cancel: EmailReviewActionDto;
  changeCategory: EmailReviewActionDto;
  editDetails: EmailReviewActionDto;
};
```

- Initial AI submission omits `transactionId` and inserts one pending email
  transaction.
- AI correction includes the pending `transactionId` and updates that row.
- AI failure includes `aiError` and omits candidate, resolution, and proposal.
- Both paths return the same confirmation payload.
- Reuse `authenticatedUnknownKromEmail`, `learnedProposal`, and
  `createTemplateRepository` added at file scope in Task 3.

- [ ] **Step 1: Write failing AI-review tests**

Add these file-scope candidates:

```ts
const aiCandidate: EmailReviewTransactionCandidateDto = {
  source: "email",
  bank: "Krom",
  transactionType: "expense",
  amount: 25000,
  merchant: "Kopi Tuku",
  merchantNormalized: "Kopi Tuku",
  transactionDate: "2026-07-27T09:30:00+07:00",
  description: "Krom QR payment",
  rawPayload: {},
};

const correctedKromProposal: EmailParserTemplateProposalDto = {
  ...learnedProposal,
  amount: { kind: "idr_amount", after: "Jumlah:", before: "Tanggal:" },
};

const correctionEmail: EmailTransactionMessageDto = {
  ...authenticatedUnknownKromEmail.email,
  emailText:
    "Saldo: Rp25.000 Pembayaran QR berhasil Merchant: Kopi Tuku Jumlah: Rp30.000 Tanggal: 27 Juli 2026 09:30",
};

function validAiReviewRequest(
  overrides: Partial<EmailTransactionResolveReviewRequestDto> = {},
): EmailTransactionResolveReviewRequestDto {
  return {
    telegramUserId: "976684739",
    reviewToken: "gmail-learned-1",
    email: authenticatedUnknownKromEmail.email,
    transactionCandidate: aiCandidate,
    resolution: { category: "Food", confidence: 98, resolver: "llm" },
    templateProposal: learnedProposal,
    ...overrides,
  };
}

const invalidCorrection = validAiReviewRequest({
  transactionId: "123",
  transactionCandidate: { ...aiCandidate, amount: 0 },
});

async function resolveValidAiReview() {
  const { service } = createService([
    [{ id: "1", telegram_id: "976684739" }],
    [{ category: "Food" }],
    [{ id: "123" }],
  ]);
  return service.resolveEmailTransactionReview(validAiReviewRequest());
}
```

Replace the old “confidence 86 auto-confirms” expectation and add:

```ts
test("keeps every AI result pending and stores only a validated proposal", async () => {
  const { calls, service } = createService([
    [{ id: "1", telegram_id: "976684739" }],
    [{ category: "Food" }],
    [{ id: "123" }],
  ]);

  const result = await service.resolveEmailTransactionReview({
    telegramUserId: "976684739",
    reviewToken: "gmail-message-id",
    email: authenticatedUnknownKromEmail.email,
    transactionCandidate: aiCandidate,
    resolution: { category: "Food", confidence: 98, resolver: "llm" },
    templateProposal: kromProposal,
  });

  assert.equal(result.status, "pending");
  assert.equal(result.transaction?.status, "pending");
  assert.equal(calls[2].values[8], "pending");
  const rawPayload = calls[2].values[10] as Record<string, unknown>;
  assert.equal(rawPayload.parserSource, "ai");
  assert.equal("emailText" in rawPayload, false);
  assert.equal("emailHtml" in rawPayload, false);
  assert.ok(rawPayload.validatedTemplate);
});

test("returns edit-details markup for n8n interception", async () => {
  const result = await resolveValidAiReview();
  assert.equal(result.actions?.editDetails.action, "edit_email_details");
  assert.deepEqual(result.replyMarkup?.inline_keyboard, [
    [
      { text: "Save", callback_data: "save_transaction:123" },
      { text: "Edit Details", callback_data: "edit_email_details:123" },
    ],
    [
      { text: "Change Category", callback_data: "change_categories:123" },
      { text: "Cancel", callback_data: "cancel_transaction:123" },
    ],
  ]);
});

test("updates the same pending row after a valid AI correction", async () => {
  const { calls, service } = createService([
    [{ id: "1", telegram_id: "976684739" }],
    [{ id: "123", user_id: "1", source: "email", status: "pending" }],
    [{ category: "Food" }],
    [{ id: "123" }],
  ]);

  const result = await service.resolveEmailTransactionReview({
    telegramUserId: "976684739",
    reviewToken: "gmail-message-id",
    transactionId: "123",
    email: correctionEmail,
    transactionCandidate: { ...aiCandidate, amount: 30000 },
    resolution: { category: "Food", confidence: 98, resolver: "llm" },
    templateProposal: correctedKromProposal,
  });

  assert.equal(result.transaction?.id, "123");
  assert.match(calls[3].text, /UPDATE transactions/);
  assert.match(calls[3].text, /status = 'pending'/);
});

test("does not mutate a pending row when corrected output is invalid", async () => {
  const { calls, service } = createService([
    [{ id: "1", telegram_id: "976684739" }],
    [{ id: "123", user_id: "1", source: "email", status: "pending" }],
  ]);

  await assert.rejects(
    () => service.resolveEmailTransactionReview(invalidCorrection),
    BadRequestException,
  );
  assert.equal(calls.some((call) => /UPDATE transactions/.test(call.text)), false);
});

test("records needs_review when n8n reports AI failure", async () => {
  const { calls, service } = createService([
    [{ id: "1", telegram_id: "976684739" }],
    [],
  ]);

  const result = await service.resolveEmailTransactionReview({
    telegramUserId: "976684739",
    reviewToken: "gmail-learned-1",
    email: authenticatedUnknownKromEmail.email,
    aiError: "model unavailable",
  });

  assert.equal(result.status, "needs_review");
  assert.equal(result.reason, "ai_failed");
  assert.match(calls[1].text, /UPDATE transaction_imports/);
  assert.equal(
    calls.some((call) => /INSERT INTO transactions/.test(call.text)),
    false,
  );
});
```

Also test that an invalid proposal still creates a pending review with
`validatedTemplate: null`, so confirmation can save the transaction without
learning.

- [ ] **Step 2: Run review tests and verify failure**

Run:

```bash
npx tsc -p tsconfig.test.json
node --test --test-name-pattern="AI result|edit-details|AI correction|validated proposal|AI failure" dist-test/src/veyra/transactions/transaction.service.spec.js
```

Expected: failures show the old high-confidence auto-confirm behavior and
missing correction/template fields.

- [ ] **Step 3: Implement one validation-and-upsert path**

In `validateEmailReviewRequest`:

- require `email.messageId`, sender, subject, and a body;
- require exactly one of `aiError` or candidate plus resolution;
- for a candidate, require positive amount, valid date/type, category, and
  normalized confidence;
- if `templateProposal` exists, build an `EmailParserInput` and call
  `validateEmailTemplateProposal`;
- preserve the candidate when proposal validation fails, but store no proposal.

For `aiError`, update the matching `transaction_imports` and
`email_parse_attempts` rows to `needs_review`, store the cleaned reason, return
`reason = "ai_failed"`, and do not insert a transaction.

Persist this body-free raw payload:

```ts
const rawPayload = {
  email: {
    messageId: request.email.messageId,
    from: request.email.from,
    authentication: request.email.authentication ?? null,
  },
  parserSource: "ai",
  validatedTemplate: validation.ok
    ? {
        fingerprint: validation.fingerprint,
        proposal: request.templateProposal,
      }
    : null,
};
```

Always set AI-submitted transactions to `pending`, regardless of confidence.
Remove the pre-confirmation alias/category-learning call.

For corrections, select by transaction ID, resolved user ID,
`source = 'email'`, and `status = 'pending'`; update the candidate fields,
confidence, and `raw_payload` in one `UPDATE ... RETURNING id`. Validate
everything before issuing this query.

After the initial pending insert, update the existing `transaction_imports`
row identified by user ID and `email.messageId` with the pending transaction
ID and `status = 'pending'`. A correction retains the same import and
transaction IDs.

Build email-only reply markup with the exact two rows in the test.
`edit_email_details:*` is returned to n8n and is not added to Core API's
generic callback parser.

- [ ] **Step 4: Run all email-review tests**

Run:

```bash
npx tsc -p tsconfig.test.json
node --test --test-name-pattern="email review|AI result|AI correction|AI failure|edit-details|category" dist-test/src/veyra/transactions/transaction.service.spec.js
```

Expected: all selected tests pass and no high-confidence AI result confirms
without the Save callback.

- [ ] **Step 5: Commit**

```bash
git add src/veyra/transactions/dto/email-transaction.dto.ts src/veyra/transactions/transaction.service.ts src/veyra/transactions/transaction.service.spec.ts
git commit -m "feat: validate n8n AI email reviews"
```

---

### Task 5: Confirmation Activation, Idempotency, and Rollback

**Files:**
- Modify: `src/veyra/transactions/transaction.service.ts`
- Modify: `src/veyra/transactions/transaction.service.spec.ts`

**Interfaces:**
- Consumes:

```ts
EmailParserTemplateRepository.activate(input)
EmailParserTemplateRepository.markMatched(templateId, userId)
EmailParserTemplateRepository.disable(templateId, userId)
```

- Produces these internal helpers:

```ts
private activateValidatedEmailTemplate(transaction: TransactionRow): Promise<void>;
private disableLearnedTemplateAfterMaterialEdit(
  transaction: TransactionRow,
  changes: ManageStateData["changes"],
): Promise<void>;
private updateEmailImportStatus(
  transaction: TransactionRow,
  status: "pending" | "confirmed" | "rejected",
): Promise<void>;
```

- `TransactionRow` gains `source?: string | null` and `raw_payload?: unknown`;
  every query used by these helpers selects both columns.
- Reuse `createTemplateRepository`, `learnedProposal`, and
  `authenticatedUnknownKromEmail` from Task 3.

- [ ] **Step 1: Write failing confirmation and rollback tests**

Add these exact fixtures:

```ts
const pendingAiTransaction = {
  id: "123",
  user_id: "1",
  transaction_type: "expense",
  amount: "25000",
  merchant: "Kopi Tuku",
  merchant_normalized: "Kopi Tuku",
  category: "Food",
  transaction_date: "2026-07-27T09:30:00+07:00",
  source: "email",
  status: "pending",
  raw_payload: {
    email: {
      messageId: "gmail-learned-1",
      from: "alerts@krom.id",
    },
    parserSource: "ai",
    validatedTemplate: {
      fingerprint: "a".repeat(64),
      proposal: learnedProposal,
    },
  },
};

const originalAiEmail: EmailTransactionHandleRequestDto = {
  ...authenticatedUnknownKromEmail,
  email: {
    ...authenticatedUnknownKromEmail.email,
    messageId: "gmail-learned-1",
  },
};
```

Then add:

```ts
test("Save activates the validated user template after confirming the transaction", async () => {
  const templates = createTemplateRepository();
  const { service } = createService(
    [[pendingAiTransaction], [], []],
    undefined,
    undefined,
    templates.repository,
  );

  const result = await service.confirmTransaction({
    transactionId: "123",
    userId: "1",
  });

  assert.equal(result.status, "confirmed");
  assert.equal(templates.calls[0].method, "activate");
  const activation = templates.calls[0].input as ActivateEmailParserTemplateInput;
  assert.equal(activation.userId, "1");
});

test("confirmation succeeds when template activation fails", async () => {
  const templates = createTemplateRepository([], new Error("db unavailable"));
  const { service } = createService(
    [[pendingAiTransaction], [], []],
    undefined,
    undefined,
    templates.repository,
  );

  const result = await service.confirmTransaction({
    transactionId: "123",
    userId: "1",
  });

  assert.equal(result.status, "confirmed");
});

test("Cancel never activates a proposed template", async () => {
  const templates = createTemplateRepository();
  const { service } = createService(
    [[pendingAiTransaction], []],
    undefined,
    undefined,
    templates.repository,
  );
  await service.cancelTransaction({ transactionId: "123", userId: "1" });
  assert.equal(templates.calls.some((call) => call.method === "activate"), false);
});

test("material edit disables the learned template but category edit does not", async () => {
  // Exercise handleManagedTransaction confirmation twice:
  // amount change => disable("7", "1")
  // category-only change => no disable call
});

test("repeated Gmail delivery returns the existing pending review", async () => {
  const { service } = createService([
    [{ id: "import-1", transaction_id: "123", status: "pending" }],
    [pendingAiTransaction],
  ]);
  const result = await service.handleEmailTransaction(originalAiEmail);
  assert.equal(result.status, "needs_review");
  assert.equal(result.transaction?.id, "123");
});
```

Add category-confirmation coverage proving `catid:*` confirmation activates
the proposal exactly once.

- [ ] **Step 2: Run focused tests and verify failure**

Run:

```bash
npx tsc -p tsconfig.test.json
node --test --test-name-pattern="activates|activation fails|never activates|disables|repeated Gmail" dist-test/src/veyra/transactions/transaction.service.spec.js
```

Expected: failures because transaction reads omit `source/raw_payload`,
confirmation does not activate templates, and duplicates do not resume review.

- [ ] **Step 3: Implement activation and retry behavior**

After a successful `pending -> confirmed` status update:

1. update the linked `transaction_imports` row to `confirmed`;
2. read `raw_payload.validatedTemplate`;
3. call repository `activate`;
4. catch/log only the activation error so the confirmed transaction remains;
5. preserve existing watchdog execution.

After a category callback confirms a pending transaction, call the same helper.
After rejection, update the linked import to `rejected` and do not activate.

When a learned parser auto-saves successfully, call `markMatched` best-effort.

Move the existing confirmed-email merchant/category learning to the confirmed
callback path and correct its schema usage:

```sql
SELECT id, canonical_name
FROM merchant_aliases
WHERE lower(alias_name) = lower($1)
LIMIT 1;

INSERT INTO merchant_aliases (alias_name, canonical_name)
VALUES ($1, $2);
```

`merchant_aliases` is global and has no `user_id`. Keep `category_rules`
user-scoped with `merchant_pattern`.

For later transaction edits, disable only when:

```ts
const materialKeys = [
  "amount",
  "merchant",
  "merchant_normalized",
  "transaction_date",
  "transaction_type",
];
```

and `raw_payload.parserSource === "learned"` with a string `templateId`.
Category and notes changes do not disable.

For an existing import:

- `needs_ai` with no transaction returns the same `needs_ai` handoff;
- `pending` with a transaction returns the existing review;
- `confirmed` or `rejected` returns the terminal duplicate response;
- no path inserts a second transaction or proposal.

- [ ] **Step 4: Run transaction and repository suites**

Run:

```bash
npx tsc -p tsconfig.test.json
node --test dist-test/src/veyra/transactions/transaction.service.spec.js
node --test dist-test/src/veyra/transactions/email-parser-template.repository.spec.js
```

Expected: both suites pass.

- [ ] **Step 5: Commit**

```bash
git add src/veyra/transactions/transaction.service.ts src/veyra/transactions/transaction.service.spec.ts
git commit -m "feat: activate confirmed email parser templates"
```

---

### Task 6: n8n Contract Documentation and Final Verification

**Files:**
- Modify: `README.md`
- Modify: `docs/migration/actionable-parity-checklist.md`

**Interfaces:**
- Documents existing endpoint `POST /api/veyra/transactions/email/handle`.
- Documents existing endpoint `POST /api/veyra/transactions/email/resolve-review`.
- Documents callbacks `save_transaction:*`, `change_categories:*`,
  `cancel_transaction:*`, and n8n-only interception of
  `edit_email_details:*`.

- [ ] **Step 1: Write the exact initial Gmail payload**

Add this request example:

```json
{
  "telegramUserId": "976684739",
  "userId": 1,
  "source": "email",
  "email": {
    "messageId": "gmail-message-id",
    "threadId": "gmail-thread-id",
    "from": "card@bca.co.id",
    "subject": "Credit Card Transaction Notification",
    "date": "2026-07-27T10:00:00+07:00",
    "emailText": "normalized plain-text body",
    "emailHtml": "<p>optional fallback body</p>",
    "authentication": {
      "dkim": "pass",
      "spf": "pass",
      "dmarc": "pass",
      "domain": "bca.co.id"
    }
  }
}
```

Document that `needs_ai` tells n8n to call its existing AI node using the
original Gmail data.

- [ ] **Step 2: Write the exact n8n AI submission payload**

Document:

```json
{
  "telegramUserId": "976684739",
  "reviewToken": "gmail-message-id",
  "email": {
    "messageId": "gmail-message-id",
    "from": "card@bca.co.id",
    "subject": "Credit Card Transaction Notification",
    "date": "2026-07-27T10:00:00+07:00",
    "emailText": "normalized plain-text body",
    "authentication": {
      "dkim": "pass",
      "spf": "pass",
      "dmarc": "pass",
      "domain": "bca.co.id"
    }
  },
  "transactionCandidate": {
    "source": "email",
    "bank": "BCA",
    "transactionType": "expense",
    "amount": 25000,
    "merchant": "Kopi Tuku",
    "merchantNormalized": "Kopi Tuku",
    "transactionDate": "2026-07-27T09:30:00+07:00",
    "description": "BCA credit-card purchase",
    "rawPayload": {}
  },
  "resolution": {
    "category": "Food",
    "confidence": 98,
    "resolver": "llm"
  },
  "templateProposal": {
    "provider": "BCA",
    "templateKey": "learned-bca-card",
    "requiredAnchors": ["Merchant / ATM", "Pada Tanggal", "Sejumlah"],
    "forbiddenAnchors": ["Promo"],
    "merchant": {
      "kind": "text",
      "after": "Merchant / ATM",
      "before": "Jenis Transaksi"
    },
    "amount": {
      "kind": "idr_amount",
      "after": "Sejumlah"
    },
    "transactionDate": {
      "kind": "datetime",
      "after": "Pada Tanggal",
      "before": "Sejumlah"
    },
    "transactionType": "expense",
    "paymentType": "Credit Card"
  }
}
```

- [ ] **Step 3: Document AI correction and callback ownership**

The correction payload is the previous AI submission plus:

```json
{
  "transactionId": "123"
}
```

and contains the corrected `transactionCandidate` and regenerated
`templateProposal`. State explicitly:

- n8n refetches Gmail by `messageId`;
- n8n sends the original candidate, user correction, and email to its AI node;
- n8n submits only the structured result to Core API;
- n8n intercepts `edit_email_details:*` and does not forward it to the generic
  Core API callback handler;
- Save, category, and cancel keep their existing production callbacks.

Document the n8n AI error submission:

```json
{
  "telegramUserId": "976684739",
  "reviewToken": "gmail-message-id",
  "email": {
    "messageId": "gmail-message-id",
    "from": "card@bca.co.id",
    "subject": "Credit Card Transaction Notification",
    "emailText": "normalized plain-text body"
  },
  "aiError": "model unavailable"
}
```

Core API returns `needs_review`, records `ai_failed`, and inserts no
transaction or template.

Update the parity checklist to mark learned templates and AI handoff complete
while retaining n8n AI invocation and workflow deployment as separate work.

- [ ] **Step 4: Run complete verification**

Run:

```bash
npm test
npm run lint
npm run build
git diff --check
```

Expected: all tests pass, lint exits successfully, build succeeds, and
`git diff --check` emits no output.

- [ ] **Step 5: Commit**

```bash
git add README.md docs/migration/actionable-parity-checklist.md
git commit -m "docs: define adaptive email parser n8n contract"
```

---

## Deferred n8n Rollout

This Core API plan intentionally stops before modifying production workflows.
After the API and migration are reviewed:

1. approve and apply `docs/migration/2026-07-27-email-parser-templates.sql`;
2. prepare a separate n8n rollout plan for `needs_ai`, structured AI output,
   `edit_email_details:*`, Gmail refetch, and sender-authentication mapping;
3. test against copied workflow fixtures;
4. request explicit approval before changing or activating production n8n.
