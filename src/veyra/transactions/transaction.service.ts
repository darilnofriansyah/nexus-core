import { BadRequestException, Injectable } from '@nestjs/common';
import { QueryResultRow } from 'pg';
import { DatabaseService } from '../../database/database.service';
import {
  NormalizeTransactionRequestDto,
  NormalizeTransactionResponseDto,
  NormalizedTransactionType,
} from './dto/normalize-transaction.dto';
import {
  TelegramReplyMarkupDto,
  TransactionCallbackMode,
  TransactionConfirmationPayloadRequestDto,
  TransactionConfirmationPayloadResponseDto,
} from './dto/confirmation-payload.dto';
import {
  ConfirmTransactionRequestDto,
  ConfirmTransactionResponseDto,
  ConfirmTransactionEditMessageDto,
  ConfirmTransactionSummaryDto,
  ConfirmTransactionStatus,
} from './dto/confirm-transaction.dto';
import {
  TransactionCategoryOptionStatus,
  TransactionCategoryOptionsRequestDto,
  TransactionCategoryOptionsResponseDto,
  TransactionSetCategoryStatus,
  TransactionSetCategoryRequestDto,
  TransactionSetCategoryResponseDto,
} from './dto/category-callback.dto';
import {
  TransactionCallbackHandleAction,
  TransactionCallbackHandleRequestDto,
  TransactionCallbackHandleResponseDto,
} from './dto/transaction-callback-handle.dto';
import {
  SavedTransactionDto,
  SaveTransactionInputDto,
  TransactionHandleRequestDto,
  TransactionHandleResponseDto,
  TransactionHandleStateName,
  TransactionStatus,
} from './dto/handle-transaction.dto';
import {
  EmailReviewResolutionDto,
  EmailReviewTransactionCandidateDto,
  EmailTransactionHandleRequestDto,
  EmailTransactionHandleResponseDto,
  EmailTransactionHandleStatus,
  EmailTransactionResolveReviewRequestDto,
  EmailTransactionResolveReviewResponseDto,
  ParsedEmailTransactionDto,
} from './dto/email-transaction.dto';
import {
  EmailParserInput,
  EmailTransactionParser,
  buildEmailParserRegistry,
  normalizeEmailWhitespace,
} from './email-parsers';

const TRANSACTION_CATEGORY_OPTIONS = [
  'Food',
  'Transport',
  'Groceries',
  'Bills',
  'Health & Beauty',
  'Shopping',
  'Entertainment',
  'Transfer',
  'Other',
] as const;

const PRODUCTION_CALLBACK_MODE: TransactionCallbackMode = 'production';
const EXPERIMENTAL_CALLBACK_MODE: TransactionCallbackMode = 'experimental';
const EMPTY_CONFIRMATION_FIELD = '-';

interface MerchantAliasRow extends QueryResultRow {
  id?: string | number;
  canonical_name: string;
}

interface CategoryRuleRow extends QueryResultRow {
  id?: string | number;
  category: string;
}

interface TelegramUserRow extends QueryResultRow {
  id: string | number;
  telegram_id: string | number | null;
}

interface ExistingImportRow extends QueryResultRow {
  id: string | number;
  transaction_id: string | number | null;
  status: string;
}

interface PendingTransactionRow extends QueryResultRow {
  id: string | number;
  user_id: string | number;
  transaction_type: NormalizedTransactionType;
  amount: string | number;
  merchant: string | null;
  merchant_normalized: string | null;
  category: string | null;
  transaction_date: string | Date;
  source: string | null;
  bank: string | null;
  payment_type: string | null;
  raw_payload: unknown;
  resolved: boolean | null;
}

interface InsertedTransactionRow extends QueryResultRow {
  id: string | number;
}

interface InsertedImportRow extends QueryResultRow {
  id: string | number;
}

interface TransactionRow extends QueryResultRow {
  id: string | number;
  user_id: string | number;
  amount: string | number;
  merchant: string | null;
  merchant_normalized: string | null;
  category: string | null;
  status: string | null;
}

interface BudgetCategoryRow extends QueryResultRow {
  id: string | number;
  category: string;
  parent_category: string | null;
}

interface CategoryOption {
  budgetId: string | null;
  label: string;
  category: string;
}

interface ExistingCategoryRow extends QueryResultRow {
  category: string;
}

interface ValidatedEmailReview {
  userId: string;
  candidate: EmailReviewTransactionCandidateDto & {
    source: 'email';
    transactionType: NormalizedTransactionType;
    amount: number;
    merchant: string;
    merchantNormalized: string;
    transactionDate: string;
    rawPayload: Record<string, unknown>;
  };
  resolution: EmailReviewResolutionDto & {
    category: string;
    confidence: number;
  };
}

interface TransactionHandleStateStore {
  upsertState?(request: {
    userId: string | number;
    stateName: TransactionHandleStateName;
    stateData?: unknown;
    expiresAt?: string | null;
  }): Promise<unknown>;
  resetState(request: { userId: string | number }): Promise<unknown>;
}

interface ParsedTransactionCallback {
  action: TransactionCallbackHandleAction;
  transactionId?: number;
  budgetId?: number;
  error?: string;
}

@Injectable()
export class TransactionService {
  private readonly emailParsers: EmailTransactionParser[] =
    buildEmailParserRegistry();

  constructor(private readonly database: DatabaseService) {}

  placeholderStatus() {
    return {
      implemented: false,
      nextStep:
        'Move transaction parsing and validation here before Telegram trigger removal.',
    };
  }

  async normalizeTransaction(
    request: NormalizeTransactionRequestDto,
  ): Promise<NormalizeTransactionResponseDto> {
    const warnings: string[] = [];
    const userId = this.cleanString(request.userId);
    const transactionType = this.normalizeTransactionType(
      request.transactionType,
      request.rawPayload,
      warnings,
    );
    const amount = this.normalizeAmount(request.amount);
    const merchant = this.cleanString(request.merchant);
    const providedCategory = this.cleanString(request.category);
    const source = this.cleanString(request.source) ?? 'manual';
    const notes = this.cleanString(request.notes ?? undefined) ?? null;
    const transactionDate = this.normalizeTransactionDate(
      request.transactionDate,
    );

    if (!userId) {
      throw new BadRequestException('userId is required');
    }

    if (amount <= 0) {
      throw new BadRequestException('amount must be positive');
    }

    if (
      (transactionType === 'expense' || transactionType === 'income') &&
      !merchant
    ) {
      throw new BadRequestException(
        'merchant is required for expense and income',
      );
    }

    const merchantNormalized = merchant
      ? await this.resolveMerchantNormalized(merchant)
      : (merchant ?? '');
    const category =
      providedCategory ??
      (merchant
        ? await this.resolveCategory(merchantNormalized, merchant)
        : null);

    return {
      userId,
      transactionType,
      amount,
      merchant: merchant ?? '',
      merchantNormalized,
      category,
      transactionDate,
      source,
      notes,
      confidence: this.calculateConfidence({
        merchant,
        merchantNormalized,
        category,
        warnings,
      }),
      warnings,
    };
  }

  async handleManualTransaction(
    request: TransactionHandleRequestDto,
    stateStore?: TransactionHandleStateStore,
  ): Promise<TransactionHandleResponseDto> {
    const source = this.normalizeSource(request.source);

    if (source !== 'manual') {
      return {
        status: 'unsupported_source',
        transactionId: null,
        message: `Transaction source ${source ?? 'unknown'} is not supported yet.`,
      };
    }

    if (this.isResetText(request.text)) {
      await this.resetConversationState(request.userId, stateStore);
      return {
        status: 'cancelled',
        transactionId: null,
        message: 'Transaction recording cancelled.',
      };
    }

    const llmResult = this.requireLlmResult(request.llmResult);
    const missingField = this.firstMissingLlmField(llmResult);

    if (missingField) {
      const pendingPayload = this.buildPendingTransactionPayload(
        llmResult,
        missingField,
      );
      await stateStore?.upsertState?.({
        userId: request.userId,
        stateName: 'record_transaction_state',
        stateData: pendingPayload,
      });

      return {
        status: 'awaiting_missing_field',
        transactionId: null,
        message: this.buildTransactionFollowUpQuestion(missingField),
        state: {
          nextState: 'record_transaction_state',
          payload: pendingPayload,
        },
      };
    }

    this.requireHandleMerchant(llmResult.merchant);
    const confidence = this.normalizeConfidence(llmResult.confidence);
    const normalized = await this.normalizeTransaction({
      userId: String(request.userId ?? ''),
      transactionType: llmResult.transaction_type ?? '',
      amount: llmResult.amount ?? 0,
      merchant: llmResult.merchant ?? '',
      category: llmResult.category ?? undefined,
      transactionDate: llmResult.transaction_date ?? undefined,
      source,
      notes: llmResult.notes ?? null,
      rawPayload: llmResult,
    });

    if (!normalized.category) {
      throw new BadRequestException('category is required');
    }

    const status = this.statusFromConfidence(confidence);
    const savedTransaction = await this.saveTransaction({
      normalized: {
        ...normalized,
        confidence,
        category: normalized.category,
      },
      status,
      confidence,
      rawPayload: {
        text: request.text ?? null,
        source,
        telegramUserId: request.telegramUserId ?? null,
        llmResult,
      },
    });
    await this.resetConversationState(request.userId, stateStore);

    return this.buildHandleResponse(savedTransaction);
  }

