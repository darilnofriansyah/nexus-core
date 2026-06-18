import { Module } from '@nestjs/common';
import { BudgetsModule } from './budgets/budgets.module';
import { IntentService } from './intent/intent.service';
import { IntentsModule } from './intents/intents.module';
import { TelegramResponseFormatterService } from './telegram/telegram-response-formatter.service';
import { TransactionService } from './transactions/transaction.service';
import { VeyraController } from './veyra.controller';

@Module({
  imports: [BudgetsModule, IntentsModule],
  controllers: [VeyraController],
  providers: [
    IntentService,
    TelegramResponseFormatterService,
    TransactionService,
  ],
})
export class VeyraModule {}
