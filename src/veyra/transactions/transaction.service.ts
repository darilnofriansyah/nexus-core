import {
  BadRequestException,
  Injectable,
  Logger,
  Optional,
} from "@nestjs/common";
import { convert } from "html-to-text";
import { QueryResultRow } from "pg";
import { DatabaseService } from "../../database/database.service";
import { BudgetService } from "../budgets/budget.service";
import { BudgetWatchdogResponseDto } from "../budgets/dto/overspending-check.dto";
import {
  NormalizeTransactionRequestDto,
  NormalizeTransactionResponseDto,
  NormalizedTransactionType,
} from "./dto/normalize-transaction.dto";
import {
  TelegramReplyMarkupDto,
  TransactionCallbackMode,
  TransactionConfirmationPayloadRequestDto,
  TransactionConfirmationPayloadResponseDto,
} from "./dto/confirmation-payload.dto";
import {
  ConfirmTransactionRequestDto,
  ConfirmTransactionResponseDto,
  ConfirmTransactionEditMessageDto,
  ConfirmTransactionSummaryDto,
  ConfirmTransactionStatus,
} from "./dto/confirm-transaction.dto";
import {
  TransactionCategoryOptionStatus,
  TransactionCategoryOptionsRequestDto,
  TransactionCategoryOptionsResponseDto,
  TransactionSetCategoryStatus,
  TransactionSetCategoryRequestDto,
  TransactionSetCategoryResponseDto,
} from "./dto/category-callback.dto";
import {
  TransactionCallbackHandleAction,
  TransactionCallbackHandleRequestDto,
  TransactionCallbackHandleResponseDto,
} from "./dto/transaction-callback-handle.dto";
import {
  CreateRegretReviewRequestDto,
  CreateRegretReviewResponseDto,
} from "./dto/transaction-risk-review.dto";
import {
  TransactionManageChangesDto,
  TransactionManageHandleRequestDto,
  TransactionManageHandleResponseDto,
  TransactionManageStateName,
  TransactionManageTargetDto,
} from "./dto/transaction-manage.dto";
import {
  SavedTransactionDto,
  SaveTransactionInputDto,
  TransactionHandleRequestDto,
  TransactionHandleResponseDto,
  TransactionHandleStateName,
  TransactionStatus,
} from "./dto/handle-transaction.dto";
import {
  EmailReviewResolutionDto,
  EmailReviewTransactionCandidateDto,
  EmailTransactionMessageDto,
  EmailTransactionHandleRequestDto,
  EmailTransactionHandleResponseDto,
  EmailTransactionHandleStatus,
  EmailTransactionResolveReviewRequestDto,
  EmailTransactionResolveReviewResponseDto,
  EmailValidatedTemplatePayloadDto,
  ParsedEmailTransactionDto,
} from "./dto/email-transaction.dto";
import {
  CreatePendingRiskReviewInput,
  TransactionRiskLevel,
  TransactionRiskReview,
  TransactionRiskReviewRepository,
  TransactionRiskUserResponse,
} from "./transaction-risk-review.repository";
import {
  TransactionWatchdogNotificationDto,
  TransactionWatchdogResponseDto,
} from "./dto/transaction-watchdog.dto";
import {
  EmailTemplateDetection,
  EmailParserInput,
  EmailTransactionParser,
  buildEmailParserRegistry,
  detectEmailProviderAndTemplate,
  normalizeEmailBody,
  normalizeEmailWhitespace,
} from "./email-parsers";
import {
  EmailParserTemplateRepository,
  EmailTemplateQuery,
} from "./email-parser-template.repository";
import {
  hasAlignedSenderAuthentication,
  isLikelyTransactionEmail,
  parseLearnedEmailTemplate,
  validateEmailTemplateProposal,
  validateStoredEmailTemplateProposal,
} from "./learned-email-parser";

const TRANSACTION_CATEGORY_OPTIONS = [
  "Food",
  "Transport",
  "Groceries",
  "Bills",
  "Health & Beauty",
  "Shopping",
  "Entertainment",
  "Transfer",
  "Other",
] as const;

const PRODUCTION_CALLBACK_MODE: TransactionCallbackMode = "production";
const EXPERIMENTAL_CALLBACK_MODE: TransactionCallbackMode = "experimental";
const EMPTY_CONFIRMATION_FIELD = "-";
const LARGE_TRANSACTION_EVALUATOR_VERSION = "large_transaction_v1";
const LARGE_TRANSACTION_RISK_TYPE = "large_transaction";
const RISK_HISTORY_WINDOW_DAYS = 90;
const RISK_MIN_MEDIAN_HISTORY = 5;
const RISK_BUDGET_SHARE_THRESHOLD = 20;
const RISK_UNUSUAL_MULTIPLIER_THRESHOLD = 3;
const RISK_MERCHANT_FREQUENCY_THRESHOLD = 3;
const RISK_SCORE_CAP = 100;
const RISK_SIGNAL_SCORES = {
  highBudgetShare: 40,
  unusualVsMedian: 30,
  causesBudgetOverspend: 25,
  unsafeBurnRate: 20,
  lowFrequencyMerchant: 10,
} as const;
const EMAIL_MATERIAL_KEYS = [
  "amount",
  "merchant",
  "merchant_normalized",
  "transaction_date",
  "transaction_type",
] as const;
const RISK_LEVEL_BOUNDS = {
  medium: 30,
  high: 50,
  critical: 70,
} as const;

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
  timezone?: string | null;
}

interface ExistingImportRow extends QueryResultRow {
  id: string | number;
  transaction_id: string | number | null;
  status: string;
  raw_payload?: unknown;
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

interface EmailReviewTransactionRow extends QueryResultRow {
  id: string | number;
  user_id: string | number;
  transaction_type: NormalizedTransactionType;
  amount: string | number;
  merchant: string;
  merchant_normalized: string;
  category: string;
  transaction_date: string | Date;
  status: "pending";
  confidence: string | number;
}

interface InsertedImportRow extends QueryResultRow {
  id: string | number;
}

interface TransactionRow extends QueryResultRow {
  id: string | number;
  user_id: string | number;
  transaction_type?: string | null;
  amount: string | number;
  merchant: string | null;
  merchant_normalized: string | null;
  category: string | null;
  transaction_date?: string | Date | null;
  notes?: string | null;
  status: string | null;
  source?: string | null;
  confidence?: string | number | null;
  raw_payload?: unknown;
  created_at?: string | Date | null;
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

interface RiskCycleStartRow extends QueryResultRow {
  cycle_start_day: number | string | null;
}

interface RiskBudgetFactsRow extends QueryResultRow {
  category_budget_id: string | number | null;
  category_budget_category: string | null;
  category_budget_amount: string | number | null;
  category_spend_before: string | number | null;
  parent_budget_id: string | number | null;
  parent_budget_category: string | null;
  parent_budget_amount: string | number | null;
  parent_spend_before: string | number | null;
  total_budget_amount: string | number | null;
  total_spend_before: string | number | null;
}

interface RiskAmountRow extends QueryResultRow {
  amount: string | number;
}

interface RiskCountRow extends QueryResultRow {
  count: string | number;
}

type ValidatedEmailReview =
  | {
      kind: "failure";
      userId: string;
      email: EmailTransactionMessageDto;
      errorReason: string;
    }
  | {
      kind: "non_transaction";
      userId: string;
      email: EmailTransactionMessageDto;
    }
  | {
      kind: "candidate";
      userId: string;
      email: EmailTransactionMessageDto;
      transactionId: string | null;
      candidate: EmailReviewTransactionCandidateDto & {
        source: "email";
        transactionType: NormalizedTransactionType;
        amount: number;
        merchant: string;
        merchantNormalized: string;
        transactionDate: string;
      };
      resolution: EmailReviewResolutionDto & {
        category: string;
        confidence: number;
      };
      rawPayload: {
        email: {
          messageId: string;
          from: string;
          authentication: EmailTransactionMessageDto["authentication"] | null;
        };
        parserSource: "ai";
        reviewContext: {
          timeZone: string | null;
          originalTransactionDate: string;
        };
        validatedTemplate: EmailValidatedTemplatePayloadDto | null;
      };
    };

type ValidatedEmailCandidateReview = Extract<
  ValidatedEmailReview,
  { kind: "candidate" }
>;

interface PendingEmailReviewRow extends QueryResultRow {
  id: string | number;
}

interface EmailParseAttempt {
  parser?: EmailTransactionParser;
  input: EmailParserInput;
  detection: EmailTemplateDetection;
  parsed?: ParsedEmailTransactionDto;
  reason?: string;
  learnedTemplateId?: string;
}

interface TransactionHandleStateStore {
  getState?(userId: string | number): Promise<{
    stateName: string;
    stateData: unknown;
    expiresAt: string | null;
  }>;
  upsertState?(request: {
    userId: string | number;
    stateName: TransactionHandleStateName | TransactionManageStateName;
    stateData?: unknown;
    expiresAt?: string | null;
  }): Promise<unknown>;
  resetState(request: { userId: string | number }): Promise<unknown>;
}

interface ManageTransactionSnapshot {
  id: string;
  user_id: string;
  transaction_type: NormalizedTransactionType;
  amount: number;
  merchant: string | null;
  merchant_normalized: string | null;
  category: string | null;
  transaction_date: string | null;
  notes: string | null;
  status: string | null;
}

interface ManageStateData {
  action?: "edit" | "delete";
  candidates?: ManageTransactionSnapshot[];
  changes?: Partial<
    Record<keyof TransactionManageChangesDto, string | number | null>
  >;
  transaction_id?: string;
  before?: ManageTransactionSnapshot;
}

interface ParsedTransactionCallback {
  action: TransactionCallbackHandleAction;
  transactionId?: number;
  budgetId?: number;
  reviewId?: number;
  riskAction?: TransactionRiskUserResponse;
  error?: string;
}

interface RiskReason {
  code:
    | "high_budget_share"
    | "unusual_vs_median"
    | "causes_budget_overspend"
    | "unsafe_burn_rate"
    | "low_frequency_merchant";
  score: number;
  message: string;
}

interface RiskBudgetFacts {
  categoryBudgetId: string | null;
  categoryBudgetCategory: string | null;
  categoryBudgetAmount: number | null;
  categorySpendBefore: number | null;
  categorySpendAfter: number | null;
  parentBudgetId: string | null;
  parentBudgetCategory: string | null;
  parentBudgetAmount: number | null;
  parentSpendBefore: number | null;
  parentSpendAfter: number | null;
  transactionBudgetSharePercent: number | null;
  causedCategoryOverspend: boolean;
  causedParentOverspend: boolean;
}

interface RiskTransactionHistory {
  amounts: number[];
  merchantPriorCount: number | null;
}

interface RiskBurnRateFacts {
  unsafe: boolean;
  notification: TransactionWatchdogNotificationDto | null;
  projectedCycleSpend: number | null;
  budgetAmount: number | null;
}

@Injectable()
export class TransactionService {
  private readonly logger = new Logger(TransactionService.name);
  private readonly emailParsers: EmailTransactionParser[] =
    buildEmailParserRegistry();

  constructor(
    private readonly database: DatabaseService,
    @Optional() private readonly budgetService?: BudgetService,
    @Optional()
    private readonly riskReviewRepository?: TransactionRiskReviewRepository,
    @Optional()
    private readonly emailParserTemplateRepository?: EmailParserTemplateRepository,
  ) {}