  async handleEmailTransaction(
    request: EmailTransactionHandleRequestDto,
  ): Promise<EmailTransactionHandleResponseDto> {
    const validated = this.validateEmailTransactionRequest(request);
    const existingImport = await this.findTransactionImport(
      validated.userId,
      validated.email.messageId,
    );

    if (existingImport) {
      return this.buildEmailResponse({
        status: 'duplicate',
        provider: null,
        templateKey: null,
        reason: 'email message already imported',
      });
    }

    const parserInput = this.buildEmailParserInput(validated);
    const parser = this.findEmailParser(parserInput);
    const provider = parser?.provider ?? this.detectEmailProvider(parserInput);

    if (!provider) {
      return this.recordUnconfirmedEmailAttempt({
        request: validated,
        status: 'unsupported_provider',
        provider: null,
        templateKey: null,
        reason: 'email sender or body is not a supported provider',
        parsed: undefined,
      });
    }

    if (!parser) {
      return this.recordUnconfirmedEmailAttempt({
        request: validated,
        status: 'unsupported_template',
        provider,
        templateKey: null,
        reason: `${provider} email template is not supported`,
        parsed: undefined,
      });
    }

    let parsed: ParsedEmailTransactionDto;

    try {
      parsed = parser.parse(parserInput);
    } catch (error) {
      return this.recordUnconfirmedEmailAttempt({
        request: validated,
        status: 'parse_failed',
        provider: parser.provider,
        templateKey: parser.templateKey,
        reason: error instanceof Error ? error.message : 'email parse failed',
        parsed: undefined,
      });
    }

    const parsedValidationReason = this.emailParsedValidationReason(parsed);

    if (parsedValidationReason) {
      return this.recordUnconfirmedEmailAttempt({
        request: validated,
        status:
          parsedValidationReason === 'email is not a transaction'
            ? 'ignored_non_transaction'
            : 'parse_failed',
        provider: parsed.provider,
        templateKey: parsed.templateKey,
        reason: parsedValidationReason,
        parsed,
      });
    }

    const merchant = this.cleanString(parsed.merchant ?? undefined);

    if (!merchant || this.isUnknownMerchant(merchant)) {
      return this.recordUnconfirmedEmailAttempt({
        request: validated,
        status: 'needs_review',
        provider: parsed.provider,
        templateKey: parsed.templateKey,
        reason: 'merchant could not be resolved',
        parsed,
      });
    }

    const merchantAlias = await this.findMerchantAliasCanonicalName(merchant);

    if (!merchantAlias) {
      return this.recordUnconfirmedEmailAttempt({
        request: validated,
        status: 'needs_review',
        provider: parsed.provider,
        templateKey: parsed.templateKey,
        reason: 'merchant alias could not be resolved',
        parsed,
      });
    }

    const merchantNormalized = merchantAlias;
    const category = await this.resolveEmailCategory({
      userId: validated.userId,
      merchant,
      merchantNormalized,
      templateKey: parsed.templateKey,
    });

    if (!category) {
      return this.recordUnconfirmedEmailAttempt({
        request: validated,
        status: 'needs_review',
        provider: parsed.provider,
        templateKey: parsed.templateKey,
        reason: 'category could not be resolved',
        parsed,
      });
    }

    const rawPayload = this.buildEmailRawPayload(validated, parsed);
    const transactionDate = this.normalizeTransactionDate(
      parsed.transactionDate ?? validated.email.date,
    );
    const transaction = await this.saveConfirmedEmailTransaction({
      request: validated,
      parsed,
      merchant,
      merchantNormalized,
      category,
      transactionDate,
      rawPayload,
    });

    if (!transaction) {
      return this.buildEmailResponse({
        status: 'duplicate',
        provider: parsed.provider,
        templateKey: parsed.templateKey,
        reason: 'email message already imported',
        parsed,
      });
    }

    return this.buildEmailResponse({
      status: 'confirmed',
      provider: parsed.provider,
      templateKey: parsed.templateKey,
      reason: null,
      parsed,
      transaction,
    });
  }

  async resolveEmailTransactionReview(
    request: EmailTransactionResolveReviewRequestDto,
  ): Promise<EmailTransactionResolveReviewResponseDto> {
    const telegramUserId = this.cleanString(request.telegramUserId);

    if (!telegramUserId) {
      throw new BadRequestException('telegramUserId is required');
    }

    const user = await this.findTelegramUserByTelegramId(telegramUserId);

    if (!user) {
      return {
        status: 'needs_review',
        reason: 'user_not_found',
        message: 'Telegram user was not found.',
        transactionCandidate: request.transactionCandidate,
        resolution: request.resolution,
      };
    }

    const validated = this.validateEmailReviewRequest(request, String(user.id));
    const category = await this.findExistingBudgetCategory(
      validated.userId,
      validated.resolution.category,
    );

    if (!category) {
      return {
        status: 'needs_review',
        reason: 'category_not_found',
        message: 'Category was not found in user budgets.',
        transactionCandidate: request.transactionCandidate,
        resolution: request.resolution,
      };
    }

    if (validated.resolution.confidence < 75) {
      return {
        status: 'needs_review',
        reason: 'low_confidence',
        transactionCandidate: request.transactionCandidate,
        resolution: {
          ...request.resolution,
          confidence: validated.resolution.confidence,
        },
        telegramText: this.buildEmailReviewTelegramText({
          status: 'needs_review',
          amount: validated.candidate.amount,
          merchant: validated.candidate.merchantNormalized,
          category,
          reason: 'low confidence',
        }),
      };
    }

    const transactionStatus =
      validated.resolution.confidence >= 85 ? 'confirmed' : 'pending';
    const transaction = await this.saveEmailReviewTransaction({
      userId: validated.userId,
      candidate: {
        ...validated.candidate,
        category,
      },
      status: transactionStatus,
      confidence: validated.resolution.confidence,
    });

    if (transactionStatus === 'confirmed') {
      try {
        await this.upsertHighConfidenceEmailReviewLearning({
          userId: validated.userId,
          merchant: validated.candidate.merchant,
          merchantNormalized: validated.candidate.merchantNormalized,
          category,
        });
      } catch {
        // Alias/rule learning is intentionally best-effort for this endpoint.
      }
    }

    const telegramText = this.buildEmailReviewTelegramText({
      status: transactionStatus,
      amount: transaction.amount,
      merchant: transaction.merchantNormalized,
      category: transaction.category,
    });

    if (transactionStatus === 'confirmed') {
      return {
        status: 'confirmed',
        transaction,
        telegramText,
      };
    }

    return {
      status: 'pending',
      transaction,
      telegramText,
      actions: this.buildEmailReviewActions(transaction.id),
    };
  }

  private async findTelegramUserByTelegramId(
    telegramUserId: string,
  ): Promise<TelegramUserRow | undefined> {
    const result = await this.database.query<TelegramUserRow>(
      `
        SELECT id, telegram_id
        FROM telegram_users
        WHERE telegram_id::text = $1
        LIMIT 1
      `,
      [telegramUserId],
    );

    return result.rows[0];
  }

  private validateEmailReviewRequest(
    request: EmailTransactionResolveReviewRequestDto,
    userId: string,
  ): ValidatedEmailReview {
    const candidate = request.transactionCandidate;
    const resolution = request.resolution;

    if (!candidate || typeof candidate !== 'object') {
      throw new BadRequestException('transactionCandidate is required');
    }

    if (!resolution || typeof resolution !== 'object') {
      throw new BadRequestException('resolution is required');
    }

    const source = this.cleanString(candidate.source)?.toLowerCase();

    if (source !== 'email') {
      throw new BadRequestException('transactionCandidate.source must be email');
    }

    const amount = this.normalizeAmount(candidate.amount);

    if (amount <= 0) {
      throw new BadRequestException('amount must be positive');
    }

    const warnings: string[] = [];
    const transactionType = this.normalizeTransactionType(
      candidate.transactionType,
      candidate.rawPayload,
      warnings,
    );
    const merchant =
      this.cleanString(candidate.merchant) ??
      this.cleanString(candidate.merchantNormalized) ??
      'Unknown';
    const merchantNormalized =
      this.cleanString(candidate.merchantNormalized) ?? merchant;
    const category = this.cleanString(resolution.category);

    if (!category) {
      throw new BadRequestException('resolution.category is required');
    }

    return {
      userId,
      candidate: {
        ...candidate,
        source: 'email',
        transactionType,
        amount,
        merchant,
        merchantNormalized,
        transactionDate: this.normalizeTransactionDate(
          candidate.transactionDate,
        ),
        rawPayload: candidate.rawPayload ?? {},
      },
      resolution: {
        ...resolution,
        category,
        confidence: this.normalizeConfidence(resolution.confidence),
      },
    };
  }

  private async saveEmailReviewTransaction(input: {
    userId: string;
    candidate: ValidatedEmailReview['candidate'] & { category: string };
    status: 'confirmed' | 'pending';
    confidence: number;
  }): Promise<
    NonNullable<EmailTransactionResolveReviewResponseDto['transaction']>
  > {
    const result = await this.database.query<InsertedTransactionRow>(
      `
        INSERT INTO transactions (
          user_id,
          transaction_type,
          amount,
          merchant,
          merchant_normalized,
          category,
          transaction_date,
          source,
          notes,
          status,
          confidence,
          raw_payload
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'email', $8, $9, $10, $11)
        RETURNING id
      `,
      [
        input.userId,
        input.candidate.transactionType,
        input.candidate.amount,
        input.candidate.merchant,
        input.candidate.merchantNormalized,
        input.candidate.category,
        input.candidate.transactionDate,
        this.cleanString(input.candidate.description) ?? null,
        input.status,
        input.confidence,
        input.candidate.rawPayload,
      ],
    );
    const insertedId = result.rows[0]?.id;

    if (insertedId === undefined) {
      throw new BadRequestException('transaction insert failed');
    }

    return {
      id: String(insertedId),
      userId: input.userId,
      transactionType: input.candidate.transactionType,
      amount: input.candidate.amount,
      merchant: input.candidate.merchant,
      merchantNormalized: input.candidate.merchantNormalized,
      category: input.candidate.category,
      transactionDate: input.candidate.transactionDate,
      source: 'email',
      status: input.status,
      confidence: input.confidence,
    };
  }

  private async upsertHighConfidenceEmailReviewLearning(input: {
    userId: string;
    merchant: string;
    merchantNormalized: string;
    category: string;
  }): Promise<void> {
    await this.upsertMerchantAlias({
      userId: input.userId,
      aliasName: input.merchant,
      canonicalName: input.merchantNormalized,
    });
    await this.upsertCategoryRule({
      userId: input.userId,
      merchantPattern: input.merchantNormalized,
      category: input.category,
    });
  }

