import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiResponse, ok } from '../common/dto/api-response.dto';
import {
  BudgetHandleRequestDto,
  BudgetHandleResponseDto,
  BudgetService,
} from './budgets/budget.service';
import { ConversationStateService } from './conversation-states/conversation-state.service';
import {
  ConversationStateResponseDto,
  ResetConversationStateRequestDto,
  UpsertConversationStateRequestDto,
} from './conversation-states/dto/conversation-state.dto';
import {
  BudgetUpsertRequestDto,
  BudgetUpsertResponseDto,
} from './budgets/dto/budget-upsert.dto';
import {
  BudgetStatusRequestDto,
  BudgetStatusResponseDto,
} from './budgets/dto/budget-status.dto';
import {
  BudgetCategoriesRequestDto,
  BudgetCategoriesResponseDto,
} from './budgets/dto/budget-categories.dto';
import {
  OverspendingCheckRequestDto,
  OverspendingCheckResponseDto,
  OverspendingHandleRequestDto,
  OverspendingHandleResponseDto,
  OverspendingRecordRequestDto,
  OverspendingRecordResponseDto,
} from './budgets/dto/overspending-check.dto';
import { VeyraTelegramMessageDto } from './dto/telegram-message.dto';
import { IntentService } from './intent/intent.service';
import {
  ClassifyIntentRequestDto,
  ClassifyIntentResponseDto,
} from './intents/dto/classify-intent.dto';
import { IntentsService } from './intents/intents.service';
import { TelegramResponseFormatterService } from './telegram/telegram-response-formatter.service';
import {
  TransactionConfirmationPayloadRequestDto,
  TransactionConfirmationPayloadResponseDto,
} from './transactions/dto/confirmation-payload.dto';
import {
  ConfirmTransactionRequestDto,
  ConfirmTransactionResponseDto,
} from './transactions/dto/confirm-transaction.dto';
import {
  TransactionCategoryOptionsRequestDto,
  TransactionCategoryOptionsResponseDto,
  TransactionSetCategoryRequestDto,
  TransactionSetCategoryResponseDto,
} from './transactions/dto/category-callback.dto';
import {
  NormalizeTransactionRequestDto,
  NormalizeTransactionResponseDto,
} from './transactions/dto/normalize-transaction.dto';
import {
  TransactionHandleRequestDto,
  TransactionHandleResponseDto,
} from './transactions/dto/handle-transaction.dto';
import {
  EmailTransactionHandleRequestDto,
  EmailTransactionHandleResponseDto,
  EmailTransactionResolveReviewRequestDto,
  EmailTransactionResolveReviewResponseDto,
} from './transactions/dto/email-transaction.dto';
import {
  TransactionCallbackDispatchRequestDto,
  TransactionCallbackHandleResponseDto,
} from './transactions/dto/transaction-callback-handle.dto';
import {
  CreateRegretReviewRequestDto,
  CreateRegretReviewResponseDto,
} from './transactions/dto/transaction-risk-review.dto';
import {
  TransactionManageHandleRequestDto,
  TransactionManageHandleResponseDto,
} from './transactions/dto/transaction-manage.dto';
import { TransactionService } from './transactions/transaction.service';

@Controller('veyra')
export class VeyraController {
  constructor(
    private readonly budgetService: BudgetService,
    private readonly conversationStateService: ConversationStateService,
    private readonly intentService: IntentService,
    private readonly intentsService: IntentsService,
    private readonly telegramFormatter: TelegramResponseFormatterService,
    private readonly transactionService: TransactionService,
  ) {}

  @Post('telegram/messages')
  handleTelegramMessage(@Body() body: VeyraTelegramMessageDto) {
    const intent = this.intentService.detectIntent(body.messageText);

    return ok({
      intent,
      budget: this.budgetService.placeholderStatus(),
      transaction: this.transactionService.placeholderStatus(),
      telegramText: this.telegramFormatter.formatPlaceholderReply(
        intent.intent,
      ),
      sendTelegramInN8n: true,
    });
  }

  @Post('intents/classify')
  classifyIntent(
    @Body() body: ClassifyIntentRequestDto,
  ): ClassifyIntentResponseDto {
    return this.intentsService.classify(body);
  }

  @Get('conversation-states/:userId')
  getConversationState(
    @Param('userId') userId: string,
  ): Promise<ConversationStateResponseDto> {
    return this.conversationStateService.getState(userId);
  }

