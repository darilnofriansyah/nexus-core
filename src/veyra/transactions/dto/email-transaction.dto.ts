import { NormalizedTransactionType } from './normalize-transaction.dto';
import { TelegramReplyMarkupDto } from './confirmation-payload.dto';

export type EmailTransactionHandleStatus =
  | 'confirmed'
  | 'needs_review'
  | 'duplicate'
  | 'ignored_non_transaction'
  | 'unsupported_provider'
  | 'unsupported_template'
  | 'parse_failed';

export interface EmailTransactionMessageDto {
  messageId: string;
  threadId?: string;
  from: string;
  subject: string;
  date?: string;
  emailText: string;
  emailHtml?: string;
}

export interface EmailTransactionHandleRequestDto {
  telegramUserId: string;
  userId: string | number;
  source: 'email' | string;
  email: EmailTransactionMessageDto;
}

export interface EmailReviewTransactionCandidateDto {
  source: 'email' | string;
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
  transactionCandidate: EmailReviewTransactionCandidateDto;
  resolution: EmailReviewResolutionDto;
}

export interface ParsedEmailTransactionDto {
  provider: string;
  templateKey: string;
  emailId: string;
  merchant: string | null;
  amount: number | null;
  transactionDate: string | null;
  bank: string;
  paymentType: string;
  type: NormalizedTransactionType;
  confidence: number;
  isTransaction: boolean;
  raw: Record<string, unknown>;
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
  source: 'email';
  status: 'confirmed' | 'pending';
  confidence: number;
}

export interface EmailTransactionHandleResponseDto {
  status: EmailTransactionHandleStatus;
  provider: string | null;
  templateKey: string | null;
  reason: string | null;
  transaction?: EmailTransactionResponseTransactionDto;
  parsed?: ParsedEmailTransactionDto;
  telegram: {
    text: string;
    parseMode: 'HTML';
  };
}

export type EmailTransactionResolveReviewStatus =
  | 'confirmed'
  | 'pending'
  | 'needs_review';

export interface EmailReviewActionDto {
  action?: 'save_transaction' | 'cancel_transaction' | 'change_categories';
  transactionId?: string;
}

export interface EmailTransactionResolveReviewResponseDto {
  status: EmailTransactionResolveReviewStatus;
  reason?: 'user_not_found' | 'category_not_found';
  message?: string;
  transaction?: EmailTransactionResponseTransactionDto & {
    status: 'confirmed' | 'pending';
  };
  transactionCandidate?: EmailReviewTransactionCandidateDto;
  resolution?: EmailReviewResolutionDto;
  telegramText?: string;
  actions?: {
    confirm: EmailReviewActionDto;
    cancel: EmailReviewActionDto;
    changeCategory: EmailReviewActionDto;
  };
  replyMarkup?: TelegramReplyMarkupDto;
}
