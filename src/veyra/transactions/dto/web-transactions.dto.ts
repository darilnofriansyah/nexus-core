export type WebTransactionType = "income" | "expense";
export type WebTransactionDirection = "next" | "previous";

export const WEB_TRANSACTION_MAX_TEXT_LENGTH = 200;
export const WEB_TRANSACTION_MAX_CURSOR_LENGTH = 512;

export interface WebTransactionsQueryRequestDto {
  telegramUserId: string | number;
  cursor?: string | null;
  direction?: WebTransactionDirection | null;
  limit?: number | null;
  type?: WebTransactionType | null;
  cycle?: "current" | "previous" | null;
  category?: string | null;
  merchantQuery?: string | null;
  asOfDate?: string | null;
  timezone?: string | null;
}

export interface WebTransactionUpdateRequestDto {
  telegramUserId: string | number;
  amount?: number | null;
  merchant?: string | null;
  category?: string | null;
  pocketId?: string | null;
  expectedUpdatedAt: string;
}

export interface WebTransactionDto {
  id: string;
  amount: number;
  merchant: string | null;
  category: string | null;
  pocketId: string | null;
  pocketName: string | null;
  type: WebTransactionType;
  source: "telegram" | "email" | "manual" | "import";
  transactionDate: string;
  updatedAt: string;
  creditCard: boolean;
}

export interface WebTransactionsQueryResponseDto {
  items: WebTransactionDto[];
  previousCursor: string | null;
  nextCursor: string | null;
  categories: string[];
}

export interface WebTransactionCursor {
  transactionDate: string;
  id: string;
}

export interface WebTransactionsFilter {
  cursor: WebTransactionCursor | null;
  direction: WebTransactionDirection;
  limit: number;
  type: WebTransactionType | null;
  category: string | null;
  merchantQuery: string | null;
  cycle: "current" | "previous" | null;
  asOfDate: string;
  startDate: string | null;
  endDate: string | null;
  timezone: string;
}

export interface WebTransactionsUser {
  id: string;
  telegramUserId: string;
  cycleStartDay: number;
}

export interface WebTransactionRow {
  id: string;
  amount: number;
  merchant: string | null;
  category: string | null;
  pocketId: string | null;
  pocketName: string | null;
  transactionType: WebTransactionType;
  source: "telegram" | "email" | "manual" | "import";
  transactionDate: string;
  updatedAt: string;
  creditCard: boolean;
}

export interface WebTransactionChanges {
  amount?: number;
  merchant?: string | null;
  category?: string | null;
  pocketId?: string | null;
}

export type WebTransactionUpdateResult =
  | { kind: "not_found" }
  | { kind: "conflict" }
  | {
      kind: "invalid";
      message:
        | "expense merchant and category are required"
        | "pocket must be active and owned by user";
    }
  | { kind: "no_change" }
  | { kind: "updated"; transaction: WebTransactionRow };
