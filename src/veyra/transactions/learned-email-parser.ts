import { createHash } from "node:crypto";
import {
  EmailParserTemplateProposalDto,
  EmailTemplateCaptureRuleDto,
  EmailTemplateValidationResult,
  EmailTransactionMessageDto,
  LearnedEmailTemplate,
  ParsedEmailTransactionDto,
} from "./dto/email-transaction.dto";
import { NormalizedTransactionType } from "./dto/normalize-transaction.dto";
import {
  cleanAmount,
  EmailParserInput,
  extractIndonesianDateTime,
  normalizeEmailWhitespace,
} from "./email-parsers";

const MAX_ANCHORS = 20;
const MAX_ANCHOR_LENGTH = 200;
const TRANSACTION_TYPES: NormalizedTransactionType[] = [
  "expense",
  "income",
  "transfer",
  "reversal",
];
const TRANSACTION_SIGNALS = [
  "transaction",
  "transaksi",
  "pembayaran",
  "payment",
  "transfer",
  "debit",
  "credit",
  "top-up",
  "qris",
];
const MARKETING_SIGNALS = [
  "promo",
  "discount",
  "diskon",
  "newsletter",
  "offer",
  "penawaran",
];

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
  if (rule.before && end < 0) return null;
  const value = (end < 0 ? tail : tail.slice(0, end)).trim();

  return value || null;
}

function senderDomain(address: string): string | null {
  const at = address.trim().lastIndexOf("@");
  return at < 1 ? null : address.slice(at + 1).toLowerCase();
}

