import { NormalizedTransactionType } from './normalize-transaction.dto';

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
  status: 'confirmed';
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