  placeholderStatus() {
    return {
      implemented: false,
      nextStep:
        "Move transaction parsing and validation here before Telegram trigger removal.",
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
    const source = this.cleanString(request.source) ?? "manual";
    const notes = this.cleanString(request.notes ?? undefined) ?? null;
    const transactionDate = this.normalizeTransactionDate(
      request.transactionDate,
    );

    if (!userId) {
      throw new BadRequestException("userId is required");
    }

    if (amount <= 0) {
      throw new BadRequestException("amount must be positive");
    }

    if (transactionType === "expense" && !merchant) {
      throw new BadRequestException("merchant is required for expense");
    }

    const merchantNormalized = merchant
      ? await this.resolveMerchantNormalized(merchant)
      : transactionType === "income"
        ? null
        : (merchant ?? "");
    const category =
      providedCategory ??
      (merchant
        ? await this.resolveCategory(merchantNormalized ?? merchant, merchant)
        : null);

    return {
      userId,
      transactionType,
      amount,
      merchant: merchant ?? (transactionType === "income" ? null : ""),
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
    const regretNote = await this.handleRegretNoteIfNeeded(request, stateStore);

    if (regretNote) {
      return regretNote;
    }

    const source = this.normalizeSource(request.source);

    if (source !== "manual") {
      return {
        status: "unsupported_source",
        transactionId: null,
        message: `Transaction source ${source ?? "unknown"} is not supported yet.`,
      };
    }

    if (this.isResetText(request.text)) {
      await this.resetConversationState(request.userId, stateStore);
      return {
        status: "cancelled",
        transactionId: null,
        message: "Transaction recording cancelled.",
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
        stateName: "record_transaction_state",
        stateData: pendingPayload,
      });

      return {
        status: "awaiting_missing_field",
        transactionId: null,
        message: this.buildTransactionFollowUpQuestion(missingField),
        state: {
          nextState: "record_transaction_state",
          payload: pendingPayload,
        },
      };
    }

    const transactionType = this.cleanString(
      llmResult.transaction_type,
    )?.toLowerCase();

    if (transactionType !== "income") {
      this.requireHandleMerchant(llmResult.merchant);
    }

    const confidence = this.normalizeConfidence(llmResult.confidence);
    const normalized = await this.normalizeTransaction({
      userId: String(request.userId ?? ""),
      transactionType: llmResult.transaction_type ?? "",
      amount: llmResult.amount ?? 0,
      merchant: llmResult.merchant ?? "",
      category: llmResult.category ?? undefined,
      transactionDate: llmResult.transaction_date ?? undefined,
      source,
      notes: llmResult.notes ?? null,
      rawPayload: llmResult,
    });

    if (
      normalized.transactionType !== "income" &&
      !normalized.category
    ) {
      throw new BadRequestException("category is required");
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

    const watchdog = await this.evaluateTransactionWatchdog(
      savedTransaction.id,
    );

    return this.buildHandleResponse(savedTransaction, watchdog);
  }

  async handleManagedTransaction(
    request: TransactionManageHandleRequestDto,
    stateStore: TransactionHandleStateStore,
  ): Promise<TransactionManageHandleResponseDto> {
    const telegramUserId = this.cleanString(request.telegramUserId);

    if (!telegramUserId) {
      return this.manageInvalid("Telegram user is required.");
    }

    const user = await this.findTelegramUserByTelegramId(telegramUserId);

    if (!user) {
      return this.manageInvalid("Telegram user was not found.");
    }

    const userId = String(user.id);
    const callback = this.parseManageCallback(request.text);

    if (
      callback.action === "cancel" ||
      request.llmResult?.intent === "cancel_action"
    ) {
      await stateStore.resetState({ userId });
      return this.manageResponse({
        ok: true,
        status: "cancelled",
        message: "Cancelled.",
      });
    }

    if (callback.action === "select") {
      return this.handleManageSelection(userId, callback.index, stateStore);
    }

    if (callback.action === "confirm") {
      return this.handleManageConfirmation(userId, stateStore);
    }

    if (callback.action === "invalid") {
      return this.manageInvalid(
        "This action is no longer valid. Please start again.",
      );
    }

    const intent = request.llmResult?.intent;

    if (intent !== "edit_transaction" && intent !== "delete_transaction") {
      return this.manageInvalid(
        "This action is no longer valid. Please start again.",
      );
    }

    if (intent === "edit_transaction") {
      const changes = this.validateManageChanges(request.llmResult?.changes);

      if (!changes) {
        return this.manageInvalid("Tell me what to change first.");
      }

      return this.startManageFlow({
        userId,
        action: "edit",
        target: request.llmResult?.target ?? null,
        changes,
        stateStore,
      });
    }

    return this.startManageFlow({
      userId,
      action: "delete",
      target: request.llmResult?.target ?? null,
      changes: {},
      stateStore,
    });
  }

  async handleEmailTransaction(
    request: EmailTransactionHandleRequestDto,
  ): Promise<EmailTransactionHandleResponseDto> {
    const validated = await this.validateEmailTransactionRequest(request);
    const existingImport = await this.findTransactionImport(
      validated.userId,
      validated.email.messageId,
    );

    if (existingImport) {
      return this.resumeExistingEmailImport(validated, existingImport);
    }

    const parserInputs = this.buildEmailParserInputs(validated);
    let parsedAttempt = this.parseEmail(parserInputs);

    if (!parsedAttempt?.parsed || parsedAttempt.reason) {
      const learnedAttempt = await this.parseLearnedEmail(
        parserInputs,
        validated,
      );

      if (learnedAttempt) {
        parsedAttempt = learnedAttempt;
      }
    }

    const parser = parsedAttempt?.parser;
    const detection =
      parsedAttempt?.detection ??
      this.detectEmailProviderFromInputs(parserInputs);
    const provider =
      parsedAttempt?.parsed?.provider ?? parser?.provider ?? detection.provider;

    if (
      (!parsedAttempt?.parsed || parsedAttempt.reason) &&
      parserInputs.some(isLikelyTransactionEmail)
    ) {
      const aiReason = parsedAttempt ? "parse_failed" : "unsupported_template";

      return this.recordUnconfirmedEmailAttempt({
        request: validated,
        status: "needs_ai",
        provider: provider === "unknown" ? null : provider,
        templateKey:
          parsedAttempt?.parsed?.templateKey ??
          parser?.templateKey ??
          detection.templateKey,
        reason:
          aiReason === "parse_failed"
            ? (parsedAttempt?.reason ?? "email parse failed")
            : provider === "unknown"
              ? "email template is not supported"
              : `${provider} email template is not supported`,
        parsed: parsedAttempt?.parsed,
        detection,
        aiRequest: {
          reviewToken: validated.email.messageId,
          reason: aiReason,
        },
      });
    }

    if (provider === "unknown") {
      return this.recordUnconfirmedEmailAttempt({
        request: validated,
        status: "unsupported_provider",
        provider: null,
        templateKey: null,
        reason: "email sender or body is not a supported provider",
        parsed: undefined,
        detection,
      });
    }

    if (!parsedAttempt) {
      return this.recordUnconfirmedEmailAttempt({
        request: validated,
        status: "unsupported_template",
        provider,
        templateKey: null,
        reason: `${provider} email template is not supported`,
        parsed: undefined,
        detection,
      });
    }

    const parsed = parsedAttempt.parsed;

    if (!parsed) {
      return this.recordUnconfirmedEmailAttempt({
        request: validated,
        status: "parse_failed",
        provider: parser?.provider ?? detection.provider,
        templateKey: parser?.templateKey ?? detection.templateKey,
        reason: parsedAttempt.reason ?? "email parse failed",
        parsed: undefined,
        detection,
      });
    }

    const parsedValidationReason = this.emailParsedValidationReason(parsed);

    if (parsedValidationReason) {
      return this.recordUnconfirmedEmailAttempt({
        request: validated,
        status:
          parsedValidationReason === "email is not a transaction"
            ? "ignored_non_transaction"
            : "parse_failed",
        provider: parsed.provider,
        templateKey: parsed.templateKey,
        reason: parsedValidationReason,
        parsed,
        detection,
      });
    }

    if (
      parsedAttempt.learnedTemplateId &&
      !hasAlignedSenderAuthentication(validated.email)
    ) {
      return this.recordUnconfirmedEmailAttempt({
        request: validated,
        status: "needs_review",
        provider: parsed.provider,
        templateKey: parsed.templateKey,
        reason: "sender authentication is required for automatic import",
        parsed,
        detection,
      });
    }

    const merchant = this.cleanString(parsed.merchant ?? undefined);

    if (!merchant || this.isUnknownMerchant(merchant)) {
      return this.recordUnconfirmedEmailAttempt({
        request: validated,
        status: "needs_review",
        provider: parsed.provider,
        templateKey: parsed.templateKey,
        reason: "merchant could not be resolved",
        parsed,
        detection,
      });
    }

    const merchantAlias = await this.findMerchantAliasCanonicalName(merchant);

    if (!merchantAlias) {
      return this.recordUnconfirmedEmailAttempt({
        request: validated,
        status: "needs_review",
        provider: parsed.provider,
        templateKey: parsed.templateKey,
        reason: "merchant alias could not be resolved",
        parsed,
        detection,
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
        status: "needs_review",
        provider: parsed.provider,
        templateKey: parsed.templateKey,
        reason: "category could not be resolved",
        parsed,
        detection,
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
        status: "duplicate",
        provider: parsed.provider,
        templateKey: parsed.templateKey,
        reason: "email message already imported",
        parsed,
      });
    }

    if (parsedAttempt.learnedTemplateId && this.emailParserTemplateRepository) {
      try {
        await this.emailParserTemplateRepository.markMatched(
          parsedAttempt.learnedTemplateId,
          validated.userId,
        );
      } catch (error) {
        this.logger.error(
          `Failed to mark email parser template ${parsedAttempt.learnedTemplateId} as matched`,
          error instanceof Error ? error.stack : undefined,
        );
      }
    }

    const watchdog = await this.evaluateTransactionWatchdog(transaction.id);

    return this.buildEmailResponse({
      status: "confirmed",
      provider: parsed.provider,
      templateKey: parsed.templateKey,
      reason: null,
      parsed,
      transaction,
      watchdog,
    });
  }

  async resolveEmailTransactionReview(
    request: EmailTransactionResolveReviewRequestDto,
  ): Promise<EmailTransactionResolveReviewResponseDto> {
    const telegramUserId = this.cleanString(request.telegramUserId);

    if (!telegramUserId) {
      throw new BadRequestException("telegramUserId is required");
    }

    const user = await this.findTelegramUserByTelegramId(telegramUserId);

    if (!user) {
      return {
        status: "needs_review",
        reason: "user_not_found",
        message: "Telegram user was not found.",
        transactionCandidate: request.transactionCandidate,
        resolution: request.resolution,
      };
    }

    const validated = this.validateEmailReviewRequest(
      request,
      String(user.id),
      this.cleanString(user.timezone) ?? null,
    );

    if (
      validated.kind === "candidate" &&
      validated.transactionId &&
      !(await this.findPendingEmailReviewTransaction(
        validated.transactionId,
        String(user.id),
        validated.email.messageId,
      ))
    ) {
      throw new BadRequestException("pending email transaction was not found");
    }

    if (validated.kind === "failure") {
      await this.recordEmailAiFailure(validated);
      return {
        status: "needs_review",
        reason: "ai_failed",
        message: validated.errorReason,
      };
    }

    if (validated.kind === "non_transaction") {
      await this.recordEmailNonTransaction(validated);
      return {
        status: "ignored_non_transaction",
        reason: "ai_non_transaction",
        message: "AI classified the email as a non-transaction.",
      };
    }

    const budgetCategory = await this.findExistingBudgetCategory(
      validated.userId,
      validated.resolution.category,
    );
    const category = budgetCategory ?? validated.resolution.category;
    const transaction = await this.saveEmailReviewTransaction({
      userId: validated.userId,
      transactionId: validated.transactionId,
      messageId: validated.email.messageId,
      candidate: {
        ...validated.candidate,
        category,
      },
      confidence: validated.resolution.confidence,
      rawPayload: validated.rawPayload,
    });

    const telegramText = this.buildEmailReviewTelegramText({
      status: "pending",
      transactionType: transaction.transactionType,
      amount: transaction.amount,
      merchant: transaction.merchantNormalized,
      category: transaction.category,
      transactionDate: transaction.transactionDate,
      timeZone: validated.rawPayload.reviewContext.timeZone,
      originalTransactionDate:
        validated.rawPayload.reviewContext.originalTransactionDate,
    });
    const watchdog = this.emptyTransactionWatchdogResponse();

    return {
      status: "pending",
      transaction,
      telegramText,
      notifications: watchdog.notifications,
      ...(watchdog.watchdog ? { watchdog: watchdog.watchdog } : {}),
      actions: this.buildEmailReviewActions(transaction.id),
      replyMarkup: this.buildEmailReviewReplyMarkup(transaction.id),
    };
  }

  private async findTelegramUserByTelegramId(
    telegramUserId: string,
  ): Promise<TelegramUserRow | undefined> {
    const result = await this.database.query<TelegramUserRow>(
      `
        SELECT id, telegram_id, timezone
        FROM telegram_users
        WHERE telegram_id = $1
        LIMIT 1
      `,
      [telegramUserId],
    );

    return result.rows[0];
  }

  private async startManageFlow(input: {
    userId: string;
    action: "edit" | "delete";
    target: TransactionManageTargetDto | null;
    changes: ManageStateData["changes"];
    stateStore: TransactionHandleStateStore;
  }): Promise<TransactionManageHandleResponseDto> {
    const candidates = await this.findManageCandidates(
      input.userId,
      input.target,
    );

    if (candidates.length === 0) {
      await input.stateStore.resetState({ userId: input.userId });
      return this.manageResponse({
        ok: true,
        status: "not_found",
        message: "I could not find that transaction. Please be more specific.",
      });
    }

    if (candidates.length === 1) {
      const before = candidates[0];
      const stateData: ManageStateData = {
        action: input.action,
        transaction_id: before.id,
        before,
        changes: input.action === "edit" ? input.changes : undefined,
      };

      await this.upsertManageState(
        input.stateStore,
        input.userId,
        "confirm_action",
        stateData,
      );

      return this.manageResponse({
        ok: true,
        status: "needs_confirmation",
        message: this.buildManageConfirmationMessage(stateData),
        replyMarkup: this.buildManageConfirmMarkup(),
        stateName: "confirm_action",
        stateData,
      });
    }

    const stateData: ManageStateData = {
      action: input.action,
      candidates,
      changes: input.action === "edit" ? input.changes : undefined,
    };

    await this.upsertManageState(
      input.stateStore,
      input.userId,
      "select_transaction",
      stateData,
    );

    return this.manageResponse({
      ok: true,
      status: "needs_selection",
      message: "I found several transactions. Pick one:",
      replyMarkup: this.buildManageSelectionMarkup(candidates),
      stateName: "select_transaction",
      stateData,
    });
  }

  private async handleManageSelection(
    userId: string,
    index: number | undefined,
    stateStore: TransactionHandleStateStore,
  ): Promise<TransactionManageHandleResponseDto> {
    const state = await this.readManageState(userId, stateStore);

    if (state.expired) {
      await stateStore.resetState({ userId });
      return this.manageExpired();
    }

    const stateData = this.asManageStateData(state.stateData);
    const candidate = index ? stateData.candidates?.[index - 1] : undefined;

    if (
      state.stateName !== "select_transaction" ||
      (stateData.action !== "edit" && stateData.action !== "delete") ||
      !candidate
    ) {
      return this.manageInvalid(
        "This selection is no longer valid. Please start again.",
      );
    }

    const nextStateData: ManageStateData = {
      action: stateData.action,
      transaction_id: candidate.id,
      before: candidate,
      changes: stateData.action === "edit" ? stateData.changes : undefined,
    };

    await this.upsertManageState(
      stateStore,
      userId,
      "confirm_action",
      nextStateData,
    );

    return this.manageResponse({
      ok: true,
      status: "needs_confirmation",
      message: this.buildManageConfirmationMessage(nextStateData),
      replyMarkup: this.buildManageConfirmMarkup(),
      stateName: "confirm_action",
      stateData: nextStateData,
    });
  }

  private async handleManageConfirmation(
    userId: string,
    stateStore: TransactionHandleStateStore,
  ): Promise<TransactionManageHandleResponseDto> {
    const state = await this.readManageState(userId, stateStore);

    if (state.expired) {
      await stateStore.resetState({ userId });
      return this.manageExpired();
    }

    const stateData = this.asManageStateData(state.stateData);
    const transactionId = this.cleanString(stateData.transaction_id);
    const transaction = transactionId
      ? await this.findTransaction(transactionId, userId)
      : undefined;

    if (
      state.stateName !== "confirm_action" ||
      (stateData.action !== "edit" && stateData.action !== "delete") ||
      !transactionId ||
      !transaction
    ) {
      await stateStore.resetState({ userId });
      return this.manageInvalid(
        "This action is no longer valid. Please start again.",
      );
    }

    if (stateData.action === "edit") {
      await this.applyManageEdit(
        transaction,
        stateData.changes ?? {},
      );
      await stateStore.resetState({ userId });
      const updated = this.applyManageChangesToSnapshot(
        this.snapshotManageTransaction(transaction),
        stateData.changes ?? {},
      );
      const watchdog = await this.evaluateTransactionWatchdog(transactionId);

      return this.manageResponse({
        ok: true,
        status: "completed",
        message: this.appendWatchdogMessage(
          `Updated.\n\n${this.manageTransactionLine(updated)}`,
          watchdog,
        ),
        data: { transaction: updated, notifications: watchdog.notifications },
      });
    }

    await this.rejectManageTransaction(transactionId, userId);
    await this.updateEmailImportStatus(transaction, "rejected");
    await stateStore.resetState({ userId });
    const deleted = this.snapshotManageTransaction({
      ...transaction,
      status: "rejected",
    });

    return this.manageResponse({
      ok: true,
      status: "completed",
      message: `Deleted.\n\n${this.manageTransactionLine(deleted)}`,
      data: { transaction: deleted },
    });
  }

  private async findManageCandidates(
    userId: string,
    target: TransactionManageTargetDto | null,
  ): Promise<ManageTransactionSnapshot[]> {
    const values: Array<string | number> = [userId];
    const filters = [
      "user_id::text = $1",
      "COALESCE(status, '') <> 'rejected'",
    ];
    const targetId =
      target?.id === null || target?.id === undefined
        ? undefined
        : this.cleanString(String(target.id));

    if (targetId) {
      values.push(targetId);
      filters.push(`id::text = $${values.length}`);
    } else {
      const merchant = this.cleanString(target?.merchant ?? undefined);
      const category = this.cleanString(target?.category ?? undefined);
      const amount =
        target?.amount === null || target?.amount === undefined
          ? null
          : this.normalizeAmount(target.amount);

      if (merchant) {
        values.push(`%${merchant.toLowerCase()}%`);
        filters.push(
          `(lower(COALESCE(merchant, '')) LIKE $${values.length} OR lower(COALESCE(merchant_normalized, '')) LIKE $${values.length})`,
        );
      }

      if (category) {
        values.push(category);
        filters.push(
          `lower(COALESCE(category, '')) = lower($${values.length})`,
        );
      }

      if (amount && amount > 0) {
        values.push(amount);
        filters.push(`amount::numeric = $${values.length}`);
      }

      if (!target?.period || target.period === "recent") {
        filters.push("transaction_date >= NOW() - INTERVAL '30 days'");
      }
    }

    const result = await this.database.query<TransactionRow>(
      `
        SELECT
          id,
          user_id,
          transaction_type,
          amount,
          merchant,
          merchant_normalized,
          category,
          transaction_date,
          notes,
          status,
          source,
          raw_payload,
          created_at
        FROM transactions
        WHERE ${filters.join("\n          AND ")}
        ORDER BY transaction_date DESC NULLS LAST, created_at DESC NULLS LAST
        LIMIT 5
      `,
      values,
    );

    return result.rows.map((row) => this.snapshotManageTransaction(row));
  }

  private validateManageChanges(
    changes: TransactionManageChangesDto | null | undefined,
  ): ManageStateData["changes"] | null {
    if (!changes || typeof changes !== "object") {
      return null;
    }

    const validated: ManageStateData["changes"] = {};

    if (changes.amount !== undefined && changes.amount !== null) {
      const amount = this.normalizeAmount(changes.amount);

      if (amount <= 0) {
        return null;
      }

      validated.amount = amount;
    }

    for (const key of ["merchant", "merchant_normalized", "notes"] as const) {
      if (changes[key] !== undefined) {
        validated[key] = this.cleanString(changes[key] ?? undefined) ?? null;
      }
    }

    if (changes.category !== undefined) {
      const category = this.cleanString(changes.category ?? undefined);

      if (!category) {
        return null;
      }

      validated.category = category;
    }

    if (
      changes.transaction_type !== undefined &&
      changes.transaction_type !== null
    ) {
      const transactionType = this.cleanString(
        changes.transaction_type,
      )?.toLowerCase();

      if (
        transactionType !== "expense" &&
        transactionType !== "income" &&
        transactionType !== "transfer" &&
        transactionType !== "reversal"
      ) {
        return null;
      }

      validated.transaction_type = transactionType;
    }

    if (
      changes.transaction_date !== undefined &&
      changes.transaction_date !== null
    ) {
      const transactionDate = this.cleanString(changes.transaction_date);
      const date = transactionDate ? new Date(transactionDate) : null;

      if (!date || Number.isNaN(date.getTime())) {
        return null;
      }

      validated.transaction_date = transactionDate;
    }

    return Object.keys(validated).length > 0 ? validated : null;
  }

  private async applyManageEdit(
    transaction: TransactionRow,
    changes: ManageStateData["changes"],
  ): Promise<void> {
    const allowedColumns: Record<string, string> = {
      amount: "amount",
      merchant: "merchant",
      merchant_normalized: "merchant_normalized",
      category: "category",
      transaction_date: "transaction_date",
      transaction_type: "transaction_type",
      notes: "notes",
    };
    const entries = Object.entries(changes ?? {}).filter(
      ([key]) => allowedColumns[key],
    );

    if (entries.length === 0) {
      throw new BadRequestException("changes are required");
    }

    const values: unknown[] = [];
    const assignments = entries.map(([key, value], index) => {
      values.push(
        key === "transaction_date"
          ? new Date(String(value)).toISOString()
          : value,
      );
      return `${allowedColumns[key]} = $${index + 1}`;
    });
    const rawPayload = this.readRecord(transaction.raw_payload);
    const clearsAiProposal =
      transaction.source === "email" &&
      transaction.status === "pending" &&
      rawPayload.parserSource === "ai" &&
      EMAIL_MATERIAL_KEYS.some((key) => key in (changes ?? {}));

    if (clearsAiProposal) {
      const originalTransactionDate = this.cleanString(
        changes?.transaction_date,
      );
      const reviewContext = this.readRecord(rawPayload.reviewContext);
      values.push({
        ...rawPayload,
        ...(originalTransactionDate
          ? {
              reviewContext: {
                ...reviewContext,
                timeZone: this.cleanString(reviewContext.timeZone) ?? null,
                originalTransactionDate,
              },
            }
          : {}),
        validatedTemplate: null,
      });
      assignments.push(`raw_payload = $${values.length}`);
    }

    values.push(String(transaction.id), String(transaction.user_id));

    await this.database.withTransaction(async (client) => {
      const edit = await client.query<{ id: string | number }>(
        `
          UPDATE transactions
          SET ${assignments.join(", ")},
              updated_at = now()
          WHERE id = $${values.length - 1}
            AND user_id = $${values.length}
            ${
              clearsAiProposal
                ? `
            AND status = 'pending'
            AND source = 'email'
            AND raw_payload ->> 'parserSource' = 'ai'`
                : ""
            }
          RETURNING id
        `,
        values,
      );
      if (clearsAiProposal && !edit.rows[0]) {
        throw new BadRequestException(
          "transaction changed before the edit completed",
        );
      }
      await this.disableLearnedTemplateAfterMaterialEdit(
        transaction,
        changes,
        (text, queryValues) => client.query(text, queryValues),
      );
    });
  }

  private async rejectManageTransaction(
    transactionId: string,
    userId: string,
  ): Promise<void> {
    await this.database.query(
      `
        UPDATE transactions
        SET status = 'rejected',
            updated_at = now()
        WHERE id::text = $1
          AND user_id::text = $2
      `,
      [transactionId, userId],
    );
  }

  private async readManageState(
    userId: string,
    stateStore: TransactionHandleStateStore,
  ): Promise<{
    stateName: string;
    stateData: unknown;
    expired: boolean;
  }> {
    const state = stateStore.getState
      ? await stateStore.getState(userId)
      : { stateName: "idle", stateData: {}, expiresAt: null };
    const expired = Boolean(
      state.expiresAt && new Date(state.expiresAt).getTime() <= Date.now(),
    );

    return {
      stateName: state.stateName,
      stateData: state.stateData,
      expired,
    };
  }

  private async upsertManageState(
    stateStore: TransactionHandleStateStore,
    userId: string,
    stateName: Exclude<TransactionManageStateName, "idle">,
    stateData: ManageStateData,
  ): Promise<void> {
    await stateStore.upsertState?.({
      userId,
      stateName,
      stateData,
      expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    });
  }

  private asManageStateData(value: unknown): ManageStateData {
    if (!value || typeof value !== "object") {
      return {};
    }

    return value as ManageStateData;
  }

  private parseManageCallback(
    text: string | undefined,
  ):
    | { action: "select"; index?: number }
    | { action: "confirm" | "cancel" | "invalid" | null } {
    const value = this.cleanString(text);

    if (!value || !value.startsWith("veyra_tx_manage:")) {
      return { action: null };
    }

    if (value === "veyra_tx_manage:confirm") {
      return { action: "confirm" };
    }

    if (value === "veyra_tx_manage:cancel") {
      return { action: "cancel" };
    }

    const select = /^veyra_tx_manage:select:(\d+)$/.exec(value);

    if (select) {
      return {
        action: "select",
        index: Number(select[1]),
      };
    }

    return { action: "invalid" };
  }

  private snapshotManageTransaction(
    row: TransactionRow,
  ): ManageTransactionSnapshot {
    const transactionType = this.cleanString(
      row.transaction_type,
    )?.toLowerCase();

    return {
      id: String(row.id),
      user_id: String(row.user_id),
      transaction_type:
        transactionType === "income" ||
        transactionType === "transfer" ||
        transactionType === "reversal"
          ? transactionType
          : "expense",
      amount: this.normalizeAmount(row.amount),
      merchant: row.merchant,
      merchant_normalized: row.merchant_normalized,
      category: row.category,
      transaction_date: this.formatNullableTimestamp(row.transaction_date),
      notes: row.notes ?? null,
      status: row.status,
    };
  }

  private formatNullableTimestamp(
    value: string | Date | null | undefined,
  ): string | null {
    if (!value) {
      return null;
    }

    if (value instanceof Date) {
      return value.toISOString();
    }

    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toISOString();
  }

  private buildManageSelectionMarkup(
    candidates: ManageTransactionSnapshot[],
  ): TelegramReplyMarkupDto {
    return {
      inline_keyboard: [
        ...candidates.map((candidate, index) => [
          {
            text: this.telegramSafeButtonLabel(
              `${index + 1}. ${this.manageCandidateLabel(candidate)}`,
            ),
            callback_data: `veyra_tx_manage:select:${index + 1}`,
          },
        ]),
        [
          {
            text: "Cancel",
            callback_data: "veyra_tx_manage:cancel",
          },
        ],
      ],
    };
  }

  private buildManageConfirmMarkup(): TelegramReplyMarkupDto {
    return {
      inline_keyboard: [
        [
          {
            text: "Confirm",
            callback_data: "veyra_tx_manage:confirm",
          },
          {
            text: "Cancel",
            callback_data: "veyra_tx_manage:cancel",
          },
        ],
      ],
    };
  }

  private buildManageConfirmationMessage(stateData: ManageStateData): string {
    if (!stateData.before) {
      return "Confirm?";
    }

    if (stateData.action === "delete") {
      return [
        "Confirm delete?",
        "",
        this.manageTransactionLine(stateData.before),
        "",
        "This will mark it as rejected.",
      ].join("\n");
    }

    return [
      "Confirm edit?",
      "",
      "Before:",
      this.manageTransactionLine(stateData.before),
      "",
      "After:",
      this.manageTransactionLine(
        this.applyManageChangesToSnapshot(
          stateData.before,
          stateData.changes ?? {},
        ),
      ),
    ].join("\n");
  }

  private applyManageChangesToSnapshot(
    before: ManageTransactionSnapshot,
    changes: ManageStateData["changes"],
  ): ManageTransactionSnapshot {
    return {
      ...before,
      amount:
        typeof changes?.amount === "number" ? changes.amount : before.amount,
      merchant:
        typeof changes?.merchant === "string" || changes?.merchant === null
          ? changes.merchant
          : before.merchant,
      merchant_normalized:
        typeof changes?.merchant_normalized === "string" ||
        changes?.merchant_normalized === null
          ? changes.merchant_normalized
          : before.merchant_normalized,
      category:
        typeof changes?.category === "string" || changes?.category === null
          ? changes.category
          : before.category,
      transaction_date:
        typeof changes?.transaction_date === "string"
          ? changes.transaction_date
          : before.transaction_date,
      transaction_type:
        changes?.transaction_type === "expense" ||
        changes?.transaction_type === "income" ||
        changes?.transaction_type === "transfer" ||
        changes?.transaction_type === "reversal"
          ? changes.transaction_type
          : before.transaction_type,
      notes:
        typeof changes?.notes === "string" || changes?.notes === null
          ? changes.notes
          : before.notes,
    };
  }

  private manageCandidateLabel(candidate: ManageTransactionSnapshot): string {
    const name =
      candidate.merchant_normalized ??
      candidate.merchant ??
      candidate.category ??
      this.manageShortDate(candidate.transaction_date);

    return `${name} — ${this.formatCurrency(this.normalizeAmount(candidate.amount))}`;
  }

  private manageTransactionLine(
    transaction: ManageTransactionSnapshot,
  ): string {
    return [
      transaction.merchant_normalized ?? transaction.merchant ?? "Unknown",
      transaction.category ?? "Uncategorized",
      this.formatCurrency(this.normalizeAmount(transaction.amount)),
    ].join(" — ");
  }

  private manageShortDate(value: string | null): string {
    if (!value) {
      return "Transaction";
    }

    const date = new Date(value);

    if (Number.isNaN(date.getTime())) {
      return "Transaction";
    }

    return date.toLocaleDateString("en-GB", {
      day: "numeric",
      month: "short",
      timeZone: "Asia/Jakarta",
    });
  }

  private manageResponse(input: {
    ok: boolean;
    status: TransactionManageHandleResponseDto["status"];
    message: string;
    replyMarkup?: TelegramReplyMarkupDto | null;
    stateName?: TransactionManageStateName;
    stateData?: ManageStateData;
    data?: Record<string, unknown>;
  }): TransactionManageHandleResponseDto {
    return {
      ok: input.ok,
      status: input.status,
      message: input.message,
      reply_markup: input.replyMarkup ?? null,
      state: {
        state_name: input.stateName ?? "idle",
        state_data: (input.stateData ?? {}) as Record<string, unknown>,
      },
      data: input.data ?? {},
    };
  }

  private manageInvalid(message: string): TransactionManageHandleResponseDto {
    return this.manageResponse({
      ok: false,
      status: "invalid",
      message,
    });
  }

  private manageExpired(): TransactionManageHandleResponseDto {
    return this.manageResponse({
      ok: false,
      status: "invalid",
      message: "This edit/delete session expired. Please start again.",
    });
  }

  private validateEmailReviewRequest(
    request: EmailTransactionResolveReviewRequestDto,
    userId: string,
    timeZone: string | null,
  ): ValidatedEmailReview {
    const email = request.email;

    if (!email || typeof email !== "object") {
      throw new BadRequestException("email is required");
    }

    const messageId = this.cleanString(email.messageId);
    const from = this.cleanString(email.from);
    const subject = this.cleanString(email.subject);
    const body = normalizeEmailBody({
      emailText: email.emailText,
      emailHtml: email.emailHtml,
      htmlToText: (html) => convert(html, { wordwrap: false }),
    });

    if (!messageId) {
      throw new BadRequestException("email.messageId is required");
    }

    if (!from) {
      throw new BadRequestException("email.from is required");
    }

    if (!subject) {
      throw new BadRequestException("email.subject is required");
    }

    if (!body.text) {
      throw new BadRequestException("email body is required");
    }

    const reviewToken = this.cleanString(request.reviewToken);

    if (!reviewToken) {
      throw new BadRequestException("reviewToken is required");
    }

    if (reviewToken !== messageId) {
      throw new BadRequestException(
        "reviewToken must match email.messageId",
      );
    }

    const validatedEmail = { ...email, messageId, from, subject };
    const candidate = request.transactionCandidate;
    const resolution = request.resolution;
    const errorReason = this.cleanString(request.aiError);
    const candidateMode =
      request.isTransaction === true ||
      candidate !== undefined ||
      resolution !== undefined ||
      request.templateProposal !== undefined;
    const resultModeCount = [
      Boolean(errorReason),
      request.isTransaction === false,
      candidateMode,
    ].filter(Boolean).length;

    if (resultModeCount > 1) {
      throw new BadRequestException("AI result modes are mutually exclusive");
    }

    if (errorReason) {
      return {
        kind: "failure",
        userId,
        email: validatedEmail,
        errorReason,
      };
    }

    if (request.isTransaction === false) {
      if (candidate || resolution || request.templateProposal) {
        throw new BadRequestException(
          "isTransaction false cannot include an AI review result",
        );
      }

      return {
        kind: "non_transaction",
        userId,
        email: validatedEmail,
      };
    }

    if (!candidate || typeof candidate !== "object") {
      throw new BadRequestException("transactionCandidate is required");
    }

    if (!resolution || typeof resolution !== "object") {
      throw new BadRequestException("resolution is required");
    }

    const source = this.cleanString(candidate.source)?.toLowerCase();

    if (source !== "email") {
      throw new BadRequestException(
        "transactionCandidate.source must be email",
      );
    }

    if (/[-−]/u.test(String(candidate.amount))) {
      throw new BadRequestException("amount must be positive");
    }

    const amount = this.normalizeAmount(candidate.amount);

    if (amount <= 0) {
      throw new BadRequestException("amount must be positive");
    }

    const transactionDate = this.cleanString(candidate.transactionDate);

    if (!transactionDate) {
      throw new BadRequestException("transactionDate is required");
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
      "Unknown";
    const merchantNormalized =
      this.cleanString(candidate.merchantNormalized) ?? merchant;
    const category = this.cleanString(resolution.category);

    if (!category) {
      throw new BadRequestException("resolution.category is required");
    }

    const templateValidation = request.templateProposal
      ? validateEmailTemplateProposal(
          {
            email: validatedEmail,
            text: body.text,
            normalizedText: normalizeEmailWhitespace(body.text),
            bodySource: body.source,
            bodyWarnings: body.warnings,
          },
          request.templateProposal,
        )
      : null;
    const retainedTemplate =
      templateValidation?.ok &&
      this.emailTemplateMatchesCandidate(
        templateValidation.parsed,
        {
          amount,
          merchant,
          transactionDate: this.normalizeTransactionDate(transactionDate),
          transactionType,
        },
      )
        ? templateValidation
        : null;

    return {
      kind: "candidate",
      userId,
      email: validatedEmail,
      transactionId: this.cleanString(request.transactionId) ?? null,
      candidate: {
        ...candidate,
        source: "email",
        transactionType,
        amount,
        merchant,
        merchantNormalized,
        transactionDate: this.normalizeTransactionDate(transactionDate),
      },
      resolution: {
        ...resolution,
        category,
        confidence: this.normalizeConfidence(resolution.confidence),
      },
      rawPayload: {
        email: {
          messageId,
          from,
          authentication: email.authentication ?? null,
        },
        parserSource: "ai",
        reviewContext: {
          timeZone,
          originalTransactionDate: transactionDate,
        },
        validatedTemplate: retainedTemplate
          ? {
              fingerprint: retainedTemplate.fingerprint,
              proposal: retainedTemplate.proposal,
            }
          : null,
      },
    };
  }

  private emailTemplateMatchesCandidate(
    parsed: ParsedEmailTransactionDto,
    candidate: {
      amount: number;
      merchant: string;
      transactionDate: string;
      transactionType: NormalizedTransactionType;
    },
  ): boolean {
    const parsedDate = parsed.transactionDate
      ? new Date(parsed.transactionDate).getTime()
      : Number.NaN;
    const candidateDate = new Date(candidate.transactionDate).getTime();

    return (
      parsed.amount === candidate.amount &&
      this.normalizeComparableText(parsed.merchant) ===
        this.normalizeComparableText(candidate.merchant) &&
      !Number.isNaN(parsedDate) &&
      parsedDate === candidateDate &&
      parsed.type === candidate.transactionType
    );
  }

  private normalizeComparableText(value: string | null): string {
    return normalizeEmailWhitespace(value ?? "").toLowerCase();
  }

  private async saveEmailReviewTransaction(input: {
    userId: string;
    transactionId: string | null;
    messageId: string;
    candidate: ValidatedEmailCandidateReview["candidate"] & {
      category: string;
    };
    confidence: number;
    rawPayload: ValidatedEmailCandidateReview["rawPayload"];
  }): Promise<
    NonNullable<EmailTransactionResolveReviewResponseDto["transaction"]>
  > {
    const values = [
      input.userId,
      input.candidate.transactionType,
      input.candidate.amount,
      input.candidate.merchant,
      input.candidate.merchantNormalized,
      input.candidate.category,
      input.candidate.transactionDate,
      this.cleanString(input.candidate.description) ?? null,
      "pending",
      input.confidence,
      input.rawPayload,
    ];

    if (!input.transactionId) {
      return this.database.withTransaction(async (client) => {
        const importResult = await client.query<ExistingImportRow>(
          `
            SELECT id, transaction_id, status
            FROM transaction_imports
            WHERE user_id = $1
              AND source = 'email'
              AND source_reference = $2
              AND (
                status IN ('needs_ai', 'needs_review')
                OR (status = 'pending' AND transaction_id IS NOT NULL)
              )
            LIMIT 1
            FOR UPDATE
          `,
          [input.userId, input.messageId],
        );
        const emailImport = importResult.rows[0];

        if (!emailImport) {
          throw new BadRequestException("email import was not found");
        }

        if (emailImport.transaction_id !== null) {
          const existing = await client.query<EmailReviewTransactionRow>(
            `
              SELECT id,
                     user_id,
                     transaction_type,
                     amount,
                     merchant,
                     merchant_normalized,
                     category,
                     transaction_date,
                     status,
                     confidence
              FROM transactions
              WHERE id = $1
                AND user_id = $2
                AND source = 'email'
                AND status = 'pending'
              LIMIT 1
            `,
            [String(emailImport.transaction_id), input.userId],
          );
          const existingTransaction = existing.rows[0];

          if (!existingTransaction) {
            throw new BadRequestException(
              "import-linked pending transaction was not found",
            );
          }

          return this.mapEmailReviewTransaction(existingTransaction);
        }

        const inserted = await client.query<InsertedTransactionRow>(
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
          values,
        );
        const insertedId = inserted.rows[0]?.id;

        if (insertedId === undefined) {
          throw new BadRequestException("pending email transaction save failed");
        }

        const attached = await client.query<InsertedImportRow>(
          `
            UPDATE transaction_imports
            SET transaction_id = $1,
                status = 'pending',
                raw_payload = $2
            WHERE id = $3
              AND transaction_id IS NULL
            RETURNING id
          `,
          [insertedId, input.rawPayload, String(emailImport.id)],
        );

        if (!attached.rows[0]) {
          throw new BadRequestException("email import attachment failed");
        }

        return this.buildEmailReviewTransaction(input, insertedId);
      });
    }

    const correctionValues = [
      input.candidate.transactionType,
      input.candidate.amount,
      input.candidate.merchant,
      input.candidate.merchantNormalized,
      input.candidate.category,
      input.candidate.transactionDate,
      this.cleanString(input.candidate.description) ?? null,
      input.confidence,
      input.rawPayload,
      input.transactionId,
      input.userId,
      input.messageId,
    ];
    const result = await this.database.query<InsertedTransactionRow>(
      `
        UPDATE transactions AS transaction
        SET transaction_type = $1,
            amount = $2,
            merchant = $3,
            merchant_normalized = $4,
            category = $5,
            transaction_date = $6,
            notes = $7,
            confidence = $8,
            raw_payload = $9,
            updated_at = now()
        FROM transaction_imports AS email_import
        WHERE transaction.id = $10
          AND transaction.user_id = $11
          AND transaction.source = 'email'
          AND transaction.status = 'pending'
          AND email_import.transaction_id = transaction.id
          AND email_import.user_id = transaction.user_id
          AND email_import.source = 'email'
          AND email_import.source_reference = $12
          AND email_import.status = 'pending'
        RETURNING transaction.id
      `,
      correctionValues,
    );
    const updatedId = result.rows[0]?.id;

    if (updatedId === undefined) {
      throw new BadRequestException("pending email transaction save failed");
    }

    return this.buildEmailReviewTransaction(input, updatedId);
  }

  private buildEmailReviewTransaction(
    input: {
      userId: string;
      candidate: ValidatedEmailCandidateReview["candidate"] & {
        category: string;
      };
      confidence: number;
    },
    transactionId: string | number,
  ): NonNullable<EmailTransactionResolveReviewResponseDto["transaction"]> {
    return {
      id: String(transactionId),
      userId: input.userId,
      transactionType: input.candidate.transactionType,
      amount: input.candidate.amount,
      merchant: input.candidate.merchant,
      merchantNormalized: input.candidate.merchantNormalized,
      category: input.candidate.category,
      transactionDate: input.candidate.transactionDate,
      source: "email",
      status: "pending",
      confidence: input.confidence,
    };
  }

  private mapEmailReviewTransaction(
    row: EmailReviewTransactionRow,
  ): NonNullable<EmailTransactionResolveReviewResponseDto["transaction"]> {
    return {
      id: String(row.id),
      userId: String(row.user_id),
      transactionType: row.transaction_type,
      amount: this.normalizeAmount(row.amount),
      merchant: row.merchant,
      merchantNormalized: row.merchant_normalized,
      category: row.category,
      transactionDate:
        row.transaction_date instanceof Date
          ? row.transaction_date.toISOString()
          : this.normalizeTransactionDate(row.transaction_date),
      source: "email",
      status: "pending",
      confidence: this.normalizeConfidence(Number(row.confidence)),
    };
  }

  private async findPendingEmailReviewTransaction(
    transactionId: string,
    userId: string,
    messageId: string,
  ): Promise<PendingEmailReviewRow | undefined> {
    const result = await this.database.query<PendingEmailReviewRow>(
      `
        SELECT transaction.id
        FROM transactions AS transaction
        JOIN transaction_imports AS email_import
          ON email_import.transaction_id = transaction.id
         AND email_import.user_id = transaction.user_id
        WHERE transaction.id = $1
          AND transaction.user_id = $2
          AND transaction.source = 'email'
          AND transaction.status = 'pending'
          AND email_import.source = 'email'
          AND email_import.source_reference = $3
          AND email_import.status = 'pending'
        LIMIT 1
      `,
      [transactionId, userId, messageId],
    );

    return result.rows[0];
  }

  private async recordEmailAiFailure(
    input: Extract<ValidatedEmailReview, { kind: "failure" }>,
  ): Promise<void> {
    const emailImport = await this.database.query<InsertedImportRow>(
      `
        UPDATE transaction_imports
        SET status = 'needs_review',
            raw_payload = raw_payload || jsonb_build_object('aiError', $3::text)
        WHERE user_id = $1
          AND source = 'email'
          AND source_reference = $2
          AND transaction_id IS NULL
          AND status IN ('needs_ai', 'needs_review')
        RETURNING id
      `,
      [input.userId, input.email.messageId, input.errorReason],
    );

    if (!emailImport.rows[0]) {
      throw new BadRequestException(
        "email import is not eligible for AI failure",
      );
    }

    await this.database.query(
      `
        UPDATE email_parse_attempts
        SET status = 'needs_review',
            error_reason = $3
        WHERE user_id = $1
          AND source_reference = $2
          AND status IN ('needs_ai', 'needs_review')
      `,
      [input.userId, input.email.messageId, input.errorReason],
    );
  }

  private async recordEmailNonTransaction(
    input: Extract<ValidatedEmailReview, { kind: "non_transaction" }>,
  ): Promise<void> {
    await this.database.withTransaction(async (client) => {
      const emailImport = await client.query<InsertedImportRow>(
        `
          UPDATE transaction_imports
          SET status = 'ignored_non_transaction',
              raw_payload = raw_payload || jsonb_build_object(
                'aiDecision',
                jsonb_build_object('isTransaction', false)
              )
          WHERE user_id = $1
            AND source = 'email'
            AND source_reference = $2
            AND transaction_id IS NULL
            AND status IN (
              'needs_ai',
              'needs_review',
              'ignored_non_transaction'
            )
          RETURNING id
        `,
        [input.userId, input.email.messageId],
      );

      if (!emailImport.rows[0]) {
        throw new BadRequestException(
          "email import is not eligible for non-transaction review",
        );
      }

      await client.query(
        `
          UPDATE email_parse_attempts
          SET status = 'ignored_non_transaction',
              error_reason = NULL
          WHERE user_id = $1
            AND source_reference = $2
            AND status IN (
              'needs_ai',
              'needs_review',
              'ignored_non_transaction'
            )
          RETURNING id
        `,
        [input.userId, input.email.messageId],
      );
    });
  }

  private buildEmailReviewReplyMarkup(
    transactionId: string,
  ): TelegramReplyMarkupDto {
    return {
      inline_keyboard: [
        [
          {
            text: "Save",
            callback_data: this.saveTransactionCallbackData(transactionId),
          },
          {
            text: "Edit Details",
            callback_data: `edit_email_details:${transactionId}`,
          },
        ],
        [
          {
            text: "Change Category",
            callback_data: this.changeCategoriesCallbackData(transactionId),
          },
          {
            text: "Cancel",
            callback_data: this.cancelTransactionCallbackData(transactionId),
          },
        ],
      ],
    };
  }

  private buildEmailReviewTelegramText(input: {
    status: "confirmed" | "pending" | "needs_review";
    transactionType: NormalizedTransactionType;
    amount: number;
    merchant: string;
    category: string;
    transactionDate: string;
    timeZone: string | null;
    originalTransactionDate: string;
    reason?: string;
  }): string {
    const type = `${input.transactionType[0].toUpperCase()}${input.transactionType.slice(1)}`;
    const date = this.formatDateForTelegram(
      input.transactionDate,
      input.timeZone,
      input.originalTransactionDate,
    );

    if (input.status === "confirmed") {
      return this.formatConfirmationHtml([
        "Transaction recorded",
        "",
        `Type: ${type}`,
        `Amount: ${this.formatCurrency(input.amount)}`,
        `Merchant: ${input.merchant}`,
        `Category: ${input.category}`,
        `Date: ${date}`,
        "Source: Email",
      ]);
    }

    const lines = [
      input.status === "pending"
        ? "Confirm transaction"
        : "Email transaction needs attention",
      "",
      `Type: ${type}`,
      `Amount: ${this.formatCurrency(input.amount)}`,
      `Merchant: ${input.merchant}`,
      `Category: ${input.category}`,
      `Date: ${date}`,
    ];

    if (input.reason) {
      lines.push(`Reason: ${input.reason}`);
    }

    return this.formatConfirmationHtml(lines);
  }

  private buildEmailReviewActions(
    transactionId: string,
  ): NonNullable<EmailTransactionResolveReviewResponseDto["actions"]> {
    return {
      confirm: {
        action: "save_transaction",
        transactionId,
      },
      cancel: {
        action: "cancel_transaction",
        transactionId,
      },
      changeCategory: {
        action: "change_categories",
        transactionId,
      },
      editDetails: {
        action: "edit_email_details",
        transactionId,
      },
    };
  }

  private async validateEmailTransactionRequest(
    request: EmailTransactionHandleRequestDto,
  ): Promise<EmailTransactionHandleRequestDto & {
    userId: string;
    source: "email";
  }> {
    const telegramUserId = this.cleanString(request.telegramUserId);
    const claimedUserId = this.cleanString(String(request.userId ?? ""));
    const source = this.cleanString(request.source)?.toLowerCase();
    const email = request.email;

    if (!telegramUserId) {
      throw new BadRequestException("telegramUserId is required");
    }

    if (source !== "email") {
      throw new BadRequestException("source must be email");
    }

    if (!email || typeof email !== "object") {
      throw new BadRequestException("email is required");
    }

    const messageId = this.cleanString(email.messageId);
    const from = this.cleanString(email.from);
    const subject = this.cleanString(email.subject);
    const emailText = this.cleanString(email.emailText);
    const emailHtml = this.cleanString(email.emailHtml);

    if (!messageId) {
      throw new BadRequestException("email.messageId is required");
    }

    if (!from) {
      throw new BadRequestException("email.from is required");
    }

    if (!subject) {
      throw new BadRequestException("email.subject is required");
    }

    if (!emailText && !emailHtml) {
      throw new BadRequestException(
        "email.emailText or email.emailHtml is required",
      );
    }

    if (email.date && Number.isNaN(new Date(email.date).getTime())) {
      throw new BadRequestException("email.date must be a valid date");
    }

    const user = await this.findEmailCallerByTelegramId(telegramUserId);

    if (!user) {
      throw new BadRequestException("telegram user was not found");
    }

    const userId = String(user.id);

    if (claimedUserId && claimedUserId !== userId) {
      throw new BadRequestException(
        "userId does not match telegramUserId",
      );
    }

    return {
      telegramUserId,
      userId,
      source: "email",
      email: {
        messageId,
        threadId: this.cleanString(email.threadId),
        from,
        subject,
        date: this.cleanString(email.date),
        emailText: emailText ?? "",
        emailHtml,
        authentication: email.authentication,
      },
    };
  }

  private async findEmailCallerByTelegramId(
    telegramUserId: string,
  ): Promise<TelegramUserRow | undefined> {
    const result = await this.database.query<TelegramUserRow>(
      `
        /* resolve_email_caller */
        SELECT id, telegram_id
        FROM telegram_users
        WHERE telegram_id = $1
        LIMIT 1
      `,
      [telegramUserId],
    );

    return result.rows[0];
  }

  private buildEmailParserInputs(
    request: EmailTransactionHandleRequestDto,
  ): EmailParserInput[] {
    const inputs = [
      this.buildEmailParserInput(request, request.email.emailText, "text", []),
    ];
    const normalizedBody = normalizeEmailBody({
      emailText: request.email.emailText,
      emailHtml: request.email.emailHtml,
      htmlToText: (html) => convert(html, { wordwrap: false }),
    });

    if (
      normalizedBody.source === "html" &&
      normalizedBody.text !== normalizeEmailWhitespace(request.email.emailText)
    ) {
      inputs.push(
        this.buildEmailParserInput(
          request,
          normalizedBody.text,
          normalizedBody.source,
          normalizedBody.warnings,
        ),
      );
    } else if (request.email.emailHtml) {
      const htmlText = normalizeEmailWhitespace(
        convert(request.email.emailHtml, { wordwrap: false }),
      );

      if (
        htmlText &&
        htmlText !== normalizeEmailWhitespace(request.email.emailText)
      ) {
        inputs.push(this.buildEmailParserInput(request, htmlText, "html", []));
      }
    }

    return inputs.filter((input) => input.normalizedText);
  }

  private buildEmailParserInput(
    request: EmailTransactionHandleRequestDto,
    text: string,
    bodySource: EmailParserInput["bodySource"],
    bodyWarnings: string[],
  ): EmailParserInput {
    return {
      email: request.email,
      text,
      normalizedText: normalizeEmailWhitespace(text),
      bodySource,
      bodyWarnings,
    };
  }

  private parseEmail(
    inputs: EmailParserInput[],
  ): EmailParseAttempt | undefined {
    let failedAttempt: EmailParseAttempt | undefined;

    for (const input of inputs) {
      const parser = this.findEmailParser(input);
      const detection = detectEmailProviderAndTemplate({
        from: input.email.from,
        subject: input.email.subject,
        normalizedText: input.normalizedText,
      });

      if (!parser) {
        continue;
      }

      try {
        const parsed = parser.parse(input);
        const reason = this.emailParsedValidationReason(parsed);

        if (!reason) {
          return { parser, input, detection, parsed };
        }

        failedAttempt = { parser, input, detection, parsed, reason };
      } catch (error) {
        failedAttempt = {
          parser,
          input,
          detection,
          reason: error instanceof Error ? error.message : "email parse failed",
        };
      }
    }

    return failedAttempt;
  }

  private async parseLearnedEmail(
    inputs: EmailParserInput[],
    request: EmailTransactionHandleRequestDto & {
      userId: string;
      source: "email";
    },
  ): Promise<EmailParseAttempt | undefined> {
    if (!this.emailParserTemplateRepository) {
      return undefined;
    }

    const templates = await this.emailParserTemplateRepository.findActive(
      request.userId,
      request.email.from.trim().toLowerCase(),
    );

    for (const input of inputs) {
      for (const template of templates) {
        const parsed = parseLearnedEmailTemplate(input, template);

        if (!parsed || this.emailParsedValidationReason(parsed)) {
          continue;
        }

        parsed.raw = {
          ...parsed.raw,
          parserSource: "learned",
          templateId: template.id,
        };

        return {
          input,
          detection: detectEmailProviderAndTemplate({
            from: input.email.from,
            subject: input.email.subject,
            normalizedText: input.normalizedText,
          }),
          parsed,
          learnedTemplateId: template.id,
        };
      }
    }

    return undefined;
  }

  private findEmailParser(
    input: EmailParserInput,
  ): EmailTransactionParser | undefined {
    return this.emailParsers.find((parser) => parser.canParse(input));
  }

  private detectEmailProviderFromInputs(
    inputs: EmailParserInput[],
  ): EmailTemplateDetection {
    for (const input of inputs) {
      const detection = detectEmailProviderAndTemplate({
        from: input.email.from,
        subject: input.email.subject,
        normalizedText: input.normalizedText,
      });

      if (detection.provider !== "unknown") {
        return detection;
      }
    }

    return {
      provider: "unknown",
      templateKey: null,
      confidence: 0,
      matchedSignals: [],
    };
  }

  private emailParsedValidationReason(
    parsed: ParsedEmailTransactionDto,
  ): string | null {
    if (!parsed.isTransaction) {
      return "email is not a transaction";
    }

    if (!parsed.emailId) {
      return "email id is required";
    }

    if (!parsed.amount || parsed.amount <= 0) {
      return "amount must exist and be positive";
    }

    if (
      parsed.type !== "expense" &&
      parsed.type !== "income" &&
      parsed.type !== "transfer" &&
      parsed.type !== "reversal"
    ) {
      return "transaction type is unsupported";
    }

    if (
      !Number.isInteger(parsed.confidence) ||
      parsed.confidence < 0 ||
      parsed.confidence > 100
    ) {
      return "confidence must be an integer from 0 to 100";
    }

    return null;
  }

  private isUnknownMerchant(merchant: string): boolean {
    const normalized = merchant.trim().toLowerCase();

    return normalized === "unknown";
  }

  private async recordUnconfirmedEmailAttempt(input: {
    request: EmailTransactionHandleRequestDto & {
      userId: string;
      source: "email";
    };
    status: Exclude<EmailTransactionHandleStatus, "confirmed" | "duplicate">;
    provider: string | null;
    templateKey: string | null;
    reason: string;
    parsed: ParsedEmailTransactionDto | undefined;
    detection: EmailTemplateDetection;
    aiRequest?: EmailTransactionHandleResponseDto["aiRequest"];
  }): Promise<EmailTransactionHandleResponseDto> {
    const inserted = await this.createTransactionImport({
      userId: input.request.userId,
      sourceReference: input.request.email.messageId,
      status: input.status,
      rawPayload: {
        ...this.buildEmailRawPayload(input.request, input.parsed),
        ...(input.aiRequest ? { aiRequest: input.aiRequest } : {}),
      },
    });

    if (!inserted) {
      return this.buildEmailResponse({
        status: "duplicate",
        provider: input.provider,
        templateKey: input.templateKey,
        reason: "email message already imported",
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
      detection: input.detection,
    });

    return this.buildEmailResponse({
      status: input.status,
      provider: input.provider,
      templateKey: input.templateKey,
      reason: input.reason,
      parsed: input.parsed,
      aiRequest: input.aiRequest,
    });
  }

  private async findTransactionImport(
    userId: string,
    sourceReference: string,
  ): Promise<ExistingImportRow | undefined> {
    const result = await this.database.query<ExistingImportRow>(
      `
        SELECT id, transaction_id, status, raw_payload
        FROM transaction_imports
        WHERE user_id = $1
          AND source = 'email'
          AND source_reference = $2
        LIMIT 1
      `,
      [userId, sourceReference],
    );

    return result.rows[0];
  }

  private async resumeExistingEmailImport(
    request: EmailTransactionHandleRequestDto & {
      userId: string;
      source: "email";
    },
    emailImport: ExistingImportRow,
  ): Promise<EmailTransactionHandleResponseDto> {
    if (
      (emailImport.status === "needs_ai" ||
        emailImport.status === "needs_review") &&
      emailImport.transaction_id === null
    ) {
      const rawPayload = this.readRecord(emailImport.raw_payload);
      const storedAiRequest = this.readRecord(rawPayload.aiRequest);
      const parser = this.readRecord(rawPayload.parser);
      const reason =
        storedAiRequest.reason === "parse_failed"
          ? "parse_failed"
          : "unsupported_template";

      return this.buildEmailResponse({
        status: "needs_ai",
        provider: typeof parser.provider === "string" ? parser.provider : null,
        templateKey:
          typeof parser.templateKey === "string" ? parser.templateKey : null,
        reason: "email requires AI parsing",
        aiRequest: {
          reviewToken: request.email.messageId,
          reason,
        },
      });
    }

    if (
      emailImport.status === "pending" &&
      emailImport.transaction_id !== null
    ) {
      const transaction = await this.findTransaction(
        String(emailImport.transaction_id),
        request.userId,
      );

      if (transaction) {
        const rawPayload = this.readRecord(transaction.raw_payload);
        const validatedTemplate = this.readRecord(rawPayload.validatedTemplate);
        const proposal = this.readRecord(validatedTemplate.proposal);

        return this.buildEmailResponse({
          status: "needs_review",
          provider:
            typeof proposal.provider === "string" ? proposal.provider : null,
          templateKey:
            typeof proposal.templateKey === "string"
              ? proposal.templateKey
              : null,
          reason: "email transaction is awaiting confirmation",
          transaction: this.mapPendingEmailTransaction(transaction),
        });
      }
    }

    return this.buildEmailResponse({
      status: "duplicate",
      provider: null,
      templateKey: null,
      reason: "email message already imported",
    });
  }

  private mapPendingEmailTransaction(
    transaction: TransactionRow,
  ): NonNullable<EmailTransactionHandleResponseDto["transaction"]> {
    const transactionType = this.cleanString(
      transaction.transaction_type,
    )?.toLowerCase();

    return {
      id: String(transaction.id),
      userId: String(transaction.user_id),
      transactionType:
        transactionType === "income" ||
        transactionType === "transfer" ||
        transactionType === "reversal"
          ? transactionType
          : "expense",
      amount: this.normalizeAmount(transaction.amount),
      merchant: transaction.merchant ?? "Unknown",
      merchantNormalized:
        transaction.merchant_normalized ?? transaction.merchant ?? "Unknown",
      category: transaction.category ?? "Uncategorized",
      transactionDate: this.normalizeTransactionDate(
        this.formatNullableTimestamp(transaction.transaction_date) ?? undefined,
      ),
      source: "email",
      status: "pending",
      confidence: this.normalizeConfidence(Number(transaction.confidence ?? 0)),
    };
  }

  private async createTransactionImport(input: {
    userId: string;
    sourceReference: string;
    status: EmailTransactionHandleStatus | "processing";
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
      source: "email";
    };
    status: Exclude<EmailTransactionHandleStatus, "duplicate">;
    provider: string | null;
    templateKey: string | null;
    parsed: ParsedEmailTransactionDto | undefined;
    errorReason: string | null;
    detection: EmailTemplateDetection;
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
        this.buildEmailParsedPayload(input.parsed, {
          bodySource: this.detectBodySource(input.parsed),
          provider: input.detection.provider,
          templateKey: input.detection.templateKey,
          matchedSignals: input.detection.matchedSignals,
          reason: input.errorReason,
        }),
        input.errorReason,
        this.safeEmailBodySample(input.request),
      ],
    );
  }

  private safeEmailBodySample(
    request: EmailTransactionHandleRequestDto,
  ): string {
    const body = normalizeEmailBody({
      emailText: request.email.emailText,
      emailHtml: request.email.emailHtml,
      htmlToText: (html) => convert(html, { wordwrap: false }),
    });

    return body.text.slice(0, 1000);
  }

  private buildEmailParsedPayload(
    parsed: ParsedEmailTransactionDto | undefined,
    diagnostics: {
      bodySource: string | null;
      provider: string | null;
      templateKey: string | null;
      matchedSignals: string[];
      reason: string | null;
    },
  ): Record<string, unknown> {
    const missingFields: string[] = [];

    if (!parsed?.amount) {
      missingFields.push("amount");
    }

    if (!parsed?.merchant) {
      missingFields.push("merchant");
    }

    if (!parsed?.transactionDate) {
      missingFields.push("transactionDate");
    }

    return {
      parsed: parsed ?? null,
      diagnostics: {
        ...diagnostics,
        missingFields,
        amountMatched: Boolean(parsed?.amount),
        dateMatched: Boolean(parsed?.transactionDate),
        merchantMatched: Boolean(parsed?.merchant),
      },
    };
  }

  private detectBodySource(
    parsed: ParsedEmailTransactionDto | undefined,
  ): string | null {
    const bodySource = parsed?.raw.bodySource;

    return typeof bodySource === "string" ? bodySource : null;
  }

  private buildEmailRawPayload(
    request: EmailTransactionHandleRequestDto,
    parsed: ParsedEmailTransactionDto | undefined,
  ): Record<string, unknown> {
    const parserSource =
      parsed?.raw.parserSource ?? (parsed ? "hardcoded" : undefined);
    const templateId = parsed?.raw.templateId;

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
            warnings: parsed.warnings,
          }
        : null,
      parsed: parsed ?? null,
      ...(typeof parserSource === "string" ? { parserSource } : {}),
      ...(typeof templateId === "string" ? { templateId } : {}),
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
        WHERE user_id = $1
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
    if (templateKey === "mandiri-emoney-topup") {
      return "E-Money";
    }

    if (templateKey === "krom-incoming-transfer") {
      return "Income";
    }

    if (templateKey === "krom-outgoing-transfer") {
      return "Transfer";
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
        WHERE user_id = $1
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
      source: "email";
    };
    parsed: ParsedEmailTransactionDto;
    merchant: string;
    merchantNormalized: string;
    category: string;
    transactionDate: string;
    rawPayload: Record<string, unknown>;
  }): Promise<EmailTransactionHandleResponseDto["transaction"] | null> {
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
        throw new BadRequestException("transaction insert failed");
      }

