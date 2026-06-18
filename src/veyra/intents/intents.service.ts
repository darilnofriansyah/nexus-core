import { Injectable } from '@nestjs/common';
import { ClassifyIntentRequestDto } from './dto/classify-intent.dto';
import {
  IntentResult,
  IntentSelection,
  IntentTarget,
  VeyraIntent,
} from './intent-result.interface';

const CATEGORY_ALIASES: Array<{ category: string; patterns: RegExp[] }> = [
  { category: 'Food', patterns: [/\bfood\b/, /\bmakan(?:an)?\b/, /\bmeal\b/] },
  {
    category: 'Transport',
    patterns: [/\btransport\b/, /\btransportation\b/, /\bgojek\b/, /\bgrab\b/],
  },
  {
    category: 'Groceries',
    patterns: [/\bgroceries\b/, /\bgrocery\b/, /\bsupermarket\b/],
  },
  { category: 'Bills', patterns: [/\bbills?\b/, /\butilities\b/, /\blistrik\b/] },
  {
    category: 'Health & Beauty',
    patterns: [/\bhealth\b/, /\bbeauty\b/, /\bskincare\b/, /\bpharmacy\b/],
  },
  {
    category: 'Shopping',
    patterns: [/\bshopping\b/, /\bshop\b/, /\bshopee\b/, /\btokopedia\b/],
  },
  {
    category: 'Entertainment',
    patterns: [/\bentertainment\b/, /\bmovie\b/, /\bcinema\b/, /\bnetflix\b/],
  },
  { category: 'Transfer', patterns: [/\btransfer\b/] },
  { category: 'Other', patterns: [/\bother\b/, /\bmisc\b/] },
];

const PERIOD_PATTERNS: Array<{ period: string; pattern: RegExp }> = [
  { period: 'today', pattern: /\btoday\b|\bhari ini\b/ },
  { period: 'yesterday', pattern: /\byesterday\b|\bkemarin\b/ },
  { period: 'this_week', pattern: /\bthis week\b|\bminggu ini\b/ },
  { period: 'last_week', pattern: /\blast week\b|\bminggu lalu\b/ },
  { period: 'this_month', pattern: /\bthis month\b|\bbulan ini\b/ },
  { period: 'last_month', pattern: /\blast month\b|\bbulan lalu\b/ },
  { period: 'this_year', pattern: /\bthis year\b|\btahun ini\b/ },
  { period: 'last_year', pattern: /\blast year\b|\btahun lalu\b/ },
];

const SUPPORTED_INTENTS: readonly VeyraIntent[] = [
  'set_budget',
  'delete_budget',
  'budget_status',
  'add_transaction',
  'edit_transaction',
  'delete_transaction',
  'confirm_transaction',
  'select_transaction',
  'confirm_action',
  'cancel_action',
  'spending_summary',
  'category_spending',
  'merchant_spending',
  'spending_comparison',
  'category_comparison',
  'merchant_comparison',
  'top_categories',
  'top_merchants',
  'daily_average_spending',
  'most_frequent_merchant',
  'spending_by_day',
  'weekday_analysis',
  'largest_transactions',
  'recent_transactions',
  'transaction_count',
  'subscription_summary',
  'spending_trend',
  'cashflow_summary',
  'help',
  'greeting',
  'unknown',
];

const CONVERSATION_STATE_KEYS = [
  'expectedIntent',
  'nextIntent',
  'pendingIntent',
  'state',
  'status',
  'awaiting',
] as const;

@Injectable()
export class IntentsService {
  classify(request: ClassifyIntentRequestDto): IntentResult {
    const message = String(request.message ?? '').trim();
    const text = message.toLowerCase();
    const warnings: string[] = [];

    if (!message) {
      return this.result('unknown', 0.1, { warnings: ['message is empty'] });
    }

    const amount = this.extractAmount(text);
    const period = this.extractPeriod(text);
    const category = this.extractCategory(text);
    const limit = this.extractLimit(text);
    const transactionId = this.extractTransactionId(text);
    const merchant = this.extractMerchant(message);
    const budgetParent = this.extractBudgetParent(message);
    const selection = this.extractSelection(text);
    const intent =
      this.detectConversationStateIntent(request.conversationState, text) ??
      this.detectIntent(text, {
        amount,
        category,
        merchant,
        transactionId,
        selection,
      });
    const missingFields = this.missingFieldsFor(intent, {
      amount,
      category,
      merchant,
      transactionId,
    });
    const confidence = this.confidenceFor(intent, missingFields, {
      amount,
      category,
      merchant,
      period,
      transactionId,
    });

    if (request.timezone && request.timezone !== 'Asia/Jakarta') {
      warnings.push('timezone accepted but no timezone-specific calculation is run');
    }

    return this.result(intent, confidence, {
      amount,
      merchant,
      category,
      period,
      limit,
      transactionId,
      budgetParent,
      target: this.extractTarget(message, intent, {
        merchant,
        category,
        transactionId,
      }),
      changes: this.extractChanges(intent, amount, category, merchant),
      selection,
      requiresConfirmation: this.requiresConfirmation(intent),
      missingFields,
      warnings,
    });
  }