  private async upsertMerchantAlias(input: {
    userId: string;
    aliasName: string;
    canonicalName: string;
  }): Promise<void> {
    if (!input.aliasName || !input.canonicalName) {
      return;
    }

    const existing = await this.database.query<MerchantAliasRow>(
      `
        SELECT id, canonical_name
        FROM merchant_aliases
        WHERE user_id::text = $1
          AND lower(alias_name) = lower($2)
        LIMIT 1
      `,
      [input.userId, input.aliasName],
    );
    const row = existing.rows[0];

    if (row) {
      if (row.canonical_name !== input.canonicalName) {
        await this.database.query(
          `
            UPDATE merchant_aliases
            SET canonical_name = $1
            WHERE id::text = $2
          `,
          [input.canonicalName, String(row.id)],
        );
      }

      return;
    }

    await this.database.query(
      `
        INSERT INTO merchant_aliases (user_id, alias_name, canonical_name)
        VALUES ($1, $2, $3)
      `,
      [input.userId, input.aliasName, input.canonicalName],
    );
  }

  private async upsertCategoryRule(input: {
    userId: string;
    merchantPattern: string;
    category: string;
  }): Promise<void> {
    if (!input.merchantPattern || !input.category) {
      return;
    }

    const existing = await this.database.query<CategoryRuleRow>(
      `
        SELECT id, category
        FROM category_rules
        WHERE user_id::text = $1
          AND lower(merchant_pattern) = lower($2)
        LIMIT 1
      `,
      [input.userId, input.merchantPattern],
    );
    const row = existing.rows[0];

    if (row) {
      if (row.category !== input.category) {
        await this.database.query(
          `
            UPDATE category_rules
            SET category = $1
            WHERE id::text = $2
          `,
          [input.category, String(row.id)],
        );
      }

      return;
    }

    await this.database.query(
      `
        INSERT INTO category_rules (user_id, merchant_pattern, category)
        VALUES ($1, $2, $3)
      `,
      [input.userId, input.merchantPattern, input.category],
    );
  }

  private buildEmailReviewTelegramText(input: {
    status: 'confirmed' | 'pending' | 'needs_review';
    amount: number;
    merchant: string;
    category: string;
    reason?: string;
  }): string {
    if (input.status === 'confirmed') {
      return this.formatConfirmationHtml([
        'Transaction recorded',
        '',
        `Amount: ${this.formatCurrency(input.amount)}`,
        `Merchant: ${input.merchant}`,
        `Category: ${input.category}`,
        'Source: Email',
      ]);
    }

    const lines = [
      input.status === 'pending'
        ? 'Confirm transaction'
        : 'Email transaction needs attention',
      '',
      `Amount: ${this.formatCurrency(input.amount)}`,
      `Merchant: ${input.merchant}`,
      `Category: ${input.category}`,
    ];

    if (input.reason) {
      lines.push(`Reason: ${input.reason}`);
    }

    return this.formatConfirmationHtml(lines);
  }

  private buildEmailReviewActions(transactionId: string): NonNullable<
    EmailTransactionResolveReviewResponseDto['actions']
  > {
    return {
      confirm: {
        action: 'save_transaction',
        transactionId,
      },
      cancel: {
        action: 'cancel_transaction',
        transactionId,
      },
      changeCategory: {
        action: 'change_categories',
        transactionId,
      },
    };
  }

  private validateEmailTransactionRequest(
    request: EmailTransactionHandleRequestDto,
  ): EmailTransactionHandleRequestDto & {
    userId: string;
    source: 'email';
  } {
    const telegramUserId = this.cleanString(request.telegramUserId);
    const userId = this.cleanString(String(request.userId ?? ''));
    const source = this.cleanString(request.source)?.toLowerCase();
    const email = request.email;

    if (!telegramUserId) {
      throw new BadRequestException('telegramUserId is required');
    }

    if (!userId) {
      throw new BadRequestException('userId is required');
    }

    if (source !== 'email') {
      throw new BadRequestException('source must be email');
    }

    if (!email || typeof email !== 'object') {
      throw new BadRequestException('email is required');
    }

    const messageId = this.cleanString(email.messageId);
    const from = this.cleanString(email.from);
    const subject = this.cleanString(email.subject);
    const emailText = this.cleanString(email.emailText);

    if (!messageId) {
      throw new BadRequestException('email.messageId is required');
    }

    if (!from) {
      throw new BadRequestException('email.from is required');
    }

    if (!subject) {
      throw new BadRequestException('email.subject is required');
    }

    if (!emailText) {
      throw new BadRequestException('email.emailText is required');
    }

    if (email.date && Number.isNaN(new Date(email.date).getTime())) {
      throw new BadRequestException('email.date must be a valid date');
    }

    return {
      telegramUserId,
      userId,
      source: 'email',
      email: {
        messageId,
        threadId: this.cleanString(email.threadId),
        from,
        subject,
        date: this.cleanString(email.date),
        emailText,
        emailHtml: this.cleanString(email.emailHtml),
      },
    };
  }

  private buildEmailParserInput(
    request: EmailTransactionHandleRequestDto,
  ): EmailParserInput {
    const text = request.email.emailText;

    return {
      email: request.email,
      text,
      normalizedText: normalizeEmailWhitespace(text),
    };
  }

  private findEmailParser(
    input: EmailParserInput,
  ): EmailTransactionParser | undefined {
    return this.emailParsers.find((parser) => parser.canParse(input));
  }

  private detectEmailProvider(input: EmailParserInput): string | null {
    const combined = `${input.email.from} ${input.email.subject} ${input.normalizedText}`;

    if (/\bbca\b|klikbca|bank central asia/i.test(combined)) {
      return 'BCA';
    }

    if (/\bmandiri\b/i.test(combined)) {
      return 'Mandiri';
    }

    if (/\bkrom\b/i.test(combined)) {
      return 'Krom';
    }

    return null;
  }

  private emailParsedValidationReason(
    parsed: ParsedEmailTransactionDto,
  ): string | null {
    if (!parsed.isTransaction) {
      return 'email is not a transaction';
    }

    if (!parsed.emailId) {
      return 'email id is required';
    }

    if (!parsed.amount || parsed.amount <= 0) {
      return 'amount must exist and be positive';
    }

    if (
      parsed.type !== 'expense' &&
      parsed.type !== 'income' &&
      parsed.type !== 'transfer' &&
      parsed.type !== 'reversal'
    ) {
      return 'transaction type is unsupported';
    }

    if (
      !Number.isInteger(parsed.confidence) ||
      parsed.confidence < 0 ||
      parsed.confidence > 100
    ) {
      return 'confidence must be an integer from 0 to 100';
    }

    return null;
  }

  private isUnknownMerchant(merchant: string): boolean {
    const normalized = merchant.trim().toLowerCase();

    return normalized === 'unknown';
  }

  private async recordUnconfirmedEmailAttempt(input: {
    request: EmailTransactionHandleRequestDto & {
      userId: string;
      source: 'email';
    };
    status: Exclude<EmailTransactionHandleStatus, 'confirmed' | 'duplicate'>;
    provider: string | null;
    templateKey: string | null;
    reason: string;
    parsed: ParsedEmailTransactionDto | undefined;
  }): Promise<EmailTransactionHandleResponseDto> {
    const inserted = await this.createTransactionImport({
      userId: input.request.userId,
      sourceReference: input.request.email.messageId,
      status: input.status,
      rawPayload: this.buildEmailRawPayload(input.request, input.parsed),
    });

    if (!inserted) {
      return this.buildEmailResponse({
        status: 'duplicate',
        provider: input.provider,
        templateKey: input.templateKey,
        reason: 'email message already imported',
        parsed: input.parsed,
      });
    }

    await this.logEmailParseAttempt({
      request: input.request,
      status: input.status,
      provider: input.provider,
      templateKey: input.templateKey,
      parsed: input.parsed,
      errorReason: input.reason,
    });

    return this.buildEmailResponse({
      status: input.status,
      provider: input.provider,
      templateKey: input.templateKey,
      reason: input.reason,
      parsed: input.parsed,
    });
  }

  private async findTransactionImport(
    userId: string,
    sourceReference: string,
  ): Promise<ExistingImportRow | undefined> {
    const result = await this.database.query<ExistingImportRow>(
      `
        SELECT id, transaction_id, status
        FROM transaction_imports
        WHERE user_id::text = $1
          AND source = 'email'
          AND source_reference = $2
        LIMIT 1
      `,
      [userId, sourceReference],
    );

    return result.rows[0];
  }

  private async createTransactionImport(input: {
    userId: string;
    sourceReference: string;
    status: EmailTransactionHandleStatus | 'processing';
    rawPayload: unknown;
  }): Promise<string | null> {
    const result = await this.database.query<InsertedImportRow>(
      `
        INSERT INTO transaction_imports (
          user_id,
          source,
          source_reference,
          status,
          raw_payload
        )
        VALUES ($1, 'email', $2, $3, $4)
        ON CONFLICT (user_id, source, source_reference) DO NOTHING
        RETURNING id
      `,
      [input.userId, input.sourceReference, input.status, input.rawPayload],
    );
    const id = result.rows[0]?.id;

    return id === undefined ? null : String(id);
  }

  private async logEmailParseAttempt(input: {
    request: EmailTransactionHandleRequestDto & {
      userId: string;
      source: 'email';
    };
    status: Exclude<EmailTransactionHandleStatus, 'duplicate'>;
    provider: string | null;
    templateKey: string | null;
    parsed: ParsedEmailTransactionDto | undefined;
    errorReason: string | null;
  }): Promise<void> {
    await this.database.query(
      `
        INSERT INTO email_parse_attempts (
          user_id,
          source_reference,
          provider,
          template_key,
          status,
          sender,
          subject,
          email_date,
          parsed_payload,
          error_reason,
          body_sample
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9, $10, $11)
        ON CONFLICT (user_id, source_reference) DO UPDATE SET
          provider = EXCLUDED.provider,
          template_key = EXCLUDED.template_key,
          status = EXCLUDED.status,
          sender = EXCLUDED.sender,
          subject = EXCLUDED.subject,
          email_date = EXCLUDED.email_date,
          parsed_payload = EXCLUDED.parsed_payload,
          error_reason = EXCLUDED.error_reason,
          body_sample = EXCLUDED.body_sample
      `,
      [
        input.request.userId,
        input.request.email.messageId,
        input.provider,
        input.templateKey,
        input.status,
        input.request.email.from,
        input.request.email.subject,
        input.request.email.date ?? null,
        input.parsed ?? null,
        input.errorReason,
        this.safeEmailBodySample(input.request.email.emailText),
      ],
    );
  }