      await client.query(
        `
          UPDATE transaction_imports
          SET transaction_id = $1,
              status = 'confirmed',
              raw_payload = $2
          WHERE id = $3
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
          this.buildEmailParsedPayload(input.parsed, {
            bodySource: this.detectBodySource(input.parsed),
            provider: input.parsed.provider,
            templateKey: input.parsed.templateKey,
            matchedSignals: detectEmailProviderAndTemplate({
              from: input.request.email.from,
              subject: input.request.email.subject,
              normalizedText: normalizeEmailWhitespace(
                input.request.email.emailText,
              ),
            }).matchedSignals,
            reason: null,
          }),
          this.safeEmailBodySample(input.request),
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
        source: "email",
        status: "confirmed",
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
    transaction?: EmailTransactionHandleResponseDto["transaction"];
    watchdog?: TransactionWatchdogResponseDto;
    aiRequest?: EmailTransactionHandleResponseDto["aiRequest"];
  }): EmailTransactionHandleResponseDto {
    return {
      status: input.status,
      provider: input.provider,
      templateKey: input.templateKey,
      reason: input.reason,
      transaction: input.transaction,
      parsed: input.parsed,
      ...(input.aiRequest ? { aiRequest: input.aiRequest } : {}),
      telegram: {
        text: this.appendWatchdogMessage(
          this.buildEmailTelegramText(input),
          input.watchdog,
        ),
        parseMode: "HTML",
      },
      notifications: input.watchdog?.notifications ?? [],
      ...(input.watchdog?.watchdog
        ? { watchdog: input.watchdog.watchdog }
        : {}),
    };
  }

  private buildEmailTelegramText(input: {
    status: EmailTransactionHandleStatus;
    provider: string | null;
    templateKey: string | null;
    reason: string | null;
    parsed?: ParsedEmailTransactionDto;
    transaction?: EmailTransactionHandleResponseDto["transaction"];
  }): string {
    if (input.status === "confirmed" && input.transaction) {
      return this.formatConfirmationHtml([
        "Transaction recorded",
        "",
        `Amount: ${this.formatCurrency(input.transaction.amount)}`,
        `Merchant: ${input.transaction.merchantNormalized}`,
        `Category: ${input.transaction.category}`,
        `Source: ${input.provider ?? "Email"}`,
      ]);
    }

    const lines = [
      "Email transaction needs attention",
      "",
      `Status: ${input.status}`,
      `Provider: ${input.provider ?? "-"}`,
      `Template: ${input.templateKey ?? "-"}`,
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
    const income = request.transactionType === "income";
    const merchant =
      this.cleanString(request.merchantNormalized) ??
      this.cleanString(request.merchant) ??
      (income ? null : "Unknown");
    const category =
      this.cleanString(request.category) ?? (income ? null : "Uncategorized");
    const wallet = this.cleanString(request.wallet) ?? EMPTY_CONFIRMATION_FIELD;
    const notes =
      this.cleanString(request.notes ?? undefined) ?? EMPTY_CONFIRMATION_FIELD;
    const amount = this.normalizeAmount(request.amount);
    const transactionType = request.transactionType;
    const source = this.cleanString(request.source) ?? "manual";
    const format = request.format ?? (source === "email" ? "html" : "plain");

    if (!callbackTransactionId) {
      warnings.push(
        callbackMode === EXPERIMENTAL_CALLBACK_MODE
          ? "callbacks require pendingTransactionId"
          : "callbacks require transactionId",
      );
    }

    const warningLines =
      warnings.length > 0
        ? ["", "Warnings:", ...warnings.map((warning) => `- ${warning}`)]
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
      format === "html"
        ? this.formatConfirmationHtml(textLines)
        : textLines.join("\n");

    return {
      text,
      parseMode: format === "html" ? "HTML" : null,
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
    return this.updateTransactionStatus(request, "confirmed");
  }

  async cancelTransaction(
    request: ConfirmTransactionRequestDto,
  ): Promise<ConfirmTransactionResponseDto> {
    return this.updateTransactionStatus(request, "rejected");
  }

  createPendingReview(
    input: CreatePendingRiskReviewInput,
  ): Promise<TransactionRiskReview> {
    return this.requireRiskReviewRepository().createPendingReview(input);
  }

  async createRegretDetectorReview(
    request: CreateRegretReviewRequestDto,
  ): Promise<CreateRegretReviewResponseDto> {
    const review = await this.createPendingReview({
      userId: request.userId,
      transactionId: request.transactionId,
      riskLevel: request.riskLevel,
      riskScore: request.riskScore,
      riskReasons: request.riskReasons,
      riskMetrics: request.riskMetrics,
    });

    return {
      status: "ok",
      review,
      telegram: {
        text: this.buildLargeTransactionReviewText(review),
        parse_mode: "HTML",
        reply_markup: this.buildWatchdogRiskReplyMarkup(review.id),
      },
    };
  }

  getReviewById(
    reviewId: string | number,
    userId: string | number,
  ): Promise<TransactionRiskReview | null> {
    return this.requireRiskReviewRepository().findById(reviewId, userId);
  }

  resolveAsPlanned(
    reviewId: string | number,
    userId: string | number,
  ): Promise<TransactionRiskReview | null> {
    return this.resolveRiskReview(reviewId, userId, "planned");
  }

  resolveRiskReview(
    reviewId: string | number,
    userId: string | number,
    response: TransactionRiskUserResponse,
    note?: string | null,
  ): Promise<TransactionRiskReview | null> {
    return this.requireRiskReviewRepository().resolve(
      reviewId,
      userId,
      response,
      "resolved",
      note,
    );
  }

  async handleTransactionCallback(
    request: TransactionCallbackHandleRequestDto,
    _stateStore?: TransactionHandleStateStore,
  ): Promise<TransactionCallbackHandleResponseDto> {
    const telegramUserId = this.cleanString(request.telegramUserId);
    const parsed = this.parseTransactionCallbackData(request.callbackData);

    if (!telegramUserId) {
      return this.transactionCallbackError({
        action: parsed.action,
        text: "Invalid callback request.",
        request,
        transactionId: parsed.transactionId,
      });
    }

    const resolvedUserId =
      this.normalizePositiveInteger(request.userId) ??
      (telegramUserId
        ? this.normalizePositiveInteger(
            Number((await this.findTelegramUserByTelegramId(telegramUserId))?.id),
          )
        : undefined);

    const userId = resolvedUserId;

    if (!userId) {
      return this.transactionCallbackError({
        action: parsed.action,
        text: "Invalid callback user.",
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

    if (
      parsed.action === "veyra_risk" &&
      parsed.reviewId &&
      parsed.riskAction
    ) {
      return this.handleRiskCallback({
        request,
        reviewId: parsed.reviewId,
        userId,
        action: parsed.riskAction,
      });
    }

    if (parsed.action === "save_transaction" && parsed.transactionId) {
      const result = await this.confirmTransaction({
        transactionId: String(parsed.transactionId),
        userId: String(userId),
      });

      if (
        result.status === "confirmed" ||
        result.status === "already_confirmed"
      ) {
        return this.transactionCallbackOk({
          action: parsed.action,
          text:
            result.editMessage?.text ??
            "This transaction was already confirmed.",
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

    if (parsed.action === "cancel_transaction" && parsed.transactionId) {
      const result = await this.cancelTransaction({
        transactionId: String(parsed.transactionId),
        userId: String(userId),
      });

      if (
        result.status === "rejected" ||
        result.status === "already_rejected"
      ) {
        return this.transactionCallbackOk({
          action: parsed.action,
          text:
            result.editMessage?.text ??
            "This transaction was already cancelled.",
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

    if (parsed.action === "change_categories" && parsed.transactionId) {
      const result = await this.buildCategoryOptions({
        transactionId: String(parsed.transactionId),
        userId: String(userId),
      });

      if (result.status === "ok") {
        return this.transactionCallbackOk({
          action: parsed.action,
          text: result.text ?? "Choose transaction category",
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

    if (parsed.action === "catid" && parsed.transactionId && parsed.budgetId) {
      const result = await this.setPendingTransactionCategory({
        transactionId: String(parsed.transactionId),
        budgetId: String(parsed.budgetId),
        userId: String(userId),
      });

      if (result.status === "updated") {
        if (parsed.reviewId) {
          await this.requireRiskReviewRepository().resolve(
            parsed.reviewId,
            userId,
            "regret",
            "resolved",
          );
        }

        return this.transactionCallbackOk({
          action: parsed.action,
          text:
            result.editMessage?.text ??
            "Transaction category updated and confirmed.",
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
      text: "Unsupported transaction callback.",
      request,
      transactionId: parsed.transactionId,
    });
  }

  async confirmPendingTransactionExperimental(request: {
    pendingTransactionId: string;
    userId: string;
  }): Promise<{
    status: "confirmed" | "not_found" | "already_resolved";
    transactionId: string | null;
    pendingTransactionId: string;
    summary: ConfirmTransactionSummaryDto | null;
  }> {
    const pendingTransactionId = this.cleanString(request.pendingTransactionId);
    const userId = this.cleanString(request.userId);

    if (!pendingTransactionId) {
      throw new BadRequestException("pendingTransactionId is required");
    }

    if (!userId) {
      throw new BadRequestException("userId is required");
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
          status: "not_found",
          transactionId: null,
          pendingTransactionId,
          summary: null,
        };
      }

      if (pendingTransaction.resolved) {
        return {
          status: "already_resolved",
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
        status: "confirmed",
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
      throw new BadRequestException("userId is required");
    }

    if (!pendingTransactionId && !transactionId) {
      throw new BadRequestException("transactionId is required");
    }

    const transaction = transactionId
      ? await this.findTransaction(transactionId, userId)
      : undefined;
    const pendingTransaction = pendingTransactionId
      ? await this.findPendingTransaction(pendingTransactionId, userId)
      : undefined;

    if (!transaction && !pendingTransaction) {
      return {
        status: "not_found",
        pendingTransactionId: pendingTransactionId ?? "",
        text: null,
        replyMarkup: null,
      };
    }

    if (pendingTransaction?.resolved) {
      return {
        status: "already_resolved",
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
      status: "ok",
      pendingTransactionId: pendingTransaction
        ? String(pendingTransaction.id)
        : (pendingTransactionId ?? ""),
      text: [
        "Choose transaction category",
        "",
        `Merchant: ${
          source?.merchant_normalized ?? source?.merchant ?? "Unknown"
        }`,
        `Amount: ${this.formatCurrency(
          this.normalizeAmount(source?.amount ?? 0),
        )}`,
      ].join("\n"),
      replyMarkup: this.buildCategoryOptionsReplyMarkup(
        pendingTransaction ? String(pendingTransaction.id) : "",
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
      throw new BadRequestException("userId is required");
    }

    if (transactionId || budgetId) {
      return this.setTransactionCategory({
        transactionId,
        budgetId,
        userId,
      });
    }

    if (!pendingTransactionId) {
      throw new BadRequestException("pendingTransactionId is required");
    }

    if (!category) {
      throw new BadRequestException("category must be a supported option");
    }

    const pendingTransaction = await this.findPendingTransaction(
      pendingTransactionId,
      userId,
    );

    if (!pendingTransaction) {
      return {
        status: "not_found",
        pendingTransactionId,
        transactionId: null,
        confirmationPayload: null,
        summary: null,
        editMessage: null,
      };
    }

    if (pendingTransaction.resolved) {
      return {
        status: "already_resolved",
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
      status: "updated",
      pendingTransactionId: String(pendingTransaction.id),
      transactionId: null,
      confirmationPayload: this.buildConfirmationPayload({
        pendingTransactionId: String(pendingTransaction.id),
        userId: String(pendingTransaction.user_id),
        transactionType: pendingTransaction.transaction_type,
        amount: this.normalizeAmount(pendingTransaction.amount),
        merchant: pendingTransaction.merchant ?? "Unknown",
        merchantNormalized: pendingTransaction.merchant_normalized ?? undefined,
        category,
        transactionDate:
          pendingTransaction.transaction_date instanceof Date
            ? pendingTransaction.transaction_date.toISOString()
            : pendingTransaction.transaction_date,
        source: pendingTransaction.source ?? "manual",
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
    const combined = `${normalized ?? ""} ${rawText}`;

    if (/\b(reversal|void|chargeback)\b/.test(combined)) {
      if (normalized && normalized !== "reversal") {
        warnings.push(
          "transactionType mapped to reversal from reversal-like input",
        );
      }

      return "reversal";
    }

    if (/\b(refund|cashback)\b/.test(combined)) {
      warnings.push("refund/cashback input mapped to income");
      return "income";
    }

    if (
      normalized === "expense" ||
      normalized === "income" ||
      normalized === "transfer" ||
      normalized === "reversal"
    ) {
      return normalized;
    }

    throw new BadRequestException(
      "transactionType must be expense, income, transfer, or reversal",
    );
  }

  normalizeAmount(value: number | string): number {
    const normalized =
      typeof value === "number"
        ? value
        : Number(this.normalizeAmountString(value));

    if (!Number.isFinite(normalized)) {
      return 0;
    }

    return Math.abs(normalized);
  }

  normalizeConfidence(value: number | undefined): number {
    if (value === undefined || value === null) {
      throw new BadRequestException("confidence is required");
    }

    const scaled = value >= 0 && value <= 1 ? value * 100 : value;
    const normalized = Math.round(scaled);

    if (!Number.isFinite(normalized) || normalized < 0 || normalized > 100) {
      throw new BadRequestException("confidence must be between 0 and 100");
    }

    return normalized;
  }

  private requireLlmResult(
    llmResult: TransactionHandleRequestDto["llmResult"],
  ): NonNullable<TransactionHandleRequestDto["llmResult"]> {
    if (!llmResult) {
      throw new BadRequestException("llmResult is required");
    }

    return llmResult;
  }

  private firstMissingLlmField(
    llmResult: NonNullable<TransactionHandleRequestDto["llmResult"]>,
  ): string | null {
    const income =
      this.cleanString(llmResult.transaction_type)?.toLowerCase() === "income";

    return (
      llmResult.missing_fields
        ?.map((field) => this.cleanString(field))
        .find(
          (field) =>
            field &&
            (!income ||
              (field.toLowerCase() !== "merchant" &&
                field.toLowerCase() !== "category")),
        ) ?? null
    );
  }

  private buildPendingTransactionPayload(
    llmResult: NonNullable<TransactionHandleRequestDto["llmResult"]>,
    missingField: string,
  ): NonNullable<TransactionHandleRequestDto["llmResult"]> & {
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
    if (missingField === "amount") {
      return "How much was the transaction?";
    }

    if (missingField === "merchant") {
      return "Where was the transaction?";
    }

    if (missingField === "category") {
      return "Which category should I use?";
    }

    if (missingField === "transaction_type") {
      return "Was this an expense, income, transfer, or reversal?";
    }

    if (missingField === "transaction_date") {
      return "When did this transaction happen?";
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
      throw new BadRequestException("merchant is required");
    }
  }

  private statusFromConfidence(confidence: number): TransactionStatus {
    return confidence >= 90 ? "confirmed" : "pending";
  }

  private async saveTransaction(
    input: SaveTransactionInputDto,
  ): Promise<SavedTransactionDto> {
    if (
      input.normalized.transactionType !== "income" &&
      !input.normalized.category
    ) {
      throw new BadRequestException("category is required");
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
      throw new BadRequestException("transaction insert failed");
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
      source: "manual",
      notes: input.normalized.notes,
      status: input.status,
      confidence: input.confidence,
    };
  }

  private buildHandleResponse(
    transaction: SavedTransactionDto,
    watchdog?: TransactionWatchdogResponseDto,
  ): TransactionHandleResponseDto {
    if (transaction.status === "confirmed") {
      const message =
        transaction.transactionType === "income"
          ? `${String.fromCodePoint(0x2705)} Recorded income: ${this.formatCurrency(
              transaction.amount,
            )}${
              transaction.merchantNormalized
                ? ` from ${this.titleCaseWords(transaction.merchantNormalized)}`
                : ""
            }.`
          : `${String.fromCodePoint(0x2705)} Recorded: ${this.formatCurrency(
              transaction.amount,
            )} at ${this.titleCaseWords(
              transaction.merchantNormalized ?? "",
            )} under ${transaction.category}.`;

      return {
        status: transaction.status,
        transactionId: transaction.id,
        message: this.appendWatchdogMessage(message, watchdog),
        notifications: watchdog?.notifications ?? [],
        ...(watchdog?.watchdog ? { watchdog: watchdog.watchdog } : {}),
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
      message: "Please confirm this transaction.",
      notifications: watchdog?.notifications ?? [],
      ...(watchdog?.watchdog ? { watchdog: watchdog.watchdog } : {}),
      confirmationPayload: {
        text: confirmationPayload.text,
        reply_markup: confirmationPayload.replyMarkup,
      },
    };
  }

  private normalizeAmountString(value: string): string {
    const cleaned = value.replace(/[^\d,.-]/g, "");
    const lastComma = cleaned.lastIndexOf(",");
    const lastDot = cleaned.lastIndexOf(".");

    if (lastComma >= 0 && lastDot >= 0) {
      const decimalSeparator = lastComma > lastDot ? "," : ".";
      const thousandsSeparator = decimalSeparator === "," ? "." : ",";

      return cleaned
        .replace(new RegExp(`\\${thousandsSeparator}`, "g"), "")
        .replace(decimalSeparator, ".");
    }

    if (lastComma >= 0 || lastDot >= 0) {
      const separator = lastComma >= 0 ? "," : ".";
      const separatorIndex = lastComma >= 0 ? lastComma : lastDot;
      const fractionLength = cleaned.length - separatorIndex - 1;

      if (fractionLength === 3) {
        return cleaned.replace(new RegExp(`\\${separator}`, "g"), "");
      }

      return cleaned.replace(separator, ".");
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

  private async handleRegretNoteIfNeeded(
    request: TransactionHandleRequestDto,
    stateStore: TransactionHandleStateStore | undefined,
  ): Promise<TransactionHandleResponseDto | null> {
    const state = await stateStore?.getState?.(request.userId);

    if (state?.stateName !== "veyra_regret_note") {
      return null;
    }

    const stateData = this.readRecord(state.stateData);
    const reviewId = this.cleanString(stateData.review_id);
    const note = this.cleanString(request.text);

    if (!reviewId) {
      await this.resetConversationState(request.userId, stateStore);
      return {
        status: "cancelled",
        transactionId: null,
        message: "Regret review expired.",
      };
    }

    const review = await this.getReviewById(reviewId, request.userId);

    if (!review) {
      await this.resetConversationState(request.userId, stateStore);
      return {
        status: "cancelled",
        transactionId: null,
        message: "Regret review expired.",
      };
    }

    if (!note) {
      return {
        status: "awaiting_missing_field",
        transactionId: review.transactionId,
        message: "What note should I add?",
        state: {
          nextState: "veyra_regret_note",
          payload: stateData,
        },
      };
    }

    await this.database.query(
      `
        UPDATE transactions
        SET notes = $1,
            updated_at = now()
        WHERE id::text = $2
          AND user_id::text = $3
      `,
      [note, review.transactionId, String(request.userId)],
    );
    await this.resolveRiskReview(reviewId, request.userId, "regret", note);
    await this.resetConversationState(request.userId, stateStore);

    return {
      status: "regret_note_added",
      transactionId: review.transactionId,
      message: "Note added.",
      state: {
        nextState: "idle",
        payload: {},
      },
    };
  }

  async evaluateTransactionWatchdog(
    transactionId: string | number,
  ): Promise<TransactionWatchdogResponseDto> {
    try {
      const transaction = await this.findTransactionById(transactionId);

      if (!transaction) {
        return this.emptyTransactionWatchdogResponse();
      }

      const budgetWatchdog = await this.budgetService?.evaluateTransaction({
        userId: transaction.user_id,
        transactionId: transaction.id,
      });
      const budgetNotifications = this.toBudgetNotifications(budgetWatchdog);
      const burnRateFacts = await this.evaluateBurnRateRiskFacts(transaction);
      const riskNotification = await this.evaluateTransactionRisk(
        transaction,
        burnRateFacts,
      );

      return {
        notifications: [
          ...(riskNotification ? [riskNotification] : []),
          ...budgetNotifications,
          ...(burnRateFacts.notification ? [burnRateFacts.notification] : []),
        ],
        ...(budgetWatchdog ? { watchdog: budgetWatchdog } : {}),
      };
    } catch (error) {
      this.logger.error(
        `Transaction watchdog failed for transaction ${String(transactionId)}`,
        error instanceof Error ? error.stack : undefined,
      );
      return this.emptyTransactionWatchdogResponse();
    }
  }

  private emptyTransactionWatchdogResponse(): TransactionWatchdogResponseDto {
    return { notifications: [] };
  }

  private toBudgetNotifications(
    watchdog: BudgetWatchdogResponseDto | undefined,
  ): TransactionWatchdogNotificationDto[] {
    return (watchdog?.alerts ?? []).map((alert) => ({
      type: "budget_alert",
      priority: 2,
      severity: "warning",
      message: `${alert.category} budget reached ${alert.usedPercent}%`,
    }));
  }

  private async evaluateTransactionRisk(
    transaction: TransactionRow,
    burnRateFacts: RiskBurnRateFacts,
  ): Promise<TransactionWatchdogNotificationDto | null> {
    if (!this.riskReviewRepository) {
      return null;
    }

    if (!this.isLargeTransactionEligible(transaction)) {
      await this.riskReviewRepository.cancelPendingLargeTransactionReview(
        transaction.id,
      );
      return null;
    }

    const amount = this.normalizeAmount(transaction.amount);
    const merchantNormalized = this.meaningfulMerchant(
      transaction.merchant_normalized,
    )
      ? this.cleanString(transaction.merchant_normalized)?.toLowerCase() ?? null
      : this.meaningfulMerchant(transaction.merchant)
        ? await this.resolveMerchantNormalized(transaction.merchant ?? "")
        : null;
    const cycle = await this.riskCycle(transaction);
    const [budgetFacts, history] = await Promise.all([
      this.largeTransactionBudgetFacts(transaction, amount, cycle),
      this.largeTransactionHistory(transaction, merchantNormalized),
    ]);
    const median = this.median(history.amounts);
    const medianMultiplier = median ? amount / median : null;
    const reasons = this.largeTransactionReasons({
      budgetFacts,
      medianMultiplier,
      historyCount: history.amounts.length,
      merchantPriorCount: history.merchantPriorCount,
      merchantNormalized,
      burnRateUnsafe: burnRateFacts.unsafe,
    });
    const score = Math.min(
      RISK_SCORE_CAP,
      reasons.reduce((sum, reason) => sum + reason.score, 0),
    );
    const riskLevel = this.riskLevel(score);
    const status = riskLevel === "high" || riskLevel === "critical"
      ? "pending"
      : "resolved";
    const result =
      await this.riskReviewRepository.saveLargeTransactionEvaluation({
        userId: transaction.user_id,
        transactionId: transaction.id,
        riskLevel,
        riskScore: score,
        riskReasons: reasons,
        riskMetrics: {
          evaluatorVersion: LARGE_TRANSACTION_EVALUATOR_VERSION,
          evaluationFingerprint: this.largeTransactionFingerprint(transaction),
          transactionAmount: amount,
          transactionDate: this.formatNullableTimestamp(
            transaction.transaction_date,
          ),
          merchant: transaction.merchant ?? null,
          merchantNormalized,
          merchantPriorCount: history.merchantPriorCount,
          historyWindowDays: RISK_HISTORY_WINDOW_DAYS,
          historyTransactionCount: history.amounts.length,
          medianTransactionAmount: median,
          medianMultiplier,
          ...budgetFacts,
          burnRateUnsafe: burnRateFacts.unsafe,
          burnRateProjectedCycleSpend: burnRateFacts.projectedCycleSpend,
          burnRateBudgetAmount: burnRateFacts.budgetAmount,
          cycleStart: cycle.cycle_start,
          cycleEnd: cycle.cycle_end,
          riskType: LARGE_TRANSACTION_RISK_TYPE,
        },
        status,
      });

    if (!result.shouldNotify || status !== "pending") {
      return null;
    }

    return {
      type: "risk_review",
      priority: 1,
      severity: riskLevel === "critical" ? "high" : "warning",
      review_id: Number(result.review.id),
      message: this.buildLargeTransactionReviewText(result.review),
      reply_markup: this.buildWatchdogRiskReplyMarkup(result.review.id),
    };
  }

  private isLargeTransactionEligible(transaction: TransactionRow): boolean {
    return (
      transaction.status === "confirmed" &&
      transaction.transaction_type === "expense" &&
      this.normalizeAmount(transaction.amount) > 0
    );
  }

  private async riskCycle(transaction: TransactionRow) {
    const result = await this.database.query<RiskCycleStartRow>(
      `
        SELECT cycle_start_day
        FROM telegram_users
        WHERE id::text = $1
        LIMIT 1
      `,
      [String(transaction.user_id)],
    );

    return typeof this.budgetService?.calculateCurrentCycle === "function"
      ? this.budgetService.calculateCurrentCycle(
        this.parseRiskReferenceDate(transaction.transaction_date),
        result.rows[0]?.cycle_start_day ?? 1,
      )
      : this.calculateRiskCycle(
          this.parseRiskReferenceDate(transaction.transaction_date),
          result.rows[0]?.cycle_start_day ?? 1,
        );
  }

  private parseRiskReferenceDate(value: string | Date | null | undefined): Date {
    const date = value instanceof Date ? value : new Date(value ?? Date.now());
    return Number.isNaN(date.getTime()) ? new Date() : date;
  }

  private async largeTransactionBudgetFacts(
    transaction: TransactionRow,
    amount: number,
    cycle: { cycle_start: string; cycle_end: string },
  ): Promise<RiskBudgetFacts> {
    const result = await this.database.query<RiskBudgetFactsRow>(
      `
        WITH category_budget AS (
          SELECT b.id, b.category, b.amount, b.parent_budget_id
          FROM budgets b
          WHERE b.user_id::text = $1
            AND lower(b.category) = lower($2)
            AND COALESCE(b.is_active, true) = true
          ORDER BY CASE WHEN b.parent_budget_id IS NOT NULL THEN 0 ELSE 1 END
          LIMIT 1
        ),
        parent_budget AS (
          SELECT p.id, p.category, COALESCE(p.amount, SUM(c.amount)) AS amount
          FROM category_budget cb
          JOIN budgets p ON p.id = COALESCE(cb.parent_budget_id, cb.id)
          LEFT JOIN budgets c ON c.parent_budget_id = p.id AND COALESCE(c.is_active, true) = true
          GROUP BY p.id, p.category, p.amount
        ),
        category_spend AS (
          SELECT COALESCE(SUM(t.amount), 0) AS amount
          FROM transactions t
          JOIN category_budget cb ON lower(t.category) = lower(cb.category)
          WHERE t.user_id::text = $1
            AND t.id::text <> $3
            AND t.status = 'confirmed'
            AND t.transaction_type = 'expense'
            AND t.transaction_date >= $4::date
            AND t.transaction_date < $5::date
        ),
        parent_categories AS (
          SELECT cb.category FROM category_budget cb
          UNION
          SELECT c.category
          FROM parent_budget pb
          JOIN budgets c ON c.parent_budget_id = pb.id
          WHERE COALESCE(c.is_active, true) = true
        ),
        parent_spend AS (
          SELECT COALESCE(SUM(t.amount), 0) AS amount
          FROM transactions t
          WHERE t.user_id::text = $1
            AND t.id::text <> $3
            AND t.status = 'confirmed'
            AND t.transaction_type = 'expense'
            AND t.transaction_date >= $4::date
            AND t.transaction_date < $5::date
            AND lower(t.category) IN (SELECT lower(category) FROM parent_categories)
        ),
        total_budget AS (
          SELECT COALESCE(SUM(amount), 0) AS amount
          FROM budgets
          WHERE user_id::text = $1
            AND parent_budget_id IS NULL
            AND COALESCE(is_active, true) = true
            AND amount IS NOT NULL
        ),
        total_spend AS (
          SELECT COALESCE(SUM(t.amount), 0) AS amount
          FROM transactions t
          WHERE t.user_id::text = $1
            AND t.id::text <> $3
            AND t.status = 'confirmed'
            AND t.transaction_type = 'expense'
            AND t.transaction_date >= $4::date
            AND t.transaction_date < $5::date
        )
        SELECT
          cb.id AS category_budget_id,
          cb.category AS category_budget_category,
          cb.amount AS category_budget_amount,
          cs.amount AS category_spend_before,
          pb.id AS parent_budget_id,
          pb.category AS parent_budget_category,
          pb.amount AS parent_budget_amount,
          ps.amount AS parent_spend_before,
          tb.amount AS total_budget_amount,
          ts.amount AS total_spend_before
        FROM total_budget tb
        CROSS JOIN total_spend ts
        LEFT JOIN category_budget cb ON true
        LEFT JOIN parent_budget pb ON true
        LEFT JOIN category_spend cs ON true
        LEFT JOIN parent_spend ps ON true
      `,
      [
        String(transaction.user_id),
        transaction.category ?? "",
        String(transaction.id),
        cycle.cycle_start,
        cycle.cycle_end,
      ],
    );
    const row = result.rows[0];
    const categoryBudgetAmount = this.nullableNumber(
      row?.category_budget_amount,
    );
    const categorySpendBefore = this.nullableNumber(
      row?.category_spend_before,
    );
    const parentAmount =
      this.nullableNumber(row?.parent_budget_amount) ??
      this.nullableNumber(row?.total_budget_amount);
    const parentSpendBefore =
      this.nullableNumber(row?.parent_spend_before) ??
      this.nullableNumber(row?.total_spend_before);

    return {
      categoryBudgetId:
        row?.category_budget_id === null || row?.category_budget_id === undefined
          ? null
          : String(row.category_budget_id),
      categoryBudgetCategory: row?.category_budget_category ?? null,
      categoryBudgetAmount,
      categorySpendBefore,
      categorySpendAfter:
        categorySpendBefore === null ? null : categorySpendBefore + amount,
      parentBudgetId:
        row?.parent_budget_id === null || row?.parent_budget_id === undefined
          ? null
          : String(row.parent_budget_id),
      parentBudgetCategory: row?.parent_budget_category ?? null,
      parentBudgetAmount: parentAmount,
      parentSpendBefore,
      parentSpendAfter:
        parentSpendBefore === null ? null : parentSpendBefore + amount,
      transactionBudgetSharePercent:
        parentAmount && parentAmount > 0 ? (amount / parentAmount) * 100 : null,
      causedCategoryOverspend:
        categoryBudgetAmount !== null &&
        categorySpendBefore !== null &&
        categorySpendBefore <= categoryBudgetAmount &&
        categorySpendBefore + amount > categoryBudgetAmount,
      causedParentOverspend:
        parentAmount !== null &&
        parentSpendBefore !== null &&
        parentSpendBefore <= parentAmount &&
        parentSpendBefore + amount > parentAmount,
    };
  }

  private async largeTransactionHistory(
    transaction: TransactionRow,
    merchantNormalized: string | null,
  ): Promise<RiskTransactionHistory> {
    const transactionDate =
      this.formatNullableTimestamp(transaction.transaction_date) ??
      new Date().toISOString();
    const since = new Date(
      new Date(transactionDate).getTime() - RISK_HISTORY_WINDOW_DAYS * 86_400_000,
    ).toISOString();
    const amounts = await this.database.query<RiskAmountRow>(
      `
        SELECT amount
        FROM transactions
        WHERE user_id::text = $1
          AND id::text <> $2
          AND status = 'confirmed'
          AND transaction_type = 'expense'
          AND amount > 0
          AND transaction_date >= $3::timestamptz
          AND transaction_date < $4::timestamptz
      `,
      [String(transaction.user_id), String(transaction.id), since, transactionDate],
    );
    const merchantCount = merchantNormalized
      ? await this.database.query<RiskCountRow>(
          `
            SELECT COUNT(*) AS count
            FROM transactions
            WHERE user_id::text = $1
              AND id::text <> $2
              AND status = 'confirmed'
              AND transaction_type = 'expense'
              AND transaction_date >= $3::timestamptz
              AND transaction_date < $4::timestamptz
              AND lower(COALESCE(merchant_normalized, merchant)) = lower($5)
          `,
          [
            String(transaction.user_id),
            String(transaction.id),
            since,
            transactionDate,
            merchantNormalized,
          ],
        )
      : null;

    return {
      amounts: amounts.rows
        .map((row) => this.normalizeAmount(row.amount))
        .filter((value) => value > 0),
      merchantPriorCount: merchantCount
        ? this.normalizeAmount(merchantCount.rows[0]?.count ?? 0)
        : null,
    };
  }

  private largeTransactionReasons(input: {
    budgetFacts: RiskBudgetFacts;
    medianMultiplier: number | null;
    historyCount: number;
    merchantPriorCount: number | null;
    merchantNormalized: string | null;
    burnRateUnsafe: boolean;
  }): RiskReason[] {
    const reasons: RiskReason[] = [];

    if (
      input.budgetFacts.transactionBudgetSharePercent !== null &&
      input.budgetFacts.transactionBudgetSharePercent >=
        RISK_BUDGET_SHARE_THRESHOLD
    ) {
      reasons.push({
        code: "high_budget_share",
        score: RISK_SIGNAL_SCORES.highBudgetShare,
        message: `Transaction is ${this.round1(input.budgetFacts.transactionBudgetSharePercent)}% of the active monthly budget`,
      });
    }

    if (
      input.historyCount >= RISK_MIN_MEDIAN_HISTORY &&
      input.medianMultiplier !== null &&
      input.medianMultiplier >= RISK_UNUSUAL_MULTIPLIER_THRESHOLD
    ) {
      reasons.push({
        code: "unusual_vs_median",
        score: RISK_SIGNAL_SCORES.unusualVsMedian,
        message: `Transaction is ${this.round1(input.medianMultiplier)}x larger than the recent median`,
      });
    }

    if (
      input.budgetFacts.causedCategoryOverspend ||
      input.budgetFacts.causedParentOverspend
    ) {
      reasons.push({
        code: "causes_budget_overspend",
        score: RISK_SIGNAL_SCORES.causesBudgetOverspend,
        message: "Transaction pushed a budget over 100%",
      });
    }

    if (input.burnRateUnsafe) {
      reasons.push({
        code: "unsafe_burn_rate",
        score: RISK_SIGNAL_SCORES.unsafeBurnRate,
        message: "Projected cycle spending exceeds the active budget",
      });
    }

    if (
      input.merchantNormalized &&
      input.merchantPriorCount !== null &&
      input.merchantPriorCount < RISK_MERCHANT_FREQUENCY_THRESHOLD
    ) {
      reasons.push({
        code: "low_frequency_merchant",
        score: RISK_SIGNAL_SCORES.lowFrequencyMerchant,
        message: "Merchant is uncommon in recent spending",
      });
    }

    return reasons;
  }

  private async evaluateBurnRateRiskFacts(
    transaction: TransactionRow,
  ): Promise<RiskBurnRateFacts> {
    if (!this.isLargeTransactionEligible(transaction)) {
      return {
        unsafe: false,
        notification: null,
        projectedCycleSpend: null,
        budgetAmount: null,
      };
    }

    const amount = this.normalizeAmount(transaction.amount);
    const cycle = await this.riskCycle(transaction);
    const facts = await this.largeTransactionBudgetFacts(transaction, amount, cycle);
    const spent = facts.parentSpendAfter ?? 0;
    const budgetAmount = facts.parentBudgetAmount;
    const cycleStart = new Date(`${cycle.cycle_start}T00:00:00.000Z`);
    const cycleEnd = new Date(`${cycle.cycle_end}T00:00:00.000Z`);
    const elapsedDays = Math.max(1, this.daysBetween(cycleStart, new Date()));
    const cycleDays = Math.max(1, this.daysBetween(cycleStart, cycleEnd));
    const projectedCycleSpend = (spent / elapsedDays) * cycleDays;
    const unsafe = budgetAmount !== null && projectedCycleSpend > budgetAmount;

    return {
      unsafe,
      projectedCycleSpend,
      budgetAmount,
      notification: unsafe
        ? {
            type: "burn_rate",
            priority: 3,
            severity: "warning",
            message: `Burn-rate projected spend ${this.formatCurrency(projectedCycleSpend)} exceeds ${this.formatCurrency(budgetAmount ?? 0)}`,
          }
        : null,
    };
  }

  private median(values: number[]): number | null {
    if (values.length === 0) return null;
    const sorted = [...values].sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2
      ? sorted[middle]
      : (sorted[middle - 1] + sorted[middle]) / 2;
  }

  private riskLevel(score: number): TransactionRiskLevel {
    if (score >= RISK_LEVEL_BOUNDS.critical) return "critical";
    if (score >= RISK_LEVEL_BOUNDS.high) return "high";
    if (score >= RISK_LEVEL_BOUNDS.medium) return "medium";
    return "low";
  }

  private largeTransactionFingerprint(transaction: TransactionRow): string {
    return [
      LARGE_TRANSACTION_EVALUATOR_VERSION,
      transaction.id,
      this.normalizeAmount(transaction.amount),
      transaction.category ?? "",
      transaction.merchant_normalized ?? "",
      this.formatNullableTimestamp(transaction.transaction_date) ?? "",
      transaction.status ?? "",
      transaction.transaction_type ?? "",
    ].join("|");
  }

  private buildLargeTransactionReviewText(
    review: TransactionRiskReview,
  ): string {
    const metrics = review.riskMetrics;
    const amount = this.formatCurrency(this.numberMetric(metrics.transactionAmount));
    const merchant =
      this.cleanString(metrics.merchantNormalized) ??
      this.cleanString(metrics.merchant) ??
      "Unknown";
    const reasonLines = this.topRiskReasons(review.riskReasons).map(
      (reason) => `• ${this.humanRiskReason(reason, metrics)}`,
    );

    return [
      "<b>⚠️ Large transaction detected</b>",
      "",
      `${amount} at ${this.escapeTelegramHtml(this.titleCaseWords(merchant))}`,
      ...reasonLines,
      "",
      "Was this purchase planned?",
    ].join("\n");
  }

  private topRiskReasons(reasons: unknown[]): RiskReason[] {
    const priority: Record<RiskReason["code"], number> = {
      high_budget_share: 1,
      unusual_vs_median: 2,
      causes_budget_overspend: 3,
      unsafe_burn_rate: 4,
      low_frequency_merchant: 5,
    };

    return reasons
      .filter((reason): reason is RiskReason => this.isRiskReason(reason))
      .sort(
        (left, right) =>
          right.score - left.score || priority[left.code] - priority[right.code],
      )
      .slice(0, 3);
  }

  private isRiskReason(reason: unknown): reason is RiskReason {
    if (!reason || typeof reason !== "object") return false;
    const value = reason as Partial<RiskReason>;
    return typeof value.code === "string" && typeof value.score === "number";
  }

  private humanRiskReason(
    reason: RiskReason,
    metrics: Record<string, unknown>,
  ): string {
    if (reason.code === "high_budget_share") {
      return `${this.round1(this.numberMetric(metrics.transactionBudgetSharePercent))}% of your monthly budget`;
    }

    if (reason.code === "unusual_vs_median") {
      return `${this.round1(this.numberMetric(metrics.medianMultiplier))}x larger than your recent median`;
    }

    if (reason.code === "causes_budget_overspend") {
      const category = this.cleanString(metrics.categoryBudgetCategory);
      return category
        ? `This pushed ${this.escapeTelegramHtml(category)} over budget`
        : "This pushed a budget over 100%";
    }

    if (reason.code === "unsafe_burn_rate") {
      return "Your burn rate is projected to exceed budget";
    }

    return "This merchant is uncommon for you";
  }

  private nullableNumber(value: unknown): number | null {
    if (value === null || value === undefined) return null;
    const numberValue = Number(value);
    return Number.isFinite(numberValue) ? numberValue : null;
  }

  private numberMetric(value: unknown): number {
    return this.nullableNumber(value) ?? 0;
  }

  private round1(value: number): number {
    return Math.round(value * 10) / 10;
  }

  private meaningfulMerchant(value: string | null | undefined): boolean {
    const merchant = this.cleanString(value ?? undefined);
    return Boolean(merchant && !this.isUnknownMerchant(merchant));
  }

  private daysBetween(start: Date, end: Date): number {
    return Math.ceil((end.getTime() - start.getTime()) / 86_400_000);
  }

  private calculateRiskCycle(
    referenceDate: Date,
    cycleStartDay: number | string | null | undefined,
  ): { cycle_start: string; cycle_end: string } {
    const day = Math.min(Math.max(Math.trunc(Number(cycleStartDay ?? 1)), 1), 31);
    const startThisMonth = this.utcRiskCycleDate(
      referenceDate.getUTCFullYear(),
      referenceDate.getUTCMonth(),
      day,
    );
    const start =
      referenceDate.getTime() >= startThisMonth.getTime()
        ? startThisMonth
        : this.utcRiskCycleDate(
            referenceDate.getUTCFullYear(),
            referenceDate.getUTCMonth() - 1,
            day,
          );
    const end = this.utcRiskCycleDate(
      start.getUTCFullYear(),
      start.getUTCMonth() + 1,
      day,
    );

    return {
      cycle_start: start.toISOString().slice(0, 10),
      cycle_end: end.toISOString().slice(0, 10),
    };
  }

  private utcRiskCycleDate(year: number, month: number, day: number): Date {
    const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    return new Date(Date.UTC(year, month, Math.min(day, daysInMonth)));
  }

  private buildWatchdogRiskReplyMarkup(
    reviewId: string,
  ): TelegramReplyMarkupDto {
    return {
      inline_keyboard: [
        [
          {
            text: "Planned",
            callback_data: `veyra_risk:${reviewId}:planned`,
          },
          {
            text: "Necessary",
            callback_data: `veyra_risk:${reviewId}:necessary`,
          },
        ],
        [
          {
            text: "Regret it",
            callback_data: `veyra_risk:${reviewId}:regret`,
          },
          {
            text: "Ignore",
            callback_data: `veyra_risk:${reviewId}:ignore`,
          },
        ],
      ],
    };
  }

  private appendWatchdogMessage(
    message: string,
    watchdog: TransactionWatchdogResponseDto | undefined,
  ): string {
    const sections = [
      ...(watchdog?.notifications ?? [])
        .filter((notification) => notification.message.includes("\n"))
        .map((notification) => notification.message),
      watchdog?.watchdog?.hasAlert ? watchdog.watchdog.message?.text : null,
    ].filter((section): section is string => Boolean(section));

    if (sections.length === 0) {
      return message;
    }

    return `${message}\n\n${sections.join("\n\n")}`;
  }

  private isResetText(value: string | undefined): boolean {
    const text = value?.trim().toLowerCase();
    return Boolean(
      text &&
      ["reset", "cancel", "exit", "stop", "batal", "keluar"].includes(text),
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
        "Unknown",
      category: pendingTransaction.category,
    };
  }

  private transactionSummary(
    transaction: TransactionRow,
  ): ConfirmTransactionSummaryDto {
    return {
      amount: this.normalizeAmount(transaction.amount),
      merchant:
        transaction.merchant_normalized ?? transaction.merchant ?? "Unknown",
      category: transaction.category,
    };
  }

  private transactionEditMessage(
    transactionId: string,
    summary: ConfirmTransactionSummaryDto,
    nextStatus: "confirmed" | "rejected",
    transaction?: TransactionRow,
  ): ConfirmTransactionEditMessageDto {
    const emailDate =
      nextStatus === "confirmed" && transaction?.source === "email"
        ? this.emailTransactionDisplayDate(transaction)
        : null;
    const text =
      nextStatus === "confirmed"
        ? `Transaction ${transactionId} confirmed: ${summary.merchant} • ${this.formatCurrency(summary.amount)}${emailDate ? `\nDate: ${emailDate}` : ""}`
        : `Transaction ${transactionId} cancelled.`;

    return {
      text,
      parseMode: null,
    };
  }

  private async activateValidatedEmailTemplate(
    transaction: TransactionRow,
  ): Promise<void> {
    if (transaction.source !== "email" || !this.emailParserTemplateRepository) {
      return;
    }

    const rawPayload = this.readRecord(transaction.raw_payload);
    const validatedTemplate = this.readRecord(rawPayload.validatedTemplate);
    const email = this.readRecord(rawPayload.email);
    const senderAddress = this.cleanString(email.from);
    const authentication = this.readRecord(email.authentication);
    const fingerprint = this.cleanString(validatedTemplate.fingerprint);
    const proposal =
      senderAddress && fingerprint
        ? validateStoredEmailTemplateProposal({
            senderAddress,
            fingerprint,
            proposal: validatedTemplate.proposal,
          })
        : null;

    if (
      !senderAddress ||
      !fingerprint ||
      !proposal ||
      !hasAlignedSenderAuthentication({
        messageId: "",
        from: senderAddress,
        subject: "",
        emailText: "",
        authentication: {
          dkim:
            authentication.dkim === "pass" ||
            authentication.dkim === "fail"
              ? authentication.dkim
              : "unknown",
          spf:
            authentication.spf === "pass" ||
            authentication.spf === "fail"
              ? authentication.spf
              : "unknown",
          dmarc:
            authentication.dmarc === "pass" ||
            authentication.dmarc === "fail"
              ? authentication.dmarc
              : "unknown",
          domain: this.cleanString(authentication.domain),
        },
      })
    ) {
      return;
    }

    try {
      await this.emailParserTemplateRepository.activate({
        userId: String(transaction.user_id),
        senderAddress: senderAddress.toLowerCase(),
        fingerprint,
        proposal,
      });
    } catch (error) {
      this.logger.error(
        `Failed to activate email parser template for transaction ${String(transaction.id)}`,
        error instanceof Error ? error.stack : undefined,
      );
    }
  }

  private async disableLearnedTemplateAfterMaterialEdit(
    transaction: TransactionRow,
    changes: ManageStateData["changes"],
    query: EmailTemplateQuery,
  ): Promise<void> {
    if (!this.emailParserTemplateRepository) {
      return;
    }

    if (!EMAIL_MATERIAL_KEYS.some((key) => key in (changes ?? {}))) {
      return;
    }

    const rawPayload = this.readRecord(transaction.raw_payload);
    const templateId = this.cleanString(rawPayload.templateId);

    if (rawPayload.parserSource !== "learned" || !templateId) {
      return;
    }

    await this.emailParserTemplateRepository.disable(
      templateId,
      String(transaction.user_id),
      query,
    );
  }

  private async updateEmailImportStatus(
    transaction: TransactionRow,
    status: "pending" | "confirmed" | "rejected",
  ): Promise<void> {
    if (transaction.source !== "email") {
      return;
    }

    await this.database.query(
      `
        UPDATE transaction_imports
        SET status = $1
        WHERE transaction_id = $2
          AND user_id = $3
          AND source = 'email'
      `,
      [status, String(transaction.id), String(transaction.user_id)],
    );
  }

  private async learnConfirmedEmailTransaction(
    transaction: TransactionRow,
  ): Promise<void> {
    const rawPayload = this.readRecord(transaction.raw_payload);

    if (
      transaction.source !== "email" ||
      rawPayload.parserSource !== "ai" ||
      !transaction.merchant ||
      !transaction.merchant_normalized ||
      !transaction.category
    ) {
      return;
    }

    try {
      await this.upsertMerchantAlias(
        transaction.merchant,
        transaction.merchant_normalized,
      );
      await this.upsertCategoryRule({
        userId: String(transaction.user_id),
        merchantPattern: transaction.merchant_normalized,
        category: transaction.category,
      });
    } catch (error) {
      this.logger.error(
        `Failed to learn confirmed email transaction ${String(transaction.id)}`,
        error instanceof Error ? error.stack : undefined,
      );
    }
  }

  private async upsertMerchantAlias(
    aliasName: string,
    canonicalName: string,
  ): Promise<void> {
    const existing = await this.database.query<MerchantAliasRow>(
      `
        SELECT id, canonical_name
        FROM merchant_aliases
        WHERE lower(alias_name) = lower($1)
        LIMIT 1
      `,
      [aliasName],
    );
    const row = existing.rows[0];

    if (!row) {
      await this.database.query(
        `
          INSERT INTO merchant_aliases (alias_name, canonical_name)
          VALUES ($1, $2)
        `,
        [aliasName, canonicalName],
      );
      return;
    }

    if (row.canonical_name !== canonicalName) {
      await this.database.query(
        `
          UPDATE merchant_aliases
          SET canonical_name = $1
          WHERE id = $2
        `,
        [canonicalName, String(row.id)],
      );
    }
  }

  private async upsertCategoryRule(input: {
    userId: string;
    merchantPattern: string;
    category: string;
  }): Promise<void> {
    const existing = await this.database.query<CategoryRuleRow>(
      `
        SELECT id, category
        FROM category_rules
        WHERE user_id = $1
          AND lower(merchant_pattern) = lower($2)
        LIMIT 1
      `,
      [input.userId, input.merchantPattern],
    );
    const row = existing.rows[0];

    if (!row) {
      await this.database.query(
        `
          INSERT INTO category_rules (user_id, merchant_pattern, category)
          VALUES ($1, $2, $3)
        `,
        [input.userId, input.merchantPattern, input.category],
      );
      return;
    }

    if (row.category !== input.category) {
      await this.database.query(
        `
          UPDATE category_rules
          SET category = $1
          WHERE id = $2
        `,
        [input.category, String(row.id)],
      );
    }
  }

  private async transitionPendingEmailTransaction(input: {
    transaction: TransactionRow;
    status: "confirmed" | "rejected";
    category?: string;
  }): Promise<TransactionRow | null> {
    return this.database.withTransaction(async (client) => {
      const values: unknown[] = [
        input.status,
        String(input.transaction.id),
        String(input.transaction.user_id),
      ];
      const categoryAssignment =
        input.category === undefined
          ? ""
          : `category = $${values.push(input.category)},`;
      const transaction = await client.query<TransactionRow>(
        `
          UPDATE transactions
          SET ${categoryAssignment}
              status = $1,
              updated_at = now()
          WHERE id = $2
            AND user_id = $3
            AND source = 'email'
            AND status = 'pending'
          RETURNING id,
                    user_id,
                    transaction_type,
                    amount,
                    merchant,
                    merchant_normalized,
                    category,
                    transaction_date,
                    notes,
                    status,
                    source,
                    confidence,
                    raw_payload,
                    created_at
        `,
        values,
      );

      const transitioned = transaction.rows[0];

      if (!transitioned) {
        return null;
      }

      const emailImport = await client.query<InsertedImportRow>(
        `
          UPDATE transaction_imports
          SET status = $1
          WHERE transaction_id = $2
            AND user_id = $3
            AND source = 'email'
          RETURNING id
        `,
        [
          input.status,
          String(input.transaction.id),
          String(input.transaction.user_id),
        ],
      );

      if (emailImport.rows[0]) {
        return transitioned;
      }

      const rawPayload = this.readRecord(transitioned.raw_payload);
      const email = this.readRecord(rawPayload.email);
      const messageId = this.cleanString(email.messageId);

      if (!messageId) {
        if (rawPayload.parserSource === undefined) {
          // Legacy AI reviews predate Gmail import attachment metadata.
          return transitioned;
        }
        throw new BadRequestException("linked email import was not found");
      }

      const reconciled = await client.query<InsertedImportRow>(
        `
          INSERT INTO transaction_imports (
            user_id,
            source,
            source_reference,
            transaction_id,
            status,
            raw_payload
          )
          VALUES ($1, 'email', $2, $3, $4, $5)
          ON CONFLICT (user_id, source, source_reference) DO UPDATE
          SET transaction_id = EXCLUDED.transaction_id,
              status = EXCLUDED.status,
              raw_payload = EXCLUDED.raw_payload
          WHERE transaction_imports.transaction_id IS NULL
             OR transaction_imports.transaction_id = EXCLUDED.transaction_id
          RETURNING id
        `,
        [
          String(transitioned.user_id),
          messageId,
          String(transitioned.id),
          input.status,
          transitioned.raw_payload ?? {},
        ],
      );

      if (!reconciled.rows[0]) {
        throw new BadRequestException("linked email import was not found");
      }

      return transitioned;
    });
  }

  private terminalTransactionResponse(
    transaction: TransactionRow,
  ): ConfirmTransactionResponseDto | null {
    const status = this.cleanString(transaction.status)?.toLowerCase();

    if (status !== "confirmed" && status !== "rejected") {
      return null;
    }

    return {
      status: status === "confirmed" ? "already_confirmed" : "already_rejected",
      transactionId: String(transaction.id),
      userId: String(transaction.user_id),
      summary: this.transactionSummary(transaction),
      editMessage: null,
    };
  }

  private async updateTransactionStatus(
    request: ConfirmTransactionRequestDto,
    nextStatus: "confirmed" | "rejected",
  ): Promise<ConfirmTransactionResponseDto> {
    const transactionId = this.cleanString(request.transactionId);
    const userId = this.cleanString(request.userId);

    if (!transactionId) {
      throw new BadRequestException("transactionId is required");
    }

    if (!userId) {
      throw new BadRequestException("userId is required");
    }

    const transaction = await this.findTransaction(transactionId, userId);

    if (!transaction) {
      return {
        status: "not_found",
        transactionId,
        userId,
        summary: null,
        editMessage: null,
      };
    }

    const terminalResponse = this.terminalTransactionResponse(transaction);

    if (terminalResponse) {
      return terminalResponse;
    }

    let winningTransaction = transaction;

    if (transaction.source === "email") {
      const transitioned = await this.transitionPendingEmailTransaction({
        transaction,
        status: nextStatus,
      });

      if (!transitioned) {
        const current = await this.findTransaction(transactionId, userId);
        const concurrentResponse =
          current && this.terminalTransactionResponse(current);

        if (concurrentResponse) {
          return concurrentResponse;
        }

        throw new BadRequestException("transaction status transition failed");
      }

      winningTransaction = transitioned;
    } else {
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
    }

    const summary = this.transactionSummary(winningTransaction);

    if (nextStatus === "confirmed") {
      await this.activateValidatedEmailTemplate(winningTransaction);
      await this.learnConfirmedEmailTransaction(winningTransaction);
    }

    const watchdog =
      nextStatus === "confirmed"
        ? await this.evaluateTransactionWatchdog(String(winningTransaction.id))
        : this.emptyTransactionWatchdogResponse();
    const editMessage = this.transactionEditMessage(
      String(winningTransaction.id),
      summary,
      nextStatus,
      winningTransaction,
    );

    return {
      status: nextStatus,
      transactionId: String(winningTransaction.id),
      userId: String(winningTransaction.user_id),
      summary,
      editMessage: {
        ...editMessage,
        text: this.appendWatchdogMessage(editMessage.text, watchdog),
        parseMode: watchdog.watchdog?.hasAlert ? "HTML" : editMessage.parseMode,
      },
      notifications: watchdog.notifications,
      ...(watchdog.watchdog ? { watchdog: watchdog.watchdog } : {}),
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
          transaction_type,
          transaction_date,
          status,
          source,
          confidence,
          raw_payload
        FROM transactions
        WHERE id = $1
          AND user_id = $2
        LIMIT 1
      `,
      [transactionId, userId],
    );

