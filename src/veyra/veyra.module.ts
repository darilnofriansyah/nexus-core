import { Module } from '@nestjs/common';
import { ConversationStatesModule } from './conversation-states/conversation-states.module';
import { BudgetsModule } from './budgets/budgets.module';
import { IntentService } from './intent/intent.service';
import { IntentsModule } from './intents/intents.module';
import { TelegramResponseFormatterService } from './telegram/telegram-response-formatter.service';
import { TransactionService } from './transactions/transaction.service';
import { VeyraController } from './veyra.controller';

@Module({
  imports: [BudgetsModule, ConversationStatesModule, IntentsModule],
  controllers: [VeyraController],
  providers: [
    IntentService,
    TelegramResponseFormatterService,
    TransactionService,
  ],
})
export class VeyraModule {}