  private safeEmailBodySample(value: string): string {
    return normalizeEmailWhitespace(value).slice(0, 1000);
  }

  private buildEmailRawPayload(
    request: EmailTransactionHandleRequestDto,
    parsed: ParsedEmailTransactionDto | undefined,
  ): Record<string, unknown> {
    return {
      email: {
        messageId: request.email.messageId,
        threadId: request.email.threadId ?? null,
        from: request.email.from,
        subject: request.email.subject,
        date: request.email.date ?? null,
      },
      parser: parsed
        ? {
            provider: parsed.provider,
            templateKey: parsed.templateKey,
            confidence: parsed.confidence,
          }
        : null,
      parsed: parsed ?? null,
    };
  }

  private async resolveEmailCategory(input: {
    userId: string;
    merchant: string;
    merchantNormalized: string;
    templateKey: string;
  }): Promise<string | null> {
    const result = await this.database.query<CategoryRuleRow>(
      `
        SELECT category
        FROM category_rules
        WHERE user_id::text = $1
          AND (
            lower($2) LIKE '%' || lower(merchant_pattern) || '%'
            OR lower($3) LIKE '%' || lower(merchant_pattern) || '%'
            OR lower(merchant_pattern) = lower($2)
            OR lower(merchant_pattern) = lower($3)
          )
        ORDER BY priority DESC NULLS LAST
        LIMIT 1
      `,
      [input.userId, input.merchantNormalized, input.merchant],
    );
    const ruleCategory = result.rows[0]?.category;

    if (ruleCategory) {
      return ruleCategory;
    }

    const fallbackCategory = this.emailFallbackCategory(input.templateKey);

    if (!fallbackCategory) {
      return null;
    }

    return this.findExistingBudgetCategory(input.userId, fallbackCategory);
  }

  private emailFallbackCategory(templateKey: string): string | null {
    if (templateKey === 'mandiri-emoney-topup') {
      return 'E-Money';
    }

    if (templateKey === 'krom-incoming-transfer') {
      return 'Income';
    }

    if (templateKey === 'krom-outgoing-transfer') {
      return 'Transfer';
    }

    return null;
  }

  private async findExistingBudgetCategory(
    userId: string,
    category: string,
  ): Promise<string | null> {
    const result = await this.database.query<ExistingCategoryRow>(
      `
        SELECT category
        FROM budgets
        WHERE user_id::text = $1
          AND lower(category) = lower($2)
          AND COALESCE(is_active, true) = true
        LIMIT 1
      `,
      [userId, category],
    );

    return result.rows[0]?.category ?? null;
  }

  private async saveConfirmedEmailTransaction(input: {
    request: EmailTransactionHandleRequestDto & {
      userId: string;
      source: 'email';
    };
    parsed: ParsedEmailTransactionDto;
    merchant: string;
    merchantNormalized: string;
    category: string;
    transactionDate: string;
    rawPayload: Record<string, unknown>;
  }): Promise<EmailTransactionHandleResponseDto['transaction'] | null> {
    return this.database.withTransaction(async (client) => {
      const importResult = await client.query<InsertedImportRow>(
        `
          INSERT INTO transaction_imports (
            user_id,
            source,
            source_reference,
            status,
            raw_payload
          )
          VALUES ($1, 'email', $2, 'processing', $3)
          ON CONFLICT (user_id, source, source_reference) DO NOTHING
          RETURNING id
        `,
        [input.request.userId, input.request.email.messageId, input.rawPayload],
      );
      const importId = importResult.rows[0]?.id;

      if (importId === undefined) {
        return null;
      }

      const transactionResult = await client.query<InsertedTransactionRow>(
        `
          INSERT INTO transactions (
            user_id,
            transaction_type,
            amount,
            merchant,
            merchant_normalized,
            category,
            transaction_date,
            source,
            status,
            confidence,
            raw_payload
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, 'email', 'confirmed', $8, $9)
          RETURNING id
        `,
        [
          input.request.userId,
          input.parsed.type,
          input.parsed.amount,
          input.merchant,
          input.merchantNormalized,
          input.category,
          input.transactionDate,
          input.parsed.confidence,
          input.rawPayload,
        ],
      );
      const transactionId = transactionResult.rows[0]?.id;

      if (transactionId === undefined) {
        throw new BadRequestException('transaction insert failed');
      }

      await client.query(
        `
          UPDATE transaction_imports
          SET transaction_id = $1,
              status = 'confirmed',
              raw_payload = $2
          WHERE id::text = $3
        `,
        [transactionId, input.rawPayload, String(importId)],
      );

      await client.query(
        `
          INSERT INTO email_parse_attempts (
            user_id,
            source_reference,
            provider,
            template_key,
            status,
            sender,
            subject,
            email_date,
            parsed_payload,
            error_reason,
            body_sample
          )
          VALUES ($1, $2, $3, $4, 'confirmed', $5, $6, $7::timestamptz, $8, NULL, $9)
          ON CONFLICT (user_id, source_reference) DO UPDATE SET
            provider = EXCLUDED.provider,
            template_key = EXCLUDED.template_key,
            status = EXCLUDED.status,
            sender = EXCLUDED.sender,
            subject = EXCLUDED.subject,
            email_date = EXCLUDED.email_date,
            parsed_payload = EXCLUDED.parsed_payload,
            error_reason = EXCLUDED.error_reason,
            body_sample = EXCLUDED.body_sample
        `,
        [
          input.request.userId,
          input.request.email.messageId,
          input.parsed.provider,
          input.parsed.templateKey,
          input.request.email.from,
          input.request.email.subject,
          input.request.email.date ?? null,
          input.parsed,
          this.safeEmailBodySample(input.request.email.emailText),
        ],
      );

      return {
        id: String(transactionId),
        userId: input.request.userId,
        transactionType: input.parsed.type,
        amount: input.parsed.amount ?? 0,
        merchant: input.merchant,
        merchantNormalized: input.merchantNormalized,
        category: input.category,
        transactionDate: input.transactionDate,
        source: 'email',
        status: 'confirmed',
        confidence: input.parsed.confidence,
      };
    });
  }

  private buildEmailResponse(input: {
    status: EmailTransactionHandleStatus;
    provider: string | null;
    templateKey: string | null;
    reason: string | null;
    parsed?: ParsedEmailTransactionDto;
    transaction?: EmailTransactionHandleResponseDto['transaction'];
  }): EmailTransactionHandleResponseDto {
    return {
      status: input.status,
      provider: input.provider,
      templateKey: input.templateKey,
      reason: input.reason,
      transaction: input.transaction,
      parsed: input.parsed,
      telegram: {
        text: this.buildEmailTelegramText(input),
        parseMode: 'HTML',
      },
    };
  }

  private buildEmailTelegramText(input: {
    status: EmailTransactionHandleStatus;
    provider: string | null;
    templateKey: string | null;
    reason: string | null;
    parsed?: ParsedEmailTransactionDto;
    transaction?: EmailTransactionHandleResponseDto['transaction'];
  }): string {
    if (input.status === 'confirmed' && input.transaction) {
      return this.formatConfirmationHtml([
        'Transaction recorded',
        '',
        `Amount: ${this.formatCurrency(input.transaction.amount)}`,
        `Merchant: ${input.transaction.merchantNormalized}`,
        `Category: ${input.transaction.category}`,
        `Source: ${input.provider ?? 'Email'}`,
      ]);
    }

    const lines = [
      'Email transaction needs attention',
      '',
      `Status: ${input.status}`,
      `Provider: ${input.provider ?? '-'}`,
      `Template: ${input.templateKey ?? '-'}`,
    ];

    if (input.parsed?.amount) {
      lines.push(`Amount: ${this.formatCurrency(input.parsed.amount)}`);
    }

    if (input.parsed?.merchant) {
      lines.push(`Merchant: ${input.parsed.merchant}`);
    }

    if (input.reason) {
      lines.push(`Reason: ${input.reason}`);
    }

    return this.formatConfirmationHtml(lines);
  }

  buildConfirmationPayload(
    request: TransactionConfirmationPayloadRequestDto,
  ): TransactionConfirmationPayloadResponseDto {
    const warnings = [...(request.warnings ?? [])];
    const pendingTransactionId = this.cleanString(request.pendingTransactionId);
    const transactionId = this.cleanString(request.transactionId);
    const callbackMode = request.callbackMode ?? PRODUCTION_CALLBACK_MODE;
    const callbackTransactionId = this.resolveCallbackTransactionId({
      callbackMode,
      pendingTransactionId,
      transactionId,
    });
    const merchant =
      this.cleanString(request.merchantNormalized) ??
      this.cleanString(request.merchant) ??
      'Unknown';
    const category = this.cleanString(request.category) ?? 'Uncategorized';
    const wallet = this.cleanString(request.wallet) ?? EMPTY_CONFIRMATION_FIELD;
    const notes =
      this.cleanString(request.notes ?? undefined) ?? EMPTY_CONFIRMATION_FIELD;
    const amount = this.normalizeAmount(request.amount);
    const transactionType = request.transactionType;
    const source = this.cleanString(request.source) ?? 'manual';
    const format = request.format ?? (source === 'email' ? 'html' : 'plain');

    if (!callbackTransactionId) {
      warnings.push(
        callbackMode === EXPERIMENTAL_CALLBACK_MODE
          ? 'callbacks require pendingTransactionId'
          : 'callbacks require transactionId',
      );
    }

    const warningLines =
      warnings.length > 0
        ? ['', 'Warnings:', ...warnings.map((warning) => `- ${warning}`)]
        : [];

    const textLines = this.buildConfirmationTextLines({
      amount,
      category,
      merchant,
      notes,
      transactionType,
      wallet,
      warningLines,
    });
    const text =
      format === 'html'
        ? this.formatConfirmationHtml(textLines)
        : textLines.join('\n');

    return {
      text,
      parseMode: format === 'html' ? 'HTML' : null,
      replyMarkup: this.buildConfirmationReplyMarkup(
        callbackTransactionId,
        callbackMode,
      ),
      summary: {
        amount,
        merchant,
        category,
        wallet,
        notes,
      },
      warnings,
    };
  }

