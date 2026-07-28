import * as assert from "node:assert/strict";
import { test } from "node:test";
import {
  EmailParserTemplateProposalDto,
  EmailTransactionMessageDto,
} from "./dto/email-transaction.dto";
import {
  hasAlignedSenderAuthentication,
  isLikelyTransactionEmail,
  parseLearnedEmailTemplate,
  validateEmailTemplateProposal,
  validateStoredEmailTemplateProposal,
} from "./learned-email-parser";
import { EmailParserInput, normalizeEmailWhitespace } from "./email-parsers";

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
  const templateProposal: EmailParserTemplateProposalDto = {
    provider: "Krom",
    templateKey: "learned-krom-qris",
    requiredAnchors: [
      "Transaksi QRIS berhasil",
      "Merchant:",
      "Jumlah:",
      "Tanggal:",
    ],
    forbiddenAnchors: ["Promo"],
    merchant: { kind: "text", after: "Merchant:", before: "Jumlah:" },
    amount: { kind: "idr_amount", after: "Jumlah:", before: "Tanggal:" },
    transactionDate: { kind: "datetime", after: "Tanggal:" },
    transactionType: "expense",
    paymentType: "QRIS",
  };

  const validated = validateEmailTemplateProposal(
    parserInput,
    templateProposal,
  );

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
    proposal: templateProposal,
  });
  assert.equal(replayed?.amount, 25000);
});

