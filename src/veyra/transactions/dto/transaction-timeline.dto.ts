import {
  WebTransactionDto,
  WebTransactionsFilter,
  WebTransactionsQueryRequestDto,
} from "./web-transactions.dto";

export interface TimelineQueryRequest extends WebTransactionsQueryRequestDto {
  month?: string | null;
}

export type TimelineEntry =
  | {
      kind: "transaction";
      entryId: string;
      transaction: WebTransactionDto;
      hasInstallmentPlan: boolean;
      budgetAmount: number;
    }
  | {
      kind: "installment";
      entryId: string;
      planId: string;
      originalTransactionId: string;
      sequence: number;
      tenorMonths: number;
      dueDate: string;
      merchant: string;
      category: string;
      pocketId: string | null;
      principal: number;
      interest: number;
      total: number;
      budgetAmount: number;
      scheduledBudgetAmount: number;
      state: "scheduled" | "due";
      interestPostingPending: boolean;
    };

export interface TimelinePage {
  items: TimelineEntry[];
  previousCursor: string | null;
  nextCursor: string | null;
  categories: string[];
}

export interface TimelineCursor {
  v: 1;
  at: string;
  kind: 0 | 1;
  id: string;
}

export interface TimelineFilter extends Omit<WebTransactionsFilter, "cursor"> {
  cursor: TimelineCursor | null;
}

export type TimelineCategoryFilter = Omit<
  TimelineFilter,
  "category" | "cursor" | "direction" | "limit"
>;

export interface TimelineRow {
  sortAt: string;
  kindRank: 0 | 1;
  rowId: string;
  entry: TimelineEntry;
}