  async confirmTransaction(
    request: ConfirmTransactionRequestDto,
  ): Promise<ConfirmTransactionResponseDto> {
    return this.updateTransactionStatus(request, 'confirmed');
  }

  async cancelTransaction(
    request: ConfirmTransactionRequestDto,
  ): Promise<ConfirmTransactionResponseDto> {
    return this.updateTransactionStatus(request, 'rejected');
  }

  async handleTransactionCallback(
    request: TransactionCallbackHandleRequestDto,
  ): Promise<TransactionCallbackHandleResponseDto> {
    const userId = this.normalizePositiveInteger(request.userId);
    const telegramUserId = this.cleanString(request.telegramUserId);
    const parsed = this.parseTransactionCallbackData(request.callbackData);

    if (!telegramUserId) {
      return this.transactionCallbackError({
        action: parsed.action,
        text: 'Invalid callback request.',
        request,
        transactionId: parsed.transactionId,
      });
    }

    if (!userId) {
      return this.transactionCallbackError({
        action: parsed.action,
        text: 'Invalid callback user.',
        request,
        transactionId: parsed.transactionId,
      });
    }

    if (parsed.error) {
      return this.transactionCallbackError({
        action: parsed.action,
        text: parsed.error,
        request,
        transactionId: parsed.transactionId,
      });
    }

    if (parsed.action === 'save_transaction' && parsed.transactionId) {
      const result = await this.confirmTransaction({
        transactionId: String(parsed.transactionId),
        userId: String(userId),
      });

      if (
        result.status === 'confirmed' ||
        result.status === 'already_confirmed'
      ) {
        return this.transactionCallbackOk({
          action: parsed.action,
          text:
            result.editMessage?.text ??
            'This transaction was already confirmed.',
          request,
          transactionId: parsed.transactionId,
          replyMarkup: null,
        });
      }

      return this.transactionCallbackError({
        action: parsed.action,
        text: this.confirmTransactionStatusText(result.status),
        request,
        transactionId: parsed.transactionId,
      });
    }

    if (parsed.action === 'cancel_transaction' && parsed.transactionId) {
      const result = await this.cancelTransaction({
        transactionId: String(parsed.transactionId),
        userId: String(userId),
      });

      if (
        result.status === 'rejected' ||
        result.status === 'already_rejected'
      ) {
        return this.transactionCallbackOk({
          action: parsed.action,
          text:
            result.editMessage?.text ??
            'This transaction was already cancelled.',
          request,
          transactionId: parsed.transactionId,
          replyMarkup: null,
        });
      }

      return this.transactionCallbackError({
        action: parsed.action,
        text: this.confirmTransactionStatusText(result.status),
        request,
        transactionId: parsed.transactionId,
      });
    }

    if (parsed.action === 'change_categories' && parsed.transactionId) {
      const result = await this.buildCategoryOptions({
        transactionId: String(parsed.transactionId),
        userId: String(userId),
      });

      if (result.status === 'ok') {
        return this.transactionCallbackOk({
          action: parsed.action,
          text: result.text ?? 'Choose transaction category',
          request,
          transactionId: parsed.transactionId,
          replyMarkup: result.replyMarkup,
        });
      }

      return this.transactionCallbackError({
        action: parsed.action,
        text: this.categoryOptionsStatusText(result.status),
        request,
        transactionId: parsed.transactionId,
      });
    }

    if (parsed.action === 'catid' && parsed.transactionId && parsed.budgetId) {
      const result = await this.setPendingTransactionCategory({
        transactionId: String(parsed.transactionId),
        budgetId: String(parsed.budgetId),
        userId: String(userId),
      });

      if (result.status === 'updated') {
        return this.transactionCallbackOk({
          action: parsed.action,
          text:
            result.editMessage?.text ??
            'Transaction category updated and confirmed.',
          request,
          transactionId: parsed.transactionId,
          replyMarkup: null,
        });
      }

      return this.transactionCallbackError({
        action: parsed.action,
        text: this.setCategoryStatusText(result.status),
        request,
        transactionId: parsed.transactionId,
      });
    }

    return this.transactionCallbackError({
      action: parsed.action,
      text: 'Unsupported transaction callback.',
      request,
      transactionId: parsed.transactionId,
    });
  }

  async confirmPendingTransactionExperimental(request: {
    pendingTransactionId: string;
    userId: string;
  }): Promise<{
    status: 'confirmed' | 'not_found' | 'already_resolved';
    transactionId: string | null;
    pendingTransactionId: string;
    summary: ConfirmTransactionSummaryDto | null;
  }> {
    const pendingTransactionId = this.cleanString(request.pendingTransactionId);
    const userId = this.cleanString(request.userId);

    if (!pendingTransactionId) {
      throw new BadRequestException('pendingTransactionId is required');
    }

    if (!userId) {
      throw new BadRequestException('userId is required');
    }

    return this.database.withTransaction(async (client) => {
      const pendingResult = await client.query<PendingTransactionRow>(
        `
          SELECT
            id,
            user_id,
            transaction_type,
            amount,
            merchant,
            merchant_normalized,
            COALESCE(category_suggested, category) AS category,
            COALESCE(transaction_date, created_at) AS transaction_date,
            source,
            bank,
            payment_type,
            raw_payload,
            resolved
          FROM pending_transactions
          WHERE id::text = $1
            AND user_id::text = $2
          LIMIT 1
          FOR UPDATE
        `,
        [pendingTransactionId, userId],
      );
      const pendingTransaction = pendingResult.rows[0];

      if (!pendingTransaction) {
        return {
          status: 'not_found',
          transactionId: null,
          pendingTransactionId,
          summary: null,
        };
      }

      if (pendingTransaction.resolved) {
        return {
          status: 'already_resolved',
          transactionId: null,
          pendingTransactionId: String(pendingTransaction.id),
          summary: this.pendingTransactionSummary(pendingTransaction),
        };
      }

      const insertResult = await client.query<InsertedTransactionRow>(
        `
          INSERT INTO transactions (
            user_id,
            transaction_type,
            amount,
            merchant,
            merchant_normalized,
            category,
            transaction_date,
            source,
            bank,
            payment_type,
            raw_payload,
            status
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'confirmed')
          RETURNING id
        `,
        [
          pendingTransaction.user_id,
          pendingTransaction.transaction_type,
          this.normalizeAmount(pendingTransaction.amount),
          pendingTransaction.merchant,
          pendingTransaction.merchant_normalized,
          pendingTransaction.category,
          pendingTransaction.transaction_date,
          pendingTransaction.source,
          pendingTransaction.bank,
          pendingTransaction.payment_type,
          pendingTransaction.raw_payload,
        ],
      );
      const transactionId = insertResult.rows[0]?.id;

      await client.query(
        `
          UPDATE pending_transactions
          SET resolved = true
          WHERE id::text = $1
            AND user_id::text = $2
        `,
        [String(pendingTransaction.id), String(pendingTransaction.user_id)],
      );

      return {
        status: 'confirmed',
        transactionId:
          transactionId === undefined ? null : String(transactionId),
        pendingTransactionId: String(pendingTransaction.id),
        summary: this.pendingTransactionSummary(pendingTransaction),
      };
    });
  }

  async buildCategoryOptions(
    request: TransactionCategoryOptionsRequestDto,
  ): Promise<TransactionCategoryOptionsResponseDto> {
    const pendingTransactionId = this.cleanString(request.pendingTransactionId);
    const transactionId = this.cleanString(request.transactionId);
    const callbackMode = request.callbackMode ?? PRODUCTION_CALLBACK_MODE;
    const userId = this.cleanString(request.userId);

    if (!userId) {
      throw new BadRequestException('userId is required');
    }

    if (!pendingTransactionId && !transactionId) {
      throw new BadRequestException('transactionId is required');
    }

    const transaction = transactionId
      ? await this.findTransaction(transactionId, userId)
      : undefined;
    const pendingTransaction = pendingTransactionId
      ? await this.findPendingTransaction(pendingTransactionId, userId)
      : undefined;

    if (!transaction && !pendingTransaction) {
      return {
        status: 'not_found',
        pendingTransactionId: pendingTransactionId ?? '',
        text: null,
        replyMarkup: null,
      };
    }

    if (pendingTransaction?.resolved) {
      return {
        status: 'already_resolved',
        pendingTransactionId: String(pendingTransaction.id),
        text: null,
        replyMarkup: null,
      };
    }

    const categoryOptions =
      callbackMode === PRODUCTION_CALLBACK_MODE && transactionId
        ? await this.findCategoryOptions(userId)
        : this.defaultCategoryOptions();
    const source = transaction ?? pendingTransaction;

    return {
      status: 'ok',
      pendingTransactionId: pendingTransaction
        ? String(pendingTransaction.id)
        : (pendingTransactionId ?? ''),
      text: [
        'Choose transaction category',
        '',
        `Merchant: ${
          source?.merchant_normalized ?? source?.merchant ?? 'Unknown'
        }`,
        `Amount: ${this.formatCurrency(
          this.normalizeAmount(source?.amount ?? 0),
        )}`,
      ].join('\n'),
      replyMarkup: this.buildCategoryOptionsReplyMarkup(
        pendingTransaction ? String(pendingTransaction.id) : '',
        callbackMode,
        transactionId,
        categoryOptions,
      ),
    };
  }