test("treats regex-looking anchors as literals", () => {
  const result = validateEmailTemplateProposal(
    input("Transaksi Rp25.000", { from: "bank@example.com" }),
    proposal({
      requiredAnchors: [".*"],
      amount: { kind: "idr_amount", after: ".*" },
    }),
  );

  assert.deepEqual(result, {
    ok: false,
    reason: "required anchor was not found",
  });
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

test("rejects proposals without required anchors", () => {
  const result = validateEmailTemplateProposal(
    input("Merchant: Tuku Jumlah: Rp25.000 Tanggal: 25 Juni 2026 09:30"),
    proposal({ requiredAnchors: [] }),
  );

  assert.deepEqual(result, { ok: false, reason: "required anchors are empty" });
});

test("requires the fixed capture kinds", () => {
  const parserInput = input(
    "Merchant: Tuku Jumlah: Rp25.000 Tanggal: 25 Juni 2026 09:30",
  );

  for (const invalidProposal of [
    proposal({ amount: { kind: "text", after: "Jumlah:" } }),
    proposal({ merchant: { kind: "datetime", after: "Merchant:" } }),
    proposal({
      transactionDate: {
        kind: "unknown" as "datetime",
        after: "Tanggal:",
      },
    }),
  ]) {
    assert.deepEqual(
      validateEmailTemplateProposal(parserInput, invalidProposal),
      {
        ok: false,
        reason: "capture rule kind is invalid",
      },
    );
  }
});

test("returns invalid for structurally malformed proposals", () => {
  const parserInput = input(
    "Merchant: Tuku Jumlah: Rp25.000 Tanggal: 25 Juni 2026 09:30",
  );
  const malformed = [
    {},
    { ...proposal(), requiredAnchors: "Merchant:" },
    { ...proposal(), forbiddenAnchors: [1] },
    { ...proposal(), amount: {} },
    { ...proposal(), merchant: { kind: "text" } },
    { ...proposal(), transactionDate: null },
  ];

  for (const value of malformed) {
    const result = validateEmailTemplateProposal(parserInput, value);
    assert.equal(result.ok, false);
  }
});

test("validates a stored proposal against its sender fingerprint", () => {
  const parserInput = input(
    "Merchant: Tuku Jumlah: Rp25.000 Tanggal: 25 Juni 2026 09:30",
  );
  const templateProposal = proposal();
  const validated = validateEmailTemplateProposal(
    parserInput,
    templateProposal,
  );
  assert.equal(validated.ok, true);
  if (!validated.ok) return;

  assert.deepEqual(
    validateStoredEmailTemplateProposal({
      senderAddress: parserInput.email.from,
      fingerprint: validated.fingerprint,
      proposal: templateProposal,
    }),
    templateProposal,
  );
});

test("rejects malformed or fingerprint-mismatched stored proposals", () => {
  assert.equal(
    validateStoredEmailTemplateProposal({
      senderAddress: "no-reply@krom.id",
      fingerprint: "f".repeat(64),
      proposal: { ...proposal(), amount: { kind: "text" } },
    }),
    null,
  );
  assert.equal(
    validateStoredEmailTemplateProposal({
      senderAddress: "no-reply@krom.id",
      fingerprint: "f".repeat(64),
      proposal: proposal(),
    }),
    null,
  );
});

test("detects transactions but rejects marketing email", () => {
  assert.equal(
    isLikelyTransactionEmail(
      input("Pembayaran berhasil sebesar Rp25.000", {
        from: "bank@example.com",
      }),
    ),
    true,
  );
  assert.equal(
    isLikelyTransactionEmail(
      input("Promo diskon belanja hingga Rp25.000", {
        from: "bank@example.com",
      }),
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

test("requires ordered anchors and a closing boundary after its opening boundary", () => {
  assert.deepEqual(
    validateEmailTemplateProposal(
      input(
        "Jumlah: Rp25.000 Merchant: Tuku Tanggal: 25 Juni 2026 09:30",
      ),
      proposal({
        requiredAnchors: ["Merchant:", "Jumlah:", "Tanggal:"],
      }),
    ),
    { ok: false, reason: "required anchors are out of order" },
  );

  assert.deepEqual(
    validateEmailTemplateProposal(
      input(
        "Merchant: Tuku Jumlah: Rp25.000 Tanggal: 25 Juni 2026 09:30",
      ),
      proposal({
        amount: {
          kind: "idr_amount",
          after: "Jumlah:",
          before: "Missing:",
        },
      }),
    ),
    { ok: false, reason: "proposal did not produce a transaction" },
  );
});

test("rejects a non-positive captured amount", () => {
  for (const amount of ["Rp0", "Rp-25.000", "Rp−25.000"]) {
    const result = validateEmailTemplateProposal(
      input(
        `Merchant: Tuku Jumlah: ${amount} Tanggal: 25 Juni 2026 09:30`,
      ),
      proposal({
        amount: {
          kind: "idr_amount",
          after: "Jumlah:",
          before: "Tanggal:",
        },
      }),
    );

    assert.deepEqual(result, {
      ok: false,
      reason: "proposal did not produce a transaction",
    });
  }
});

test("canonicalizes untrusted proposals before fingerprinting and storage", () => {
  const parserInput = input(
    "Merchant: Tuku Jumlah: Rp25.000 Tanggal: 25 Juni 2026 09:30",
  );
  const untrusted = {
    ...proposal(),
    injected: "email body must never persist",
    amount: {
      ...proposal().amount,
      executable: "process.exit()",
    },
  };

  const validated = validateEmailTemplateProposal(parserInput, untrusted);

  assert.equal(validated.ok, true);
  if (!validated.ok) return;
  assert.equal("injected" in validated.proposal, false);
  assert.equal(
    "executable" in (validated.proposal.amount as unknown as object),
    false,
  );

  const roundTripped = JSON.parse(
    JSON.stringify(validated.proposal),
  ) as EmailParserTemplateProposalDto;
  const replayed = validateEmailTemplateProposal(parserInput, roundTripped);
  assert.equal(replayed.ok, true);
  if (!replayed.ok) return;
  assert.equal(replayed.fingerprint, validated.fingerprint);
});

test("does not treat Rp punctuation without a digit as money", () => {
  assert.equal(
    isLikelyTransactionEmail(
      input("Pembayaran berhasil, nilai transaksi Rp.", {
        from: "bank@example.com",
      }),
    ),
    false,
  );
});

test("rejects duplicate capture boundaries that could select an earlier value", () => {
  const result = validateEmailTemplateProposal(
    input(
      "Jumlah: Rp1 Pembayaran QR berhasil Merchant: Tuku Jumlah: Rp25.000 Tanggal: 25 Juni 2026 09:30",
    ),
    proposal({
      requiredAnchors: [
        "Pembayaran QR berhasil",
        "Merchant:",
        "Jumlah:",
        "Tanggal:",
      ],
      amount: {
        kind: "idr_amount",
        after: "Jumlah:",
        before: "Tanggal:",
      },
    }),
  );

  assert.deepEqual(result, {
    ok: false,
    reason: "anchor or capture boundary is ambiguous",
  });
});
