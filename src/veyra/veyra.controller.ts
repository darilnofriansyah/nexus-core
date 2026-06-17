import { Body, Controller, Post } from '@nestjs/common';
import { ok } from '../common/dto/api-response.dto';
import { BudgetService } from './budgets/budget.service';
import {
  BudgetUpsertRequestDto,
  BudgetUpsertResponseDto,
} from './budgets/dto/budget-upsert.dto';
import {
  BudgetStatusRequestDto,
  BudgetStatusResponseDto,
} from './budgets/dto/budget-status.dto';
import { VeyraTelegramMessageDto } from './dto/telegram-message.dto';
import { IntentService } from './intent/intent.service';
import { TelegramResponseFormatterService } from './telegram/telegram-response-formatter.service';
import { TransactionService } from './transactions/transaction.service';

@Controller('veyra')
export class VeyraController {
  constructor(
    private readonly budgetService: BudgetService,
    private readonly intentService: IntentService,
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
      telegramText: this.telegramFormatter.formatPlaceholderReply(intent.intent),
      sendTelegramInN8n: true,
    });
  }

  @Post('budgets/status')
  getBudgetStatus(
    @Body() body: BudgetStatusRequestDto,
  ): Promise<BudgetStatusResponseDto> {
    return this.budgetService.getBudgetStatus(body);
  }

  @Post('budgets/upsert')
  upsertBudget(
    @Body() body: BudgetUpsertRequestDto,
  ): Promise<BudgetUpsertResponseDto> {
    return this.budgetService.upsertBudget(body);
  }
}