  private detectConversationStateIntent(
    conversationState: Record<string, unknown> | undefined,
    text: string,
  ): VeyraIntent | null {
    if (!conversationState) {
      return null;
    }

    if (/\b(cancel|nevermind|stop)\b/.test(text)) {
      return 'cancel_action';
    }

    if (/\b(confirm|approve|yes|yep|ok|okay)\b/.test(text)) {
      return 'confirm_action';
    }

    if (/\b\d+\b/.test(text)) {
      const expectedIntent = this.readConversationIntent(conversationState);

      if (expectedIntent === 'select_transaction') {
        return 'select_transaction';
      }
    }

    return this.readConversationIntent(conversationState);
  }

  private readConversationIntent(
    conversationState: Record<string, unknown>,
  ): VeyraIntent | null {
    for (const key of CONVERSATION_STATE_KEYS) {
      const value = conversationState[key];

      if (typeof value === 'string') {
        const normalized = value.toLowerCase().replace(/[-\s]+/g, '_');

        if (this.isVeyraIntent(normalized)) {
          return normalized;
        }

        if (/\bselect\b.*\btransaction\b/.test(normalized)) {
          return 'select_transaction';
        }

        if (/\bconfirm\b|\bapproval\b/.test(normalized)) {
          return 'confirm_action';
        }
      }
    }

    return null;
  }

  private isVeyraIntent(value: string): value is VeyraIntent {
    return SUPPORTED_INTENTS.includes(value as VeyraIntent);
  }

  private detectIntent(
    text: string,
    entities: {
      amount: number | null;
      category: string | null;
      merchant: string | null;
      transactionId: string | null;
      selection: IntentSelection | null;
    },
  ): VeyraIntent {
    if (/\b(help|commands?|what can you do)\b/.test(text)) {
      return 'help';
    }

    if (/^(hi|hello|hey|halo|hai)\b/.test(text)) {
      return 'greeting';
    }

    if (/\b(top|biggest)\b.*\bcategories\b/.test(text)) {
      return 'top_categories';
    }

    if (/\b(top|biggest)\b.*\bmerchants\b/.test(text)) {
      return 'top_merchants';
    }

    if (/\b(largest|biggest)\b.*\btransactions?\b/.test(text)) {
      return 'largest_transactions';
    }

    if (/\brecent\b.*\btransactions?\b/.test(text)) {
      return 'recent_transactions';
    }

    if (/\b(count|how many)\b.*\btransactions?\b/.test(text)) {
      return 'transaction_count';
    }

    if (/\bdaily average\b|\baverage daily\b/.test(text)) {
      return 'daily_average_spending';
    }

    if (/\bmost frequent\b.*\bmerchant\b|\bmerchant\b.*\bmost frequent\b/.test(text)) {
      return 'most_frequent_merchant';
    }

    if (/\bspending by day\b|\bby day\b/.test(text)) {
      return 'spending_by_day';
    }

    if (/\bweekday\b|\bday of week\b/.test(text)) {
      return 'weekday_analysis';
    }

    if (/\b(subscription|recurring)\b/.test(text)) {
      return 'subscription_summary';
    }

    if (/\btrend\b/.test(text)) {
      return 'spending_trend';
    }

    if (/\bcash\s*flow\b|\bcashflow\b|\bincome vs expense\b/.test(text)) {
      return 'cashflow_summary';
    }

    if (/\b(compare|comparison|vs|versus)\b.*\bmerchant/.test(text)) {
      return 'merchant_comparison';
    }

    if (/\b(compare|comparison|vs|versus)\b.*\bcategor/.test(text)) {
      return 'category_comparison';
    }

    if (/\b(compare|comparison|vs|versus)\b/.test(text)) {
      return 'spending_comparison';
    }

    if (/\bhow much\b.*\b(spend|spent|expense)\b|\bspending summary\b/.test(text)) {
      return 'spending_summary';
    }

    if (
      /\b(spent|paid|bought|purchase|expense|income|received|earned)\b/.test(text) &&
      entities.amount !== null
    ) {
      return 'add_transaction';
    }

    if (/\b(spend|spent|expense)\b.*\b(at|from|merchant)\b/.test(text)) {
      return 'merchant_spending';
    }

    if (
      /\b(spend|spent|expense)\b.*\b(on|for|category)\b/.test(text) &&
      entities.category
    ) {
      return 'category_spending';
    }

    if (/\b(delete|remove)\b.*\bbudget\b/.test(text)) {
      return 'delete_budget';
    }

    if (/\b(budget)\b.*\b(status|left|remaining|balance|check|show)\b/.test(text)) {
      return 'budget_status';
    }

    if (/\b(status|left|remaining|balance|check|show)\b.*\bbudget\b/.test(text)) {
      return 'budget_status';
    }

    if (/\bbudget\b/.test(text) && (entities.amount !== null || entities.category)) {
      return 'set_budget';
    }

    if (/\b(confirm|approve)\b.*\b(transaction|tx)\b/.test(text)) {
      return 'confirm_transaction';
    }

    if (entities.selection && /\b(select|choose|pick)\b/.test(text)) {
      return 'select_transaction';
    }

    if (/^\s*\d+\s*$/.test(text)) {
      return 'select_transaction';
    }

    if (/\b(edit|change|update)\b.*\btransactions?\b/.test(text)) {
      return 'edit_transaction';
    }

    if (/\b(delete|remove|reject)\b.*\btransactions?\b/.test(text)) {
      return 'delete_transaction';
    }

    if (/\b(spent|paid|bought|purchase|expense|income|received|earned)\b/.test(text)) {
      return 'add_transaction';
    }

    return 'unknown';
  }

