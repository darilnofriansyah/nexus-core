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

function templateProblem(
  proposal: EmailParserTemplateProposalDto,
): string | null {
  if (!proposal.provider.trim()) return "provider is required";
  if (!proposal.templateKey.trim()) return "template key is required";
  if (!proposal.paymentType.trim()) return "payment type is required";
  if (!isValidTransactionType(proposal.transactionType)) {
    return "transaction type is invalid";
  }

  const anchors = [
    ...proposal.requiredAnchors,
    ...(proposal.forbiddenAnchors ?? []),
  ];
  if (anchors.length > MAX_ANCHORS) return "too many anchors";
  if (anchors.some((anchor) => !anchor.trim())) return "anchor is empty";
  if (
    new Set(anchors.map((anchor) => anchor.toLowerCase())).size !==
    anchors.length
  ) {
    return "anchor is duplicated";
  }

  const rules = [proposal.amount, proposal.merchant, proposal.transactionDate];
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

function parseProposal(
  input: EmailParserInput,
  proposal: EmailParserTemplateProposalDto,
): ParsedEmailTransactionDto | null {
  const text = input.normalizedText;
  const merchant = captureLiteral(text, proposal.merchant);
  const amount = cleanAmount(
    captureLiteral(text, proposal.amount) ?? undefined,
  );
  const transactionDate = extractIndonesianDateTime(
    captureLiteral(text, proposal.transactionDate) ?? "",
  );

  if (!merchant || amount === null || !transactionDate) return null;

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
  const canonicalTemplateShape = {
    senderAddress: input.email.from.trim().toLowerCase(),
    provider: proposal.provider.trim(),
    templateKey: proposal.templateKey.trim(),
    requiredAnchors: proposal.requiredAnchors,
    forbiddenAnchors: proposal.forbiddenAnchors ?? [],
    captures: [proposal.amount, proposal.merchant, proposal.transactionDate],
    transactionType: proposal.transactionType,
    paymentType: proposal.paymentType.trim(),
  };

  return createHash("sha256")
    .update(JSON.stringify(canonicalTemplateShape))
    .digest("hex");
}

export function isLikelyTransactionEmail(input: EmailParserInput): boolean {
  const text = input.normalizedText.toLowerCase();
  const hasMoney =
    /\b(?:rp\.?|idr)\s*[\d.,]+\b|\b\d{1,3}(?:[.,]\d{3})+(?:[.,]\d{2})?\b/.test(
      text,
    );

  return (
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
  proposal: EmailParserTemplateProposalDto,
): EmailTemplateValidationResult {
  const problem = templateProblem(proposal);
  if (problem) return { ok: false, reason: problem };

  const lower = input.normalizedText.toLowerCase();
  if (
    proposal.requiredAnchors.some(
      (anchor) => !lower.includes(anchor.toLowerCase()),
    )
  ) {
    return { ok: false, reason: "required anchor was not found" };
  }
  if (
    proposal.forbiddenAnchors?.some((anchor) =>
      lower.includes(anchor.toLowerCase()),
    )
  ) {
    return { ok: false, reason: "forbidden anchor was found" };
  }

  const parsed = parseProposal(input, proposal);
  if (!parsed)
    return { ok: false, reason: "proposal did not produce a transaction" };

  return { ok: true, fingerprint: fingerprint(input, proposal), parsed };
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