    return result.rows[0];
  }

  private async findTransactionById(
    transactionId: string | number,
  ): Promise<TransactionRow | undefined> {
    const result = await this.database.query<TransactionRow>(
      `
        SELECT id,
               user_id,
               transaction_type,
               amount,
               merchant,
               merchant_normalized,
               category,
               transaction_date,
               notes,
               status,
               source,
               confidence,
               raw_payload,
               created_at
        FROM transactions
        WHERE id::text = $1
        LIMIT 1
      `,
      [String(transactionId)],
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
              text: "Approve",
              callback_data: `tx_confirm:${transactionId}`,
            },
            {
              text: "Change Category",
              callback_data: `tx_category:${transactionId}`,
            },
          ],
          [
            {
              text: "Reject",
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
            text: "Save",
            callback_data: this.saveTransactionCallbackData(transactionId),
          },
          {
            text: "Change Category",
            callback_data: this.changeCategoriesCallbackData(transactionId),
          },
        ],
        [
          {
            text: "Cancel",
            callback_data: this.cancelTransactionCallbackData(transactionId),
          },
        ],
      ],
    };
  }

  private buildConfirmationTextLines(input: {
    transactionType: NormalizedTransactionType;
    amount: number;
    merchant: string | null;
    category: string | null;
    wallet: string;
    notes: string;
    warningLines: string[];
  }): string[] {
    return [
      "Confirm transaction",
      "",
      `Type: ${this.titleCase(input.transactionType)}`,
      `Amount: ${this.formatCurrency(input.amount)}`,
      ...(input.merchant ? [`Merchant: ${input.merchant}`] : []),
      ...(input.category ? [`Category: ${input.category}`] : []),
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
      .join("\n");
  }

  private escapeTelegramHtml(value: string): string {
    return value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  private parseTransactionCallbackData(
    callbackData: string | undefined,
  ): ParsedTransactionCallback {
    const value = this.cleanString(callbackData);

    if (!value) {
      return {
        action: "invalid_callback",
        error: "Invalid transaction callback.",
      };
    }

    const parts = value.split(":");
    const action = parts[0];

    if (
      action === "save_transaction" ||
      action === "cancel_transaction" ||
      action === "change_categories"
    ) {
      if (parts.length !== 2) {
        return {
          action,
          error: "Invalid transaction callback.",
        };
      }

      const transactionId = this.normalizeCallbackId(parts[1]);

      if (!transactionId) {
        return {
          action,
          error: "Invalid transaction callback.",
        };
      }

      return { action, transactionId };
    }

    if (action === "catid") {
      if (parts.length !== 3 && parts.length !== 4) {
        return {
          action,
          error: "Invalid transaction callback.",
        };
      }

      const budgetId = this.normalizeCallbackId(parts[1]);
      const transactionId = this.normalizeCallbackId(parts[2]);
      const reviewId =
        parts.length === 4 ? this.normalizeCallbackId(parts[3]) : undefined;

      if (!budgetId || !transactionId || (parts.length === 4 && !reviewId)) {
        return {
          action,
          transactionId,
          budgetId,
          reviewId,
          error: "Invalid transaction callback.",
        };
      }

      return {
        action,
        budgetId,
        transactionId,
        reviewId,
      };
    }

    if (action === "veyra_risk") {
      if (parts.length !== 3) {
        return {
          action: "veyra_risk",
          error: "Invalid risk review callback.",
        };
      }

      const reviewId = this.normalizeCallbackId(parts[1]);
      const riskAction = parts[2] as ParsedTransactionCallback["riskAction"];

      if (
        !reviewId ||
        !["planned", "necessary", "regret", "ignore"].includes(
          riskAction ?? "",
        )
      ) {
        return {
          action: "veyra_risk",
          reviewId,
          error: "Invalid risk review callback.",
        };
      }

      return {
        action: "veyra_risk",
        reviewId,
        riskAction,
      };
    }

    return {
      action: "unknown_callback",
      error: "Unsupported transaction callback.",
    };
  }

  private normalizeCallbackId(value: string | undefined): number | undefined {
    const cleaned = this.cleanString(value);

    if (!cleaned || !/^\d+$/.test(cleaned)) {
      return undefined;
    }

    return this.normalizePositiveInteger(Number(cleaned));
  }

  private readRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  }

  private normalizePositiveInteger(value: unknown): number | undefined {
    if (
      typeof value !== "number" ||
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
      status: "ok",
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
      status: "error",
      action: input.action,
      transactionId: input.transactionId,
      telegram: this.buildCallbackTelegramPayload({
        request: input.request,
        text: input.text,
        replyMarkup: null,
      }),
    };
  }

  private async handleRiskCallback(input: {
    request: TransactionCallbackHandleRequestDto;
    reviewId: number;
    userId: number;
    action: NonNullable<ParsedTransactionCallback["riskAction"]>;
  }): Promise<TransactionCallbackHandleResponseDto> {
    const review = await this.getReviewById(input.reviewId, input.userId);

    if (!review) {
      return this.transactionCallbackError({
        action: "veyra_risk",
        text: "Transaction review was not found.",
        request: input.request,
      });
    }

    if (review.status !== "pending") {
      return this.transactionCallbackOk({
        action: "veyra_risk",
        text: "This transaction review was already answered.",
        request: input.request,
        transactionId: Number(review.transactionId),
        replyMarkup: null,
      });
    }

    const resolved = await this.resolveRiskReview(
      input.reviewId,
      input.userId,
      input.action,
    );

    if (!resolved) {
      return this.transactionCallbackOk({
        action: "veyra_risk",
        text: "This transaction review was already answered.",
        request: input.request,
        transactionId: Number(review.transactionId),
        replyMarkup: null,
      });
    }

    return this.transactionCallbackOk({
      action: "veyra_risk",
      text: this.riskResponseText(input.action),
      request: input.request,
      transactionId: Number(review.transactionId),
      replyMarkup: null,
    });
  }

  private riskResponseText(response: TransactionRiskUserResponse): string {
    if (response === "planned") return "Noted. This purchase was planned.";
    if (response === "necessary") return "Noted. This purchase was necessary.";
    if (response === "regret") return "Recorded as a regretted purchase.";
    return "Ignored.";
  }

  private buildCallbackTelegramPayload(input: {
    request: TransactionCallbackHandleRequestDto;
    text: string;
    replyMarkup: object | null;
  }): TransactionCallbackHandleResponseDto["telegram"] {
    const telegram: TransactionCallbackHandleResponseDto["telegram"] = {
      method: "editMessageText",
      text: this.escapeTelegramHtml(input.text),
      parse_mode: "HTML",
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

  private requireRiskReviewRepository(): TransactionRiskReviewRepository {
    if (!this.riskReviewRepository) {
      throw new Error("TransactionRiskReviewRepository is not configured");
    }

    return this.riskReviewRepository;
  }

  private confirmTransactionStatusText(
    status: ConfirmTransactionStatus,
  ): string {
    if (status === "not_found") {
      return "Transaction was not found.";
    }

    if (status === "already_confirmed") {
      return "This transaction was already confirmed.";
    }

    if (status === "already_rejected") {
      return "This transaction was already cancelled.";
    }

    return "Transaction callback could not be completed.";
  }

  private categoryOptionsStatusText(
    status: TransactionCategoryOptionStatus,
  ): string {
    if (status === "not_found") {
      return "Transaction was not found.";
    }

    if (status === "already_resolved") {
      return "This transaction was already handled.";
    }

    return "Category options could not be loaded.";
  }

  private setCategoryStatusText(status: TransactionSetCategoryStatus): string {
    if (status === "not_found") {
      return "Transaction was not found.";
    }

    if (status === "already_resolved") {
      return "This transaction was already handled.";
    }

    if (status === "unauthorized_budget") {
      return "Selected category was not found.";
    }

    return "Transaction category could not be updated.";
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
    return category.toLowerCase().replace(/&/g, "and").replace(/\s+/g, "_");
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
      throw new BadRequestException("transactionId is required");
    }

    if (!input.budgetId) {
      throw new BadRequestException("budgetId is required");
    }

    const transaction = await this.findTransaction(
      input.transactionId,
      input.userId,
    );

    if (!transaction) {
      return {
        status: "not_found",
        pendingTransactionId: null,
        transactionId: input.transactionId,
        confirmationPayload: null,
        summary: null,
        editMessage: null,
      };
    }

    if (this.cleanString(transaction.status)?.toLowerCase() !== "pending") {
      return {
        status: "already_resolved",
        pendingTransactionId: null,
        transactionId: String(transaction.id),
        confirmationPayload: null,
        summary: this.transactionSummary(transaction),
        editMessage: null,
      };
    }

    const budgetCategory = await this.findBudgetCategory(
      input.budgetId,
      input.userId,
    );

    if (!budgetCategory) {
      return {
        status: "unauthorized_budget",
        pendingTransactionId: null,
        transactionId: String(transaction.id),
        confirmationPayload: null,
        summary: this.transactionSummary(transaction),
        editMessage: null,
      };
    }

    let confirmedTransaction: TransactionRow;

    if (transaction.source === "email") {
      const transitioned = await this.transitionPendingEmailTransaction({
        transaction,
        status: "confirmed",
        category: budgetCategory.category,
      });

      if (!transitioned) {
        const current = await this.findTransaction(
          String(transaction.id),
          String(transaction.user_id),
        );

        if (
          !current ||
          this.cleanString(current.status)?.toLowerCase() === "pending"
        ) {
          throw new BadRequestException(
            "transaction category transition failed",
          );
        }

        return {
          status: "already_resolved",
          pendingTransactionId: null,
          transactionId: String(transaction.id),
          confirmationPayload: null,
          summary: this.transactionSummary(current),
          editMessage: null,
        };
      }

      confirmedTransaction = transitioned;
    } else {
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

      confirmedTransaction = {
        ...transaction,
        category: budgetCategory.category,
        status: "confirmed",
      };
    }

    const summary = this.transactionSummary(confirmedTransaction);

    if (transaction.source === "email") {
      await this.activateValidatedEmailTemplate(confirmedTransaction);
      await this.learnConfirmedEmailTransaction(confirmedTransaction);
    }

    const watchdog = await this.evaluateTransactionWatchdog(
      String(confirmedTransaction.id),
    );
    const editMessage = this.transactionEditMessage(
      String(confirmedTransaction.id),
      summary,
      "confirmed",
      confirmedTransaction,
    );

    return {
      status: "updated",
      pendingTransactionId: null,
      transactionId: String(confirmedTransaction.id),
      confirmationPayload: null,
      summary,
      editMessage: {
        ...editMessage,
        text: this.appendWatchdogMessage(editMessage.text, watchdog),
        parseMode: watchdog.watchdog?.hasAlert ? "HTML" : editMessage.parseMode,
      },
      notifications: watchdog.notifications,
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
    return `Rp${amount.toLocaleString("id-ID")}`;
  }

  private emailTransactionDisplayDate(
    transaction: TransactionRow,
  ): string | null {
    const transactionDate = this.formatNullableTimestamp(
      transaction.transaction_date,
    );

    if (!transactionDate) {
      return null;
    }

    const rawPayload = this.readRecord(transaction.raw_payload);
    const reviewContext = this.readRecord(rawPayload.reviewContext);

    return this.formatDateForTelegram(
      transactionDate,
      this.cleanString(reviewContext.timeZone) ?? null,
      this.cleanString(reviewContext.originalTransactionDate) ?? undefined,
    );
  }

  private formatDateForTelegram(
    value: string,
    timeZone: string | null = null,
    originalValue?: string,
  ): string {
    const date = new Date(value);

    if (Number.isNaN(date.getTime())) {
      return value;
    }

    if (timeZone) {
      try {
        const parts = new Intl.DateTimeFormat("en-US", {
          timeZone,
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        }).formatToParts(date);
        const part = (type: Intl.DateTimeFormatPartTypes) =>
          parts.find((item) => item.type === type)?.value;
        const year = part("year");
        const month = part("month");
        const day = part("day");

        if (year && month && day) {
          return `${year}-${month}-${day}`;
        }
      } catch {
        // Fall back to the validated original offset below.
      }
    }

    const originalDate =
      /^(\d{4}-\d{2}-\d{2})(?:T.*(?:Z|[+-]\d{2}:\d{2}))?$/.exec(
        originalValue ?? "",
      )?.[1];

    if (originalDate) {
      return originalDate;
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
      .join(" ");
  }

  private normalizeSource(value: string | undefined): string | undefined {
    const source = this.cleanString(value)?.toLowerCase();

    if (!source) {
      throw new BadRequestException("source is required");
    }

    if (
      source === "telegram" ||
      source === "email" ||
      source === "manual" ||
      source === "import"
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
      throw new BadRequestException("transactionDate must be a valid date");
    }

    return date.toISOString();
  }

  private calculateConfidence(input: {
    merchant: string | null | undefined;
    merchantNormalized: string | null;
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

  private cleanString(value: unknown): string | undefined {
    const cleaned =
      typeof value === "string"
        ? value.trim()
        : typeof value === "number" || typeof value === "bigint"
          ? String(value)
          : undefined;
    return cleaned ? cleaned : undefined;
  }
}