  private extractAmount(text: string): number | null {
    const amountMatch = text.match(
      /(?:rp\s*)?(\d+(?:[.,]\d+)?)\s*(million|mio|juta|jt|k|rb|ribu)?\b/,
    );

    if (!amountMatch) {
      return null;
    }

    const numeric = Number(amountMatch[1].replace(',', '.'));
    const unit = amountMatch[2];

    if (!Number.isFinite(numeric)) {
      return null;
    }

    if (unit === 'million' || unit === 'mio' || unit === 'juta' || unit === 'jt') {
      return Math.round(numeric * 1_000_000);
    }

    if (unit === 'k' || unit === 'rb' || unit === 'ribu') {
      return Math.round(numeric * 1_000);
    }

    return Math.round(numeric);
  }

  private extractPeriod(text: string): string | null {
    return PERIOD_PATTERNS.find(({ pattern }) => pattern.test(text))?.period ?? null;
  }

  private extractLimit(text: string): number | null {
    const match = text.match(/\b(?:top|last|recent|largest|biggest)\s+(\d{1,2})\b/);

    if (!match) {
      return null;
    }

    const limit = Number(match[1]);
    return Number.isInteger(limit) && limit > 0 ? limit : null;
  }

  private extractCategory(text: string): string | null {
    return (
      CATEGORY_ALIASES.find(({ patterns }) =>
        patterns.some((pattern) => pattern.test(text)),
      )?.category ?? null
    );
  }

