export type NormalizedTransactionType =
  | 'expense'
  | 'income'
  | 'transfer'
  | 'reversal';

export interface NormalizeTransactionRequestDto {
  userId: string;
  transactionType: string;
  amount: number | string;
  merchant: string;
  category?: string;
  transactionDate?: string;
  source?: string;
  notes?: string | null;
  rawPayload?: unknown;
}

export interface NormalizeTransactionResponseDto {
  userId: string;
  transactionType: NormalizedTransactionType;
  amount: number;
  merchant: string;
  merchantNormalized: string;
  category: string | null;
  transactionDate: string;
  source: string;
  notes: string | null;
  confidence: number;
  warnings: string[];
}
