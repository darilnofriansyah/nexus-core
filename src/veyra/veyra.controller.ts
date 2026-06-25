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
  TransactionCallbackHandleRequestDto,
  TransactionCallbackHandleResponseDto,
} from './transactions/dto/transaction-callback-handle.dto';
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
  handleTransactionCallback(
    @Body() body: TransactionCallbackHandleRequestDto,
  ): Promise<TransactionCallbackHandleResponseDto> {
    return this.transactionService.handleTransactionCallback(body);
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