  private extractTransactionId(text: string): string | null {
    const match = text.match(/\b(?:tx|transaction)\s*#?:?\s*([a-z0-9-]{3,})\b/);
    return match?.[1] ?? null;
  }

  private extractSelection(text: string): IntentSelection | null {
    const match =
      text.match(/^\s*#?\s*(\d{1,3})\s*$/) ??
      text.match(/\b(?:select|choose|pick)\s+#?\s*(\d{1,3})\b/);

    if (!match) {
      return null;
    }

    return {
      type: 'index',
      value: Number(match[1]),
    };
  }

  private extractMerchant(message: string): string | null {
    const atMatch = message.match(/\b(?:at|from|to)\s+([A-Za-z0-9][\w&'. -]{1,40})/i);

    if (atMatch) {
      return this.cleanMerchant(atMatch[1]);
    }

    const deleteMatch = message.match(
      /\b(?:delete|remove|reject|edit|change|update)\s+(?:my\s+)?([A-Za-z0-9][\w&'. -]{1,40})\s+transaction\b/i,
    );

    if (deleteMatch) {
      return this.cleanMerchant(deleteMatch[1]);
    }

    return null;
  }

  private extractBudgetParent(message: string): string | null {
    const match = message.match(/\bunder\s+([A-Za-z][\w&'. -]{1,40})\b/i);
    return match ? this.titleCaseWords(match[1]) : null;
  }

  private extractTarget(
    message: string,
    intent: VeyraIntent,
    entities: {
      merchant: string | null;
      category: string | null;
      transactionId: string | null;
    },
  ): IntentTarget | null {
    if (entities.transactionId && intent.includes('transaction')) {
      return { type: 'transaction', value: entities.transactionId };
    }

    if (entities.merchant && intent.includes('transaction')) {
      return { type: 'merchant', value: entities.merchant };
    }

    if (entities.merchant && intent.includes('merchant')) {
      return { type: 'merchant', value: entities.merchant };
    }

    if (entities.category && intent.includes('budget')) {
      return { type: 'category', value: entities.category };
    }

    if (entities.category && intent.includes('categor')) {
      return { type: 'category', value: entities.category };
    }

    if (
      intent === 'unknown' ||
      intent === 'help' ||
      intent === 'greeting' ||
      intent === 'cancel_action' ||
      intent === 'confirm_action' ||
      intent === 'select_transaction'
    ) {
      return null;
    }

    return { type: 'text', value: message };
  }

  private extractChanges(
    intent: VeyraIntent,
    amount: number | null,
    category: string | null,
    merchant: string | null,
  ): Record<string, unknown> | null {
    if (intent === 'set_budget') {
      return { amount, category };
    }

    if (intent === 'edit_transaction') {
      return { amount, category, merchant };
    }

    return null;
  }

  private missingFieldsFor(
    intent: VeyraIntent,
    entities: {
      amount: number | null;
      category: string | null;
      merchant: string | null;
      transactionId: string | null;
    },
  ): string[] {
    const missing: string[] = [];

    if (intent === 'set_budget') {
      if (entities.category === null) missing.push('category');
      if (entities.amount === null) missing.push('amount');
    }

    if (intent === 'add_transaction') {
      if (entities.amount === null) missing.push('amount');
      if (entities.merchant === null) missing.push('merchant');
    }

    if (intent === 'edit_transaction' || intent === 'confirm_transaction') {
      if (entities.transactionId === null) missing.push('transactionId');
    }

    if (intent === 'delete_transaction') {
      if (entities.transactionId === null && entities.merchant === null) {
        missing.push('transactionId');
      }
    }

    return missing;
  }

  private confidenceFor(
    intent: VeyraIntent,
    missingFields: string[],
    entities: {
      amount: number | null;
      category: string | null;
      merchant: string | null;
      period: string | null;
      transactionId: string | null;
    },
  ): number {
    if (intent === 'unknown') {
      return 0.2;
    }

    if (intent === 'help' || intent === 'greeting') {
      return 0.9;
    }

    let confidence = 0.65;

    if (entities.amount !== null) confidence += 0.08;
    if (entities.category !== null) confidence += 0.08;
    if (entities.merchant !== null) confidence += 0.08;
    if (entities.period !== null) confidence += 0.08;
    if (entities.transactionId !== null) confidence += 0.08;

    confidence -= missingFields.length * 0.12;

    return Number(Math.min(Math.max(confidence, 0.25), 0.95).toFixed(2));
  }

  private requiresConfirmation(intent: VeyraIntent): boolean {
    return (
      intent === 'set_budget' ||
      intent === 'delete_budget' ||
      intent === 'add_transaction' ||
      intent === 'edit_transaction' ||
      intent === 'delete_transaction' ||
      intent === 'confirm_transaction' ||
      intent === 'confirm_action'
    );
  }

  private result(
    intent: VeyraIntent,
    confidence: number,
    overrides: Partial<IntentResult> = {},
  ): IntentResult {
    return {
      intent,
      confidence,
      amount: null,
      merchant: null,
      category: null,
      period: null,
      limit: null,
      transactionId: null,
      budgetParent: null,
      target: null,
      changes: null,
      selection: null,
      requiresConfirmation: false,
      missingFields: [],
      warnings: [],
      ...overrides,
    };
  }

  private cleanMerchant(value: string): string {
    return this.titleCaseWords(
      value
        .replace(/\b(this|last|today|yesterday|transaction)\b.*$/i, '')
        .replace(/[?.!,]+$/g, '')
        .trim(),
    );
  }

  private titleCaseWords(value: string): string {
    return value
      .trim()
      .split(/\s+/)
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  }
}
