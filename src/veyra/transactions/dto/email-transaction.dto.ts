import { NormalizedTransactionType } from "./normalize-transaction.dto";
import { TelegramReplyMarkupDto } from "./confirmation-payload.dto";
import { BudgetWatchdogResponseDto } from "../../budgets/dto/overspending-check.dto";
import { TransactionWatchdogNotificationDto } from "./transaction-watchdog.dto";

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
      proposal: EmailParserTemplateProposalDto;
      parsed: ParsedEmailTransactionDto;
    }
  | { ok: false; reason: string };

export interface EmailTransactionMessageDto {
  messageId: string;
  threadId?: string;
  from: string;
  subject: string;
  date?: string;
  emailText: string;
  emailHtml?: string;
  authentication?: EmailSenderAuthenticationDto;
}

export interface EmailTransactionHandleRequestDto {
  telegramUserId: string;
  userId?: string | number;
  source: "email" | string;
  email: EmailTransactionMessageDto;
}

export interface EmailReviewTransactionCandidateDto {
  source: "email" | string;
  bank?: string;
  transactionType: NormalizedTransactionType | string;
  amount: number | string;
  merchant?: string;
  merchantNormalized?: string;
  transactionDate?: string;
  description?: string;
  rawPayload?: Record<string, unknown>;
}

export interface EmailReviewResolutionDto {
  category?: string;
  confidence?: number;
  resolver?: string;
}

export interface EmailTransactionResolveReviewRequestDto {
  telegramUserId: string;
  reviewToken?: string;
  transactionId?: string;
  email?: EmailTransactionMessageDto;
  isTransaction?: boolean;
  transactionCandidate?: EmailReviewTransactionCandidateDto;
  resolution?: EmailReviewResolutionDto;
  templateProposal?: EmailParserTemplateProposalDto;
  aiError?: string;
}

export interface EmailValidatedTemplatePayloadDto {
  fingerprint: string;
  proposal: EmailParserTemplateProposalDto;
}

export interface ParsedEmailTransactionDto {
  ok: true;
  provider: string;
  templateKey: string;
  emailId: string;
  merchant: string | null;
  merchantNormalized: string | null;
  amount: number | null;
  transactionDate: string | null;
  bank: string;
  paymentType: string;
  type: NormalizedTransactionType;
  confidence: number;
  isTransaction: boolean;
  raw: Record<string, unknown>;
  warnings: string[];
}

export interface EmailTransactionResponseTransactionDto {
  id: string;
  userId: string;
  transactionType: NormalizedTransactionType;
  amount: number;
  merchant: string;
  merchantNormalized: string;
  category: string;
  transactionDate: string;
  source: "email";
  status: "confirmed" | "pending";
  confidence: number;
}

export interface EmailTransactionHandleResponseDto {
  status: EmailTransactionHandleStatus;
  provider: string | null;
  templateKey: string | null;
  reason: string | null;
  transaction?: EmailTransactionResponseTransactionDto;
  parsed?: ParsedEmailTransactionDto;
  aiRequest?: EmailAiHandoffDto;
  actions?: {
    confirm: EmailReviewActionDto;
    cancel: EmailReviewActionDto;
    changeCategory: EmailReviewActionDto;
    editDetails: EmailReviewActionDto;
  };
  replyMarkup?: TelegramReplyMarkupDto;
  telegram: {
    text: string;
    parseMode: "HTML";
  };
  notifications?: TransactionWatchdogNotificationDto[];
  watchdog?: BudgetWatchdogResponseDto;
}

export type EmailTransactionResolveReviewStatus =
  | "confirmed"
  | "pending"
  | "needs_review"
  | "ignored_non_transaction";

export interface EmailReviewActionDto {
  action?:
    | "save_transaction"
    | "cancel_transaction"
    | "change_categories"
    | "edit_email_details";
  transactionId?: string;
}

export interface EmailTransactionResolveReviewResponseDto {
  status: EmailTransactionResolveReviewStatus;
  reason?:
    | "user_not_found"
    | "category_not_found"
    | "ai_failed"
    | "ai_non_transaction";
  message?: string;
  transaction?: EmailTransactionResponseTransactionDto & {
    status: "confirmed" | "pending";
  };
  transactionCandidate?: EmailReviewTransactionCandidateDto;
  resolution?: EmailReviewResolutionDto;
  telegramText?: string;
  notifications?: TransactionWatchdogNotificationDto[];
  watchdog?: BudgetWatchdogResponseDto;
  actions?: {
    confirm: EmailReviewActionDto;
    cancel: EmailReviewActionDto;
    changeCategory: EmailReviewActionDto;
    editDetails: EmailReviewActionDto;
  };
  replyMarkup?: TelegramReplyMarkupDto;
}

export interface EmailSourceReferenceRequestDto {
  telegramUserId: string | number;
  transactionId: string | number;
}

export interface EmailSourceReferenceResponseDto {
  transactionId: string;
  messageId: string;
}