  @Post('conversation-states')
  upsertConversationState(
    @Body() body: UpsertConversationStateRequestDto,
  ): Promise<ConversationStateResponseDto> {
    return this.conversationStateService.upsertState(body);
  }

  @Post('conversation-states/reset')
  resetConversationState(
    @Body() body: ResetConversationStateRequestDto,
  ): Promise<ConversationStateResponseDto> {
    return this.conversationStateService.resetState(body);
  }

  @Post('budgets/status')
  getBudgetStatus(
    @Body() body: BudgetStatusRequestDto,
  ): Promise<BudgetStatusResponseDto> {
    return this.budgetService.getBudgetStatus(body);
  }

  @Post('budgets/categories')
  getBudgetCategories(
    @Body() body: BudgetCategoriesRequestDto,
  ): Promise<BudgetCategoriesResponseDto> {
    return this.budgetService.getBudgetCategories(body);
  }

  @Post('budgets/handle')
  handleBudget(
    @Body() body: BudgetHandleRequestDto,
  ): Promise<BudgetHandleResponseDto> {
    return this.budgetService.handleBudgetRequest(
      body,
      this.conversationStateService,
    );
  }

  @Post('budgets/upsert')
  upsertBudget(
    @Body() body: BudgetUpsertRequestDto,
  ): Promise<BudgetUpsertResponseDto> {
    return this.budgetService.upsertBudget(body);
  }

  @Post('budgets/overspending-check')
  checkOverspending(
    @Body() body: OverspendingCheckRequestDto,
  ): Promise<OverspendingCheckResponseDto> {
    return this.budgetService.checkOverspending(body);
  }

  @Post('budgets/overspending/handle')
  handleOverspending(
    @Body() body: OverspendingHandleRequestDto,
  ): Promise<OverspendingHandleResponseDto> {
    return this.budgetService.handleOverspending(body);
  }

  @Post('budgets/overspending/record')
  recordOverspending(
    @Body() body: OverspendingRecordRequestDto,
  ): Promise<OverspendingRecordResponseDto> {
    return this.budgetService.recordOverspendingAlert(body);
  }

  @Post('transactions/normalize')
  normalizeTransaction(
    @Body() body: NormalizeTransactionRequestDto,
  ): Promise<NormalizeTransactionResponseDto> {
    return this.transactionService.normalizeTransaction(body);
  }

  @Post('transactions/handle')
  async handleTransaction(
    @Body() body: TransactionHandleRequestDto,
  ): Promise<ApiResponse<TransactionHandleResponseDto>> {
    return ok(
      await this.transactionService.handleManualTransaction(
        body,
        this.conversationStateService,
      ),
    );
  }

  @Post('transactions/email/handle')
  handleEmailTransaction(
    @Body() body: EmailTransactionHandleRequestDto,
  ): Promise<EmailTransactionHandleResponseDto> {
    return this.transactionService.handleEmailTransaction(body);
  }

  @Post('transactions/email/resolve-review')
  resolveEmailTransactionReview(
    @Body() body: EmailTransactionResolveReviewRequestDto,
  ): Promise<EmailTransactionResolveReviewResponseDto> {
    return this.transactionService.resolveEmailTransactionReview(body);
  }

  @Post('transactions/risk-reviews/regret-detector')
  createRegretDetectorReview(
    @Body() body: CreateRegretReviewRequestDto,
  ): Promise<CreateRegretReviewResponseDto> {
    return this.transactionService.createRegretDetectorReview(body);
  }

  @Post('transactions/manage/handle')
  handleManagedTransaction(
    @Body() body: TransactionManageHandleRequestDto,
  ): Promise<TransactionManageHandleResponseDto> {
    return this.transactionService.handleManagedTransaction(
      body,
      this.conversationStateService,
    );
  }

  @Post('transactions/confirmation-payload')
  buildTransactionConfirmationPayload(
    @Body() body: TransactionConfirmationPayloadRequestDto,
  ): TransactionConfirmationPayloadResponseDto {
    return this.transactionService.buildConfirmationPayload(body);
  }

  @Post('transactions/confirm')
  confirmTransaction(
    @Body() body: ConfirmTransactionRequestDto,
  ): Promise<ConfirmTransactionResponseDto> {
    return this.transactionService.confirmTransaction(body);
  }

  @Post('transactions/cancel')
  cancelTransaction(
    @Body() body: ConfirmTransactionRequestDto,
  ): Promise<ConfirmTransactionResponseDto> {
    return this.transactionService.cancelTransaction(body);
  }