  async setPendingTransactionCategory(
    request: TransactionSetCategoryRequestDto,
  ): Promise<TransactionSetCategoryResponseDto> {
    const pendingTransactionId = this.cleanString(request.pendingTransactionId);
    const transactionId = this.cleanString(request.transactionId);
    const budgetId = this.cleanString(request.budgetId);
    const userId = this.cleanString(request.userId);
    const category = this.normalizeCategoryOption(request.category);

    if (!userId) {
      throw new BadRequestException('userId is required');
    }

    if (transactionId || budgetId) {
      return this.setTransactionCategory({
        transactionId,
        budgetId,
        userId,
      });
    }

    if (!pendingTransactionId) {
      throw new BadRequestException('pendingTransactionId is required');
    }

    if (!category) {
      throw new BadRequestException('category must be a supported option');
    }

    const pendingTransaction = await this.findPendingTransaction(
      pendingTransactionId,
      userId,
    );

    if (!pendingTransaction) {
      return {
        status: 'not_found',
        pendingTransactionId,
        transactionId: null,
        confirmationPayload: null,
        summary: null,
        editMessage: null,
      };
    }

    if (pendingTransaction.resolved) {
      return {
        status: 'already_resolved',
        pendingTransactionId: String(pendingTransaction.id),
        transactionId: null,
        confirmationPayload: null,
        summary: this.pendingTransactionSummary(pendingTransaction),
        editMessage: null,
      };
    }

    await this.database.query(
      `
        UPDATE pending_transactions
        SET category_suggested = $1
        WHERE id::text = $2
          AND user_id::text = $3
      `,
      [
        category,
        String(pendingTransaction.id),
        String(pendingTransaction.user_id),
      ],
    );

    return {
      status: 'updated',
      pendingTransactionId: String(pendingTransaction.id),
      transactionId: null,
      confirmationPayload: this.buildConfirmationPayload({
        pendingTransactionId: String(pendingTransaction.id),
        userId: String(pendingTransaction.user_id),
        transactionType: pendingTransaction.transaction_type,
        amount: this.normalizeAmount(pendingTransaction.amount),
        merchant: pendingTransaction.merchant ?? 'Unknown',
        merchantNormalized: pendingTransaction.merchant_normalized ?? undefined,
        category,
        transactionDate:
          pendingTransaction.transaction_date instanceof Date
            ? pendingTransaction.transaction_date.toISOString()
            : pendingTransaction.transaction_date,
        source: pendingTransaction.source ?? 'manual',
      }),
      summary: this.pendingTransactionSummary({
        ...pendingTransaction,
        category,
      }),
      editMessage: null,
    };
  }

  normalizeTransactionType(
    value: string | undefined,
    rawPayload: unknown,
    warnings: string[],
  ): NormalizedTransactionType {
    const normalized = this.cleanString(value)?.toLowerCase();
    const rawText = JSON.stringify(rawPayload ?? {}).toLowerCase();
    const combined = `${normalized ?? ''} ${rawText}`;

    if (/\b(reversal|void|chargeback)\b/.test(combined)) {
      if (normalized && normalized !== 'reversal') {
        warnings.push(
          'transactionType mapped to reversal from reversal-like input',
        );
      }

      return 'reversal';
    }

    if (/\b(refund|cashback)\b/.test(combined)) {
      warnings.push('refund/cashback input mapped to income');
      return 'income';
    }

    if (
      normalized === 'expense' ||
      normalized === 'income' ||
      normalized === 'transfer' ||
      normalized === 'reversal'
    ) {
      return normalized;
    }

    throw new BadRequestException(
      'transactionType must be expense, income, transfer, or reversal',
    );
  }

  normalizeAmount(value: number | string): number {
    const normalized =
      typeof value === 'number'
        ? value
        : Number(this.normalizeAmountString(value));

    if (!Number.isFinite(normalized)) {
      return 0;
    }

    return Math.abs(normalized);
  }

  normalizeConfidence(value: number | undefined): number {
    if (value === undefined || value === null) {
      throw new BadRequestException('confidence is required');
    }

    const scaled = value >= 0 && value <= 1 ? value * 100 : value;
    const normalized = Math.round(scaled);

    if (!Number.isFinite(normalized) || normalized < 0 || normalized > 100) {
      throw new BadRequestException('confidence must be between 0 and 100');
    }

    return normalized;
  }

  private requireLlmResult(
    llmResult: TransactionHandleRequestDto['llmResult'],
  ): NonNullable<TransactionHandleRequestDto['llmResult']> {
    if (!llmResult) {
      throw new BadRequestException('llmResult is required');
    }

    return llmResult;
  }

  private firstMissingLlmField(
    llmResult: NonNullable<TransactionHandleRequestDto['llmResult']>,
  ): string | null {
    return this.cleanString(llmResult.missing_fields?.[0]) ?? null;
  }

  private buildPendingTransactionPayload(
    llmResult: NonNullable<TransactionHandleRequestDto['llmResult']>,
    missingField: string,
  ): NonNullable<TransactionHandleRequestDto['llmResult']> & {
    pending: true;
  } {
    return this.withoutUndefinedTransactionFields({
      transaction_type: llmResult.transaction_type,
      amount: llmResult.amount,
      merchant: llmResult.merchant,
      category: llmResult.category,
      confidence: llmResult.confidence,
      transaction_date: llmResult.transaction_date,
      notes: llmResult.notes,
      missing_fields: [missingField],
      pending: true as const,
    });
  }

  private buildTransactionFollowUpQuestion(missingField: string): string {
    if (missingField === 'amount') {
      return 'How much was the transaction?';
    }

    if (missingField === 'merchant') {
      return 'Where was the transaction?';
    }

    if (missingField === 'category') {
      return 'Which category should I use?';
    }

    if (missingField === 'transaction_type') {
      return 'Was this an expense, income, transfer, or reversal?';
    }

    if (missingField === 'transaction_date') {
      return 'When did this transaction happen?';
    }

    return `Please provide ${missingField}.`;
  }

  private withoutUndefinedTransactionFields<T extends Record<string, unknown>>(
    value: T,
  ): T {
    return Object.fromEntries(
      Object.entries(value).filter(
        ([, fieldValue]) => fieldValue !== undefined,
      ),
    ) as T;
  }

  private requireHandleMerchant(merchant: string | undefined): void {
    if (!this.cleanString(merchant)) {
      throw new BadRequestException('merchant is required');
    }
  }

  private statusFromConfidence(confidence: number): TransactionStatus {
    return confidence >= 90 ? 'confirmed' : 'pending';
  }

  private async saveTransaction(
    input: SaveTransactionInputDto,
  ): Promise<SavedTransactionDto> {
    if (!input.normalized.category) {
      throw new BadRequestException('category is required');
    }

    const result = await this.database.query<InsertedTransactionRow>(
      `
        INSERT INTO transactions (
          user_id,
          transaction_type,
          amount,
          merchant,
          merchant_normalized,
          category,
          transaction_date,
          source,
          notes,
          status,
          confidence,
          raw_payload
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'manual', $8, $9, $10, $11)
        RETURNING id
      `,
      [
        input.normalized.userId,
        input.normalized.transactionType,
        input.normalized.amount,
        input.normalized.merchant,
        input.normalized.merchantNormalized,
        input.normalized.category,
        input.normalized.transactionDate,
        input.normalized.notes,
        input.status,
        input.confidence,
        input.rawPayload,
      ],
    );

    const insertedId = result.rows[0]?.id;

    if (insertedId === undefined) {
      throw new BadRequestException('transaction insert failed');
    }

    return {
      id: String(insertedId),
      userId: input.normalized.userId,
      transactionType: input.normalized.transactionType,
      amount: input.normalized.amount,
      merchant: input.normalized.merchant,
      merchantNormalized: input.normalized.merchantNormalized,
      category: input.normalized.category,
      transactionDate: input.normalized.transactionDate,
      source: 'manual',
      notes: input.normalized.notes,
      status: input.status,
      confidence: input.confidence,
    };
  }

  private buildHandleResponse(
    transaction: SavedTransactionDto,
  ): TransactionHandleResponseDto {
    if (transaction.status === 'confirmed') {
      return {
        status: transaction.status,
        transactionId: transaction.id,
        message: `${String.fromCodePoint(0x2705)} Recorded: ${this.formatCurrency(
          transaction.amount,
        )} at ${this.titleCaseWords(
          transaction.merchantNormalized,
        )} under ${transaction.category}.`,
      };
    }

    const confirmationPayload = this.buildConfirmationPayload({
      transactionId: transaction.id,
      userId: transaction.userId,
      transactionType: transaction.transactionType,
      amount: transaction.amount,
      merchant: transaction.merchant,
      merchantNormalized: transaction.merchantNormalized,
      category: transaction.category,
      notes: transaction.notes,
      transactionDate: transaction.transactionDate,
      source: transaction.source,
      confidence: transaction.confidence,
    });

    return {
      status: transaction.status,
      transactionId: transaction.id,
      message: 'Please confirm this transaction.',
      confirmationPayload: {
        text: confirmationPayload.text,
        reply_markup: confirmationPayload.replyMarkup,
      },
    };
  }

  private normalizeAmountString(value: string): string {
    const cleaned = value.replace(/[^\d,.-]/g, '');
    const lastComma = cleaned.lastIndexOf(',');
    const lastDot = cleaned.lastIndexOf('.');

    if (lastComma >= 0 && lastDot >= 0) {
      const decimalSeparator = lastComma > lastDot ? ',' : '.';
      const thousandsSeparator = decimalSeparator === ',' ? '.' : ',';

      return cleaned
        .replace(new RegExp(`\\${thousandsSeparator}`, 'g'), '')
        .replace(decimalSeparator, '.');
    }

    if (lastComma >= 0 || lastDot >= 0) {
      const separator = lastComma >= 0 ? ',' : '.';
      const separatorIndex = lastComma >= 0 ? lastComma : lastDot;
      const fractionLength = cleaned.length - separatorIndex - 1;

      if (fractionLength === 3) {
        return cleaned.replace(new RegExp(`\\${separator}`, 'g'), '');
      }

      return cleaned.replace(separator, '.');
    }

    return cleaned;
  }

