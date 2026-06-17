import { Module } from '@nestjs/common';
import { BudgetsModule } from './budgets/budgets.module';
import { IntentService } from './intent/intent.service';
import { TelegramResponseFormatterService } from './telegram/telegram-response-formatter.service';
import { TransactionService } from './transactions/transaction.service';
import { VeyraController } from './veyra.controller';

@Module({
  imports: [BudgetsModule],
  controllers: [VeyraController],
  providers: [
    IntentService,
    TelegramResponseFormatterService,
    TransactionService,
  ],
})
export class VeyraModule {}