  @Post('transactions/callback/handle')
  async handleTransactionCallback(
    @Body() body: TransactionCallbackDispatchRequestDto,
  ): Promise<TransactionCallbackHandleResponseDto> {
    const callbackData = this.readCallbackData(body);

    if (callbackData.startsWith('veyra_tx_manage:')) {
      const response = await this.transactionService.handleManagedTransaction(
        {
          telegramUserId: this.readTelegramUserId(body),
          text: callbackData,
          llmResult: null,
          statePayload: {},
        },
        this.conversationStateService,
      );

      return this.formatManageCallbackResponse(response, body);
    }

    return this.transactionService.handleTransactionCallback(
      {
        telegramUserId: this.readTelegramUserId(body),
        userId: this.readNumber(body.userId ?? body.user_id),
        callbackData,
        chatId: this.readChatId(
          body.chatId ?? this.readCallbackQuery(body)?.message?.chat?.id,
        ),
        messageId: this.readNumber(
          body.messageId ?? this.readCallbackQuery(body)?.message?.message_id,
        ),
      },
      this.conversationStateService,
    );
  }

  private formatManageCallbackResponse(
    response: TransactionManageHandleResponseDto,
    body: TransactionCallbackDispatchRequestDto,
  ): TransactionCallbackHandleResponseDto {
    const transactionId = this.readManageResponseTransactionId(response);

    return {
      status: response.ok ? 'ok' : 'error',
      action: 'veyra_tx_manage',
      ...(transactionId ? { transactionId } : {}),
      telegram: {
        method: 'editMessageText',
        chat_id: this.readChatId(
          body.chatId ?? this.readCallbackQuery(body)?.message?.chat?.id,
        ),
        message_id: this.readPositiveNumber(
          body.messageId ?? this.readCallbackQuery(body)?.message?.message_id,
        ),
        text: response.message,
        parse_mode: 'HTML',
        reply_markup: response.reply_markup,
      },
    };
  }

  private readManageResponseTransactionId(
    response: TransactionManageHandleResponseDto,
  ): number | undefined {
    const dataTransaction = this.readRecord(response.data.transaction);
    const stateData = this.readRecord(response.state.state_data);
    const before = this.readRecord(stateData.before);

    return this.readPositiveNumber(
      dataTransaction.id ?? stateData.transaction_id ?? before.id,
    );
  }

  private readCallbackData(body: TransactionCallbackDispatchRequestDto): string {
    return this.readString(
      body.callbackData ??
        body.data ??
        body.text ??
        this.readCallbackQuery(body)?.data,
    );
  }

  private readTelegramUserId(
    body: TransactionCallbackDispatchRequestDto,
  ): string {
    return this.readString(
      body.telegramUserId ?? this.readCallbackQuery(body)?.from?.id,
    );
  }

  private readCallbackQuery(
    body: TransactionCallbackDispatchRequestDto,
  ): TransactionCallbackDispatchRequestDto['callback_query'] {
    return body.callback_query ?? body.callbackQuery;
  }

  private readString(value: unknown): string {
    if (typeof value === 'string') {
      return value.trim();
    }

    if (typeof value === 'number' || typeof value === 'bigint') {
      return String(value);
    }

    return '';
  }

  private readChatId(value: unknown): string | number | undefined {
    return typeof value === 'string' || typeof value === 'number'
      ? value
      : undefined;
  }

  private readNumber(value: unknown): number {
    const parsed =
      typeof value === 'number' ? value : Number(this.readString(value));

    return Number.isSafeInteger(parsed) ? parsed : 0;
  }

  private readPositiveNumber(value: unknown): number | undefined {
    const parsed = this.readNumber(value);

    return parsed > 0 ? parsed : undefined;
  }

  private readRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object'
      ? (value as Record<string, unknown>)
      : {};
  }

  @Post('transactions/category-options')
  buildTransactionCategoryOptions(
    @Body() body: TransactionCategoryOptionsRequestDto,
  ): Promise<TransactionCategoryOptionsResponseDto> {
    return this.transactionService.buildCategoryOptions(body);
  }

  @Post('transactions/set-category')
  setTransactionCategory(
    @Body() body: TransactionSetCategoryRequestDto,
  ): Promise<TransactionSetCategoryResponseDto> {
    return this.transactionService.setPendingTransactionCategory(body);
  }
}