  private async resetConversationState(
    userId: string | number,
    stateStore: TransactionHandleStateStore | undefined,
  ): Promise<void> {
    if (!stateStore) {
      return;
    }

    await stateStore.resetState({ userId });
  }

  private isResetText(value: string | undefined): boolean {
    const text = value?.trim().toLowerCase();
    return Boolean(
      text &&
      ['reset', 'cancel', 'exit', 'stop', 'batal', 'keluar'].includes(text),
    );
  }

  private pendingTransactionSummary(
    pendingTransaction: PendingTransactionRow,
  ): {
    amount: number;
    merchant: string;
    category: string | null;
  } {
    return {
      amount: this.normalizeAmount(pendingTransaction.amount),
      merchant:
        pendingTransaction.merchant_normalized ??
        pendingTransaction.merchant ??
        'Unknown',
      category: pendingTransaction.category,
    };
  }

  private transactionSummary(
    transaction: TransactionRow,
  ): ConfirmTransactionSummaryDto {
    return {
      amount: this.normalizeAmount(transaction.amount),
      merchant:
        transaction.merchant_normalized ?? transaction.merchant ?? 'Unknown',
      category: transaction.category,
    };
  }

  private transactionEditMessage(
    transactionId: string,
    summary: ConfirmTransactionSummaryDto,
    nextStatus: 'confirmed' | 'rejected',
  ): ConfirmTransactionEditMessageDto {
    const text =
      nextStatus === 'confirmed'
        ? `Transaction ${transactionId} confirmed: ${summary.merchant} ${summary.amount}`
        : `Transaction ${transactionId} cancelled.`;

    return {
      text,
      parseMode: null,
    };
  }

  private async updateTransactionStatus(
    request: ConfirmTransactionRequestDto,
    nextStatus: 'confirmed' | 'rejected',
  ): Promise<ConfirmTransactionResponseDto> {
    const transactionId = this.cleanString(request.transactionId);
    const userId = this.cleanString(request.userId);

    if (!transactionId) {
      throw new BadRequestException('transactionId is required');
    }

    if (!userId) {
      throw new BadRequestException('userId is required');
    }

    const transaction = await this.findTransaction(transactionId, userId);

    if (!transaction) {
      return {
        status: 'not_found',
        transactionId,
        userId,
        summary: null,
        editMessage: null,
      };
    }

    const existingStatus = this.cleanString(transaction.status)?.toLowerCase();
    const summary = this.transactionSummary(transaction);

    if (existingStatus === 'confirmed') {
      return {
        status: 'already_confirmed',
        transactionId: String(transaction.id),
        userId: String(transaction.user_id),
        summary,
        editMessage: null,
      };
    }

    if (existingStatus === 'rejected') {
      return {
        status: 'already_rejected',
        transactionId: String(transaction.id),
        userId: String(transaction.user_id),
        summary,
        editMessage: null,
      };
    }

    await this.database.query(
      `
        UPDATE transactions
        SET status = $1,
            updated_at = now()
        WHERE id::text = $2
          AND user_id::text = $3
      `,
      [nextStatus, String(transaction.id), String(transaction.user_id)],
    );

    return {
      status: nextStatus,
      transactionId: String(transaction.id),
      userId: String(transaction.user_id),
      summary,
      editMessage: this.transactionEditMessage(
        String(transaction.id),
        summary,
        nextStatus,
      ),
    };
  }

  private async findTransaction(
    transactionId: string,
    userId: string,
  ): Promise<TransactionRow | undefined> {
    const result = await this.database.query<TransactionRow>(
      `
        SELECT
          id,
          user_id,
          amount,
          merchant,
          merchant_normalized,
          category,
          status
        FROM transactions
        WHERE id::text = $1
          AND user_id::text = $2
        LIMIT 1
      `,
      [transactionId, userId],
    );

    return result.rows[0];
  }

  private buildConfirmationReplyMarkup(
    transactionId: string | undefined,
    callbackMode: TransactionCallbackMode,
  ): TelegramReplyMarkupDto {
    if (!transactionId) {
      return { inline_keyboard: [] };
    }

    if (callbackMode === EXPERIMENTAL_CALLBACK_MODE) {
      return {
        inline_keyboard: [
          [
            {
              text: 'Approve',
              callback_data: `tx_confirm:${transactionId}`,
            },
            {
              text: 'Change Category',
              callback_data: `tx_category:${transactionId}`,
            },
          ],
          [
            {
              text: 'Reject',
              callback_data: `tx_reject:${transactionId}`,
            },
          ],
        ],
      };
    }

    return {
      inline_keyboard: [
        [
          {
            text: 'Approve',
            callback_data: this.saveTransactionCallbackData(transactionId),
          },
          {
            text: 'Change Category',
            callback_data: this.changeCategoriesCallbackData(transactionId),
          },
        ],
        [
          {
            text: 'Reject',
            callback_data: this.cancelTransactionCallbackData(transactionId),
          },
        ],
      ],
    };
  }

  private buildConfirmationTextLines(input: {
    transactionType: NormalizedTransactionType;
    amount: number;
    merchant: string;
    category: string;
    wallet: string;
    notes: string;
    warningLines: string[];
  }): string[] {
    return [
      'Confirm transaction',
      '',
      `Type: ${this.titleCase(input.transactionType)}`,
      `Amount: ${this.formatCurrency(input.amount)}`,
      `Merchant: ${input.merchant}`,
      `Category: ${input.category}`,
      `Wallet: ${input.wallet}`,
      `Notes: ${input.notes}`,
      ...input.warningLines,
    ];
  }

  private formatConfirmationHtml(lines: string[]): string {
    return lines
      .map((line, index) =>
        index === 0
          ? `<b>${this.escapeTelegramHtml(line)}</b>`
          : this.escapeTelegramHtml(line),
      )
      .join('\n');
  }

