export type VeyraIntent =
  | 'set_budget'
  | 'delete_budget'
  | 'budget_status'
  | 'add_transaction'
  | 'edit_transaction'
  | 'delete_transaction'
  | 'confirm_transaction'
  | 'select_transaction'
  | 'confirm_action'
  | 'cancel_action'
  | 'spending_summary'
  | 'category_spending'
  | 'merchant_spending'
  | 'spending_comparison'
  | 'category_comparison'
  | 'merchant_comparison'
  | 'top_categories'
  | 'top_merchants'
  | 'daily_average_spending'
  | 'most_frequent_merchant'
  | 'spending_by_day'
  | 'weekday_analysis'
  | 'largest_transactions'
  | 'recent_transactions'
  | 'transaction_count'
  | 'subscription_summary'
  | 'spending_trend'
  | 'cashflow_summary'
  | 'help'
  | 'greeting'
  | 'unknown';

export interface IntentResult {
  intent: VeyraIntent;
  confidence: number;
  amount: number | null;
  merchant: string | null;
  category: string | null;
  period: string | null;
  limit: number | null;
  transactionId: string | null;
  budgetParent: string | null;
  target: IntentTarget | null;
  changes: Record<string, unknown> | null;
  selection: IntentSelection | null;
  requiresConfirmation: boolean;
  missingFields: string[];
  warnings: string[];
}

export interface IntentTarget {
  type: string;
  value: string;
}

export interface IntentSelection {
  type: string;
  value: string | number;
}
