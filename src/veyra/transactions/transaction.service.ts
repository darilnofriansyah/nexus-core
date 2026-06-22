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
} from './dto/confirm-transaction.dto';
import {
  TransactionCategoryOptionsRequestDto,
  TransactionCategoryOptionsResponseDto,
  TransactionSetCategoryRequestDto,
  TransactionSetCategoryResponseDto,
} from './dto/category-callback.dto';
import {
  SavedTransactionDto,
  SaveTransactionInputDto,
  TransactionHandleRequestDto,
  TransactionHandleResponseDto,
  TransactionHandleStateName,
  TransactionStatus,
} from './dto/handle-transaction.dto';

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
  canonical_name: string;
}

interface CategoryRuleRow extends QueryResultRow {
  category: string;
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

interface TransactionHandleStateStore {
  upsertState?(request: {
    userId: string | number;
    stateName: TransactionHandleStateName;
    stateData?: unknown;
    expiresAt?: string | null;
  }): Promise<unknown>;
  resetState(request: { userId: string | number }): Promise<unknown>;
}

@Injectable()
export class TransactionService {
  constructor(private readonly database: DatabaseService) {}

  placeholderStatus() {
    return {
      implemented: false,
      nextStep: 'Move transaction parsing and validation here before Telegram trigger removal.',
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
    const transactionDate = this.normalizeTransactionDate(request.transactionDate);

    if (!userId) {
      throw new BadRequestException('userId is required');
    }

    if (amount <= 0) {
      throw new BadRequestException('amount must be positive');
    }

    if ((transactionType === 'expense' || transactionType === 'income') && !merchant) {
      throw new BadRequestException('merchant is required for expense and income');
    }

    const merchantNormalized = merchant
      ? await this.resolveMerchantNormalized(merchant)
      : merchant ?? '';
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
    const notes = this.cleanString(request.notes ?? undefined) ?? EMPTY_CONFIRMATION_FIELD;
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

  async confirmPendingTransactionExperimental(
    request: {
      pendingTransactionId: string;
      userId: string;
    },
  ): Promise<{
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
        transactionId: transactionId === undefined ? null : String(transactionId),
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
          source?.merchant_normalized ??
          source?.merchant ??
          'Unknown'
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
      [category, String(pendingTransaction.id), String(pendingTransaction.user_id)],
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
        warnings.push('transactionType mapped to reversal from reversal-like input');
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
      Object.entries(value).filter(([, fieldValue]) => fieldValue !== undefined),
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
      text && ['reset', 'cancel', 'exit', 'stop', 'batal', 'keluar'].includes(text),
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

  private normalizeCategoryOption(category: string | undefined): string | undefined {
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
      [budgetCategory.category, String(transaction.id), String(transaction.user_id)],
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

    return result.rows[0]?.canonical_name ?? merchant;
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