  private escapeTelegramHtml(value: string): string {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  private parseTransactionCallbackData(
    callbackData: string | undefined,
  ): ParsedTransactionCallback {
    const value = this.cleanString(callbackData);

    if (!value) {
      return {
        action: 'invalid_callback',
        error: 'Invalid transaction callback.',
      };
    }

    const parts = value.split(':');
    const action = parts[0];

    if (
      action === 'save_transaction' ||
      action === 'cancel_transaction' ||
      action === 'change_categories'
    ) {
      if (parts.length !== 2) {
        return {
          action,
          error: 'Invalid transaction callback.',
        };
      }

      const transactionId = this.normalizeCallbackId(parts[1]);

      if (!transactionId) {
        return {
          action,
          error: 'Invalid transaction callback.',
        };
      }

      return { action, transactionId };
    }

    if (action === 'catid') {
      if (parts.length !== 3) {
        return {
          action,
          error: 'Invalid transaction callback.',
        };
      }

      const budgetId = this.normalizeCallbackId(parts[1]);
      const transactionId = this.normalizeCallbackId(parts[2]);

      if (!budgetId || !transactionId) {
        return {
          action,
          transactionId,
          budgetId,
          error: 'Invalid transaction callback.',
        };
      }

      return {
        action,
        budgetId,
        transactionId,
      };
    }

    return {
      action: 'unknown_callback',
      error: 'Unsupported transaction callback.',
    };
  }

  private normalizeCallbackId(value: string | undefined): number | undefined {
    const cleaned = this.cleanString(value);

    if (!cleaned || !/^\d+$/.test(cleaned)) {
      return undefined;
    }

    return this.normalizePositiveInteger(Number(cleaned));
  }

  private normalizePositiveInteger(value: unknown): number | undefined {
    if (
      typeof value !== 'number' ||
      !Number.isSafeInteger(value) ||
      value <= 0
    ) {
      return undefined;
    }

    return value;
  }

  private transactionCallbackOk(input: {
    action: TransactionCallbackHandleAction;
    text: string;
    request: TransactionCallbackHandleRequestDto;
    transactionId: number;
    replyMarkup: object | null;
  }): TransactionCallbackHandleResponseDto {
    return {
      status: 'ok',
      action: input.action,
      transactionId: input.transactionId,
      telegram: this.buildCallbackTelegramPayload({
        request: input.request,
        text: input.text,
        replyMarkup: input.replyMarkup,
      }),
    };
  }

  private transactionCallbackError(input: {
    action: TransactionCallbackHandleAction;
    text: string;
    request: TransactionCallbackHandleRequestDto;
    transactionId?: number;
  }): TransactionCallbackHandleResponseDto {
    return {
      status: 'error',
      action: input.action,
      transactionId: input.transactionId,
      telegram: this.buildCallbackTelegramPayload({
        request: input.request,
        text: input.text,
        replyMarkup: null,
      }),
    };
  }

  private buildCallbackTelegramPayload(input: {
    request: TransactionCallbackHandleRequestDto;
    text: string;
    replyMarkup: object | null;
  }): TransactionCallbackHandleResponseDto['telegram'] {
    const telegram: TransactionCallbackHandleResponseDto['telegram'] = {
      method: 'editMessageText',
      text: this.escapeTelegramHtml(input.text),
      parse_mode: 'HTML',
      reply_markup: input.replyMarkup,
    };

    if (input.request.chatId !== undefined) {
      telegram.chat_id = input.request.chatId;
    }

    if (input.request.messageId !== undefined) {
      telegram.message_id = input.request.messageId;
    }

    return telegram;
  }

  private confirmTransactionStatusText(
    status: ConfirmTransactionStatus,
  ): string {
    if (status === 'not_found') {
      return 'Transaction was not found.';
    }

    if (status === 'already_confirmed') {
      return 'This transaction was already confirmed.';
    }

    if (status === 'already_rejected') {
      return 'This transaction was already cancelled.';
    }

    return 'Transaction callback could not be completed.';
  }

  private categoryOptionsStatusText(
    status: TransactionCategoryOptionStatus,
  ): string {
    if (status === 'not_found') {
      return 'Transaction was not found.';
    }

    if (status === 'already_resolved') {
      return 'This transaction was already handled.';
    }

    return 'Category options could not be loaded.';
  }

  private setCategoryStatusText(status: TransactionSetCategoryStatus): string {
    if (status === 'not_found') {
      return 'Transaction was not found.';
    }

    if (status === 'already_resolved') {
      return 'This transaction was already handled.';
    }

    if (status === 'unauthorized_budget') {
      return 'Selected category was not found.';
    }

    return 'Transaction category could not be updated.';
  }

  private buildCategoryOptionsReplyMarkup(
    pendingTransactionId: string,
    callbackMode: TransactionCallbackMode,
    transactionId: string | undefined,
    categoryOptions: CategoryOption[],
  ): TelegramReplyMarkupDto {
    if (callbackMode === PRODUCTION_CALLBACK_MODE) {
      if (!transactionId) {
        return { inline_keyboard: [] };
      }

      return {
        inline_keyboard: categoryOptions.map((option) => [
          {
            text: this.telegramSafeButtonLabel(option.label),
            callback_data: option.budgetId
              ? this.categorySelectCallbackData(option.budgetId, transactionId)
              : `tx_set_category:${pendingTransactionId}:${this.categorySlug(
                  option.category,
                )}`,
          },
        ]),
      };
    }

    return {
      inline_keyboard: this.defaultCategoryOptions().map((option) => [
        {
          text: option.label,
          callback_data: `tx_set_category:${pendingTransactionId}:${this.categorySlug(
            option.category,
          )}`,
        },
      ]),
    };
  }

  private resolveCallbackTransactionId(input: {
    callbackMode: TransactionCallbackMode;
    pendingTransactionId: string | undefined;
    transactionId: string | undefined;
  }): string | undefined {
    return input.callbackMode === EXPERIMENTAL_CALLBACK_MODE
      ? input.pendingTransactionId
      : input.transactionId;
  }

  private saveTransactionCallbackData(transactionId: string): string {
    return `save_transaction:${transactionId}`;
  }

  private cancelTransactionCallbackData(transactionId: string): string {
    return `cancel_transaction:${transactionId}`;
  }

  private changeCategoriesCallbackData(transactionId: string): string {
    return `change_categories:${transactionId}`;
  }

  private categorySelectCallbackData(
    budgetId: string,
    transactionId: string,
  ): string {
    return `catid:${budgetId}:${transactionId}`;
  }

  private categorySlug(category: string): string {
    return category.toLowerCase().replace(/&/g, 'and').replace(/\s+/g, '_');
  }

  private normalizeCategoryOption(
    category: string | undefined,
  ): string | undefined {
    const cleanedCategory = this.cleanString(category);

    if (!cleanedCategory) {
      return undefined;
    }

    const normalizedSlug = this.categorySlug(cleanedCategory);

    return TRANSACTION_CATEGORY_OPTIONS.find(
      (option) =>
        option.toLowerCase() === cleanedCategory.toLowerCase() ||
        this.categorySlug(option) === normalizedSlug,
    );
  }

  private defaultCategoryOptions(): CategoryOption[] {
    return TRANSACTION_CATEGORY_OPTIONS.map((category) => ({
      budgetId: null,
      label: category,
      category,
    }));
  }

  private async findCategoryOptions(userId: string): Promise<CategoryOption[]> {
    const result = await this.database.query<BudgetCategoryRow>(
      `
        SELECT
          child.id,
          child.category,
          parent.category AS parent_category
        FROM budgets child
        LEFT JOIN budgets parent
          ON parent.id = child.parent_budget_id
          AND parent.user_id = child.user_id
        WHERE child.user_id::text = $1
          AND COALESCE(child.is_active, true) = true
          AND NOT EXISTS (
            SELECT 1
            FROM budgets active_child
            WHERE active_child.parent_budget_id = child.id
              AND active_child.user_id = child.user_id
              AND COALESCE(active_child.is_active, true) = true
          )
        ORDER BY
          COALESCE(parent.category, child.category),
          child.category
      `,
      [userId],
    );

    if (result.rows.length === 0) {
      return this.defaultCategoryOptions();
    }

    return result.rows.map((row) => ({
      budgetId: String(row.id),
      label: row.parent_category
        ? `${row.parent_category} / ${row.category}`
        : row.category,
      category: row.category,
    }));
  }

  private async findBudgetCategory(
    budgetId: string,
    userId: string,
  ): Promise<CategoryOption | undefined> {
    const options = await this.findCategoryOptions(userId);

    return options.find((option) => option.budgetId === budgetId);
  }

  private telegramSafeButtonLabel(label: string): string {
    return label.length > 32 ? `${label.slice(0, 29)}...` : label;
  }

  private async setTransactionCategory(input: {
    transactionId: string | undefined;
    budgetId: string | undefined;
    userId: string;
  }): Promise<TransactionSetCategoryResponseDto> {
    if (!input.transactionId) {
      throw new BadRequestException('transactionId is required');
    }

    if (!input.budgetId) {
      throw new BadRequestException('budgetId is required');
    }

    const transaction = await this.findTransaction(
      input.transactionId,
      input.userId,
    );

    if (!transaction) {
      return {
        status: 'not_found',
        pendingTransactionId: null,
        transactionId: input.transactionId,
        confirmationPayload: null,
        summary: null,
        editMessage: null,
      };
    }

    const budgetCategory = await this.findBudgetCategory(
      input.budgetId,
      input.userId,
    );

    if (!budgetCategory) {
      return {
        status: 'unauthorized_budget',
        pendingTransactionId: null,
        transactionId: String(transaction.id),
        confirmationPayload: null,
        summary: this.transactionSummary(transaction),
        editMessage: null,
      };
    }

    await this.database.query(
      `
        UPDATE transactions
        SET category = $1,
            status = 'confirmed',
            updated_at = now()
        WHERE id::text = $2
          AND user_id::text = $3
      `,
      [
        budgetCategory.category,
        String(transaction.id),
        String(transaction.user_id),
      ],
    );

    const summary = this.transactionSummary({
      ...transaction,
      category: budgetCategory.category,
      status: 'confirmed',
    });

    return {
      status: 'updated',
      pendingTransactionId: null,
      transactionId: String(transaction.id),
      confirmationPayload: null,
      summary,
      editMessage: this.transactionEditMessage(
        String(transaction.id),
        summary,
        'confirmed',
      ),
    };
  }

  private async findPendingTransaction(
    pendingTransactionId: string,
    userId: string,
  ): Promise<PendingTransactionRow | undefined> {
    const result = await this.database.query<PendingTransactionRow>(
      `
        SELECT
          id,
          user_id,
          transaction_type,
          amount,
          merchant,
          merchant_normalized,
          COALESCE(category_suggested, category) AS category,
          COALESCE(transaction_date, created_at) AS transaction_date,
          source,
          bank,
          payment_type,
          raw_payload,
          resolved
        FROM pending_transactions
        WHERE id::text = $1
          AND user_id::text = $2
        LIMIT 1
      `,
      [pendingTransactionId, userId],
    );

    return result.rows[0];
  }

  private formatCurrency(amount: number): string {
    return `Rp${amount.toLocaleString('id-ID')}`;
  }

  private formatDateForTelegram(value: string): string {
    const date = new Date(value);

    if (Number.isNaN(date.getTime())) {
      return value;
    }

    return date.toISOString().slice(0, 10);
  }

  private titleCase(value: string): string {
    return value.charAt(0).toUpperCase() + value.slice(1);
  }

  private titleCaseWords(value: string): string {
    return value
      .split(/\s+/)
      .filter(Boolean)
      .map((word) => this.titleCase(word.toLowerCase()))
      .join(' ');
  }

  private normalizeSource(value: string | undefined): string | undefined {
    const source = this.cleanString(value)?.toLowerCase();

    if (!source) {
      throw new BadRequestException('source is required');
    }

    if (
      source === 'telegram' ||
      source === 'email' ||
      source === 'manual' ||
      source === 'import'
    ) {
      return source;
    }

    return source;
  }

  private async resolveMerchantNormalized(merchant: string): Promise<string> {
    return (await this.findMerchantAliasCanonicalName(merchant)) ?? merchant;
  }

  private async findMerchantAliasCanonicalName(
    merchant: string,
  ): Promise<string | null> {
    const result = await this.database.query<MerchantAliasRow>(
      `
        SELECT canonical_name
        FROM merchant_aliases
        WHERE lower($1) LIKE '%' || lower(alias_name) || '%'
        ORDER BY length(alias_name) DESC
        LIMIT 1
      `,
      [merchant],
    );

    return result.rows[0]?.canonical_name ?? null;
  }

  private async resolveCategory(
    merchantNormalized: string,
    merchant: string,
  ): Promise<string | null> {
    const result = await this.database.query<CategoryRuleRow>(
      `
        SELECT category
        FROM category_rules
        WHERE lower(merchant_pattern) = lower($1)
          OR lower(merchant_pattern) = lower($2)
        ORDER BY priority DESC NULLS LAST
        LIMIT 1
      `,
      [merchantNormalized, merchant],
    );

    return result.rows[0]?.category ?? null;
  }

  private normalizeTransactionDate(value?: string): string {
    if (!value) {
      return new Date().toISOString();
    }

    const date = new Date(value);

    if (Number.isNaN(date.getTime())) {
      throw new BadRequestException('transactionDate must be a valid date');
    }

    return date.toISOString();
  }

  private calculateConfidence(input: {
    merchant: string | undefined;
    merchantNormalized: string;
    category: string | null;
    warnings: string[];
  }): number {
    let confidence = 70;

    if (input.merchant && input.merchantNormalized !== input.merchant) {
      confidence += 15;
    }

    if (input.category) {
      confidence += 10;
    }

    confidence -= input.warnings.length * 5;

    return Math.min(Math.max(confidence, 0), 95);
  }

  private cleanString(value: string | null | undefined): string | undefined {
    const cleaned = value?.trim();
    return cleaned ? cleaned : undefined;
  }
}
