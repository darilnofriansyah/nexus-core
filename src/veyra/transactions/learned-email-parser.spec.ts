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