function isValidTransactionType(
  value: string,
): value is NormalizedTransactionType {
  return TRANSACTION_TYPES.includes(value as NormalizedTransactionType);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function templateProblem(proposal: unknown): string | null {
  if (!isRecord(proposal)) return "proposal is required";
  if (typeof proposal.provider !== "string" || !proposal.provider.trim()) {
    return "provider is required";
  }
  if (
    typeof proposal.templateKey !== "string" ||
    !proposal.templateKey.trim()
  ) {
    return "template key is required";
  }
  if (
    typeof proposal.paymentType !== "string" ||
    !proposal.paymentType.trim()
  ) {
    return "payment type is required";
  }
  if (
    typeof proposal.transactionType !== "string" ||
    !isValidTransactionType(proposal.transactionType)
  ) {
    return "transaction type is invalid";
  }
  if (
    !isRecord(proposal.amount) ||
    !isRecord(proposal.merchant) ||
    !isRecord(proposal.transactionDate)
  ) {
    return "capture rule is invalid";
  }
  if (
    proposal.amount.kind !== "idr_amount" ||
    proposal.merchant.kind !== "text" ||
    proposal.transactionDate.kind !== "datetime"
  ) {
    return "capture rule kind is invalid";
  }

  if (
    !Array.isArray(proposal.requiredAnchors) ||
    proposal.requiredAnchors.some((anchor) => typeof anchor !== "string") ||
    (proposal.forbiddenAnchors !== undefined &&
      (!Array.isArray(proposal.forbiddenAnchors) ||
        proposal.forbiddenAnchors.some((anchor) => typeof anchor !== "string")))
  ) {
    return "anchors are invalid";
  }

  const validatedProposal =
    proposal as unknown as EmailParserTemplateProposalDto;
  const anchors = [
    ...validatedProposal.requiredAnchors,
    ...(validatedProposal.forbiddenAnchors ?? []),
  ];
  if (!validatedProposal.requiredAnchors.length)
    return "required anchors are empty";
  if (anchors.length > MAX_ANCHORS) return "too many anchors";
  if (anchors.some((anchor) => !anchor.trim())) return "anchor is empty";
  if (
    new Set(anchors.map((anchor) => anchor.toLowerCase())).size !==
    anchors.length
  ) {
    return "anchor is duplicated";
  }

  const rules = [
    validatedProposal.amount,
    validatedProposal.merchant,
    validatedProposal.transactionDate,
  ];
  if (
    rules.some(
      (rule) =>
        typeof rule.after !== "string" ||
        (rule.before !== undefined && typeof rule.before !== "string"),
    )
  ) {
    return "capture boundary is invalid";
  }
  const boundaries = rules.flatMap((rule) =>
    rule.before === undefined ? [rule.after] : [rule.after, rule.before],
  );
  if (boundaries.some((boundary) => !boundary.trim()))
    return "capture boundary is empty";
  if (
    [...anchors, ...boundaries].some(
      (value) => value.length > MAX_ANCHOR_LENGTH,
    )
  ) {
    return "anchor or boundary is too long";
  }

  return null;
}

function canonicalProposal(
  proposal: EmailParserTemplateProposalDto,
): EmailParserTemplateProposalDto {
  const capture = (
    rule: EmailTemplateCaptureRuleDto,
  ): EmailTemplateCaptureRuleDto => ({
    kind: rule.kind,
    after: rule.after,
    ...(rule.before === undefined ? {} : { before: rule.before }),
  });

  return {
    provider: proposal.provider.trim(),
    templateKey: proposal.templateKey.trim(),
    requiredAnchors: [...proposal.requiredAnchors],
    ...(proposal.forbiddenAnchors === undefined
      ? {}
      : { forbiddenAnchors: [...proposal.forbiddenAnchors] }),
    amount: capture(proposal.amount),
    merchant: capture(proposal.merchant),
    transactionDate: capture(proposal.transactionDate),
    transactionType: proposal.transactionType,
    paymentType: proposal.paymentType.trim(),
  };
}

function parseProposal(
  input: EmailParserInput,
  proposal: EmailParserTemplateProposalDto,
): ParsedEmailTransactionDto | null {
  const text = input.normalizedText;
  const merchant = captureLiteral(text, proposal.merchant);
  const capturedAmount = captureLiteral(text, proposal.amount);
  const amount =
    capturedAmount && !/[-−]/u.test(capturedAmount)
      ? cleanAmount(capturedAmount)
      : null;
  const transactionDate = extractIndonesianDateTime(
    captureLiteral(text, proposal.transactionDate) ?? "",
  );

  if (!merchant || amount === null || amount <= 0 || !transactionDate) {
    return null;
  }

  return {
    ok: true,
    provider: proposal.provider.trim(),
    templateKey: proposal.templateKey.trim(),
    emailId: input.email.messageId,
    merchant: normalizeEmailWhitespace(merchant),
    merchantNormalized: null,
    amount,
    transactionDate,
    bank: proposal.provider.trim(),
    paymentType: proposal.paymentType.trim(),
    type: proposal.transactionType,
    confidence: 90,
    isTransaction: true,
    raw: { subject: input.email.subject, bodySource: input.bodySource },
    warnings: input.bodyWarnings,
  };
}

function fingerprint(
  input: EmailParserInput,
  proposal: EmailParserTemplateProposalDto,
): string {
  return templateFingerprint(input.email.from, proposal);
}

function templateFingerprint(
  senderAddress: string,
  proposal: EmailParserTemplateProposalDto,
): string {
  const canonicalTemplateShape = {
    senderAddress: senderAddress.trim().toLowerCase(),
    provider: proposal.provider.trim(),
    templateKey: proposal.templateKey.trim(),
    requiredAnchors: proposal.requiredAnchors,
    forbiddenAnchors: proposal.forbiddenAnchors ?? [],
    captures: {
      amount: proposal.amount,
      merchant: proposal.merchant,
      transactionDate: proposal.transactionDate,
    },
    transactionType: proposal.transactionType,
    paymentType: proposal.paymentType.trim(),
  };

  return createHash("sha256")
    .update(JSON.stringify(canonicalTemplateShape))
    .digest("hex");
}

function occurrenceCount(text: string, literal: string): number {
  let count = 0;
  let offset = 0;

  while ((offset = text.indexOf(literal, offset)) >= 0) {
    count += 1;
    offset += literal.length;
  }

  return count;
}

export function isLikelyTransactionEmail(input: EmailParserInput): boolean {
  const text = normalizeEmailWhitespace(
    `${input.email.subject} ${input.normalizedText}`,
  ).toLowerCase();
  const hasMoney =
    /\b(?:rp\.?|idr)\s*\d[\d.,]*\b|\b\d{1,3}(?:[.,]\d{3})+(?:[.,]\d{2})?\b/.test(
      text,
    );
  const domain = senderDomain(input.email.from);
  const trustedDomain =
    domain === "bca.co.id" ||
    domain === "bankmandiri.co.id" ||
    domain === "krom.id";

  return (
    trustedDomain &&
    hasAlignedSenderAuthentication(input.email) &&
    hasMoney &&
    TRANSACTION_SIGNALS.some((signal) => text.includes(signal)) &&
    !MARKETING_SIGNALS.some((signal) => text.includes(signal))
  );
}

export function hasAlignedSenderAuthentication(
  email: EmailTransactionMessageDto,
): boolean {
  const domain = senderDomain(email.from);
  const authenticatedDomain = email.authentication?.domain
    ?.trim()
    .toLowerCase();

  return (
    !!domain &&
    domain === authenticatedDomain &&
    (email.authentication?.dkim === "pass" ||
      email.authentication?.dmarc === "pass")
  );
}

export function validateEmailTemplateProposal(
  input: EmailParserInput,
  proposal: unknown,
): EmailTemplateValidationResult {
  const problem = templateProblem(proposal);
  if (problem) return { ok: false, reason: problem };
  const validatedProposal = canonicalProposal(
    proposal as EmailParserTemplateProposalDto,
  );

  const lower = input.normalizedText.toLowerCase();
  let anchorOffset = 0;
  for (const anchor of validatedProposal.requiredAnchors) {
    const index = lower.indexOf(anchor.toLowerCase(), anchorOffset);
    if (index < 0) {
      return {
        ok: false,
        reason: lower.includes(anchor.toLowerCase())
          ? "required anchors are out of order"
          : "required anchor was not found",
      };
    }
    anchorOffset = index + anchor.length;
  }
  const captureBoundaries = [
    validatedProposal.amount,
    validatedProposal.merchant,
    validatedProposal.transactionDate,
  ].flatMap((rule) =>
    rule.before === undefined ? [rule.after] : [rule.after, rule.before],
  );
  const selectionLiterals = new Set(
    [...validatedProposal.requiredAnchors, ...captureBoundaries].map((value) =>
      value.toLowerCase(),
    ),
  );
  if (
    [...selectionLiterals].some(
      (literal) => occurrenceCount(lower, literal) > 1,
    )
  ) {
    return {
      ok: false,
      reason: "anchor or capture boundary is ambiguous",
    };
  }
  if (
    validatedProposal.forbiddenAnchors?.some((anchor) =>
      lower.includes(anchor.toLowerCase()),
    )
  ) {
    return { ok: false, reason: "forbidden anchor was found" };
  }

  const parsed = parseProposal(input, validatedProposal);
  if (!parsed)
    return { ok: false, reason: "proposal did not produce a transaction" };

  return {
    ok: true,
    fingerprint: fingerprint(input, validatedProposal),
    proposal: validatedProposal,
    parsed,
  };
}

export function validateStoredEmailTemplateProposal(input: {
  senderAddress: string;
  fingerprint: string;
  proposal: unknown;
}): EmailParserTemplateProposalDto | null {
  if (templateProblem(input.proposal)) return null;
  const proposal = canonicalProposal(
    input.proposal as EmailParserTemplateProposalDto,
  );

  return templateFingerprint(input.senderAddress, proposal) ===
    input.fingerprint
    ? proposal
    : null;
}

export function parseLearnedEmailTemplate(
  input: EmailParserInput,
  template: LearnedEmailTemplate,
): ParsedEmailTransactionDto | null {
  if (
    input.email.from.trim().toLowerCase() !==
    template.senderAddress.trim().toLowerCase()
  ) {
    return null;
  }

  const validated = validateEmailTemplateProposal(input, template.proposal);
  return validated.ok && validated.fingerprint === template.fingerprint
    ? validated.parsed
    : null;
}
