import { Module } from '@nestjs/common';
import { ConversationStatesModule } from './conversation-states/conversation-states.module';
import { ConversationalModule } from './conversational/conversational.module';
import { BudgetsModule } from './budgets/budgets.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { IntentService } from './intent/intent.service';
import { IntentsModule } from './intents/intents.module';
import { VeyraMessagesModule } from './messages/messages.module';
import { TelegramResponseFormatterService } from './telegram/telegram-response-formatter.service';
import { EmailParserTemplateRepository } from './transactions/email-parser-template.repository';
import { TransactionRiskReviewRepository } from './transactions/transaction-risk-review.repository';
import { TransactionService } from './transactions/transaction.service';
import { WebTransactionsController } from './transactions/web-transactions.controller';
import { WebTransactionsRepository } from './transactions/web-transactions.repository';
import { WebTransactionsService } from './transactions/web-transactions.service';
import { VeyraController } from './veyra.controller';

@Module({
  imports: [
    BudgetsModule,
    ConversationStatesModule,
    ConversationalModule,
    DashboardModule,
    IntentsModule,
    VeyraMessagesModule,
  ],
  controllers: [VeyraController, WebTransactionsController],
  providers: [
    IntentService,
    TelegramResponseFormatterService,
    EmailParserTemplateRepository,
    TransactionRiskReviewRepository,
    TransactionService,
    WebTransactionsRepository,
    WebTransactionsService,
  ],
})
export class VeyraModule {}
