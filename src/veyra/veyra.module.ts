import { Module } from '@nestjs/common';
import { ConversationStatesModule } from './conversation-states/conversation-states.module';
import { ConversationalModule } from './conversational/conversational.module';
import { BudgetsModule } from './budgets/budgets.module';
import { CategoriesModule } from './categories/categories.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { IntentService } from './intent/intent.service';
import { IntentsModule } from './intents/intents.module';
import { VeyraMessagesModule } from './messages/messages.module';
import { TelegramResponseFormatterService } from './telegram/telegram-response-formatter.service';
import { EmailParserTemplateRepository } from './transactions/email-parser-template.repository';
import { InstallmentsController } from './transactions/installments.controller';
import { InstallmentsRepository } from './transactions/installments.repository';
import { InstallmentsService } from './transactions/installments.service';
import { TransactionRiskReviewRepository } from './transactions/transaction-risk-review.repository';
import { TransactionService } from './transactions/transaction.service';
import { TransactionTimelineRepository } from './transactions/transaction-timeline.repository';
import { TransactionTimelineService } from './transactions/transaction-timeline.service';
import { WebTransactionsController } from './transactions/web-transactions.controller';
import { WebTransactionsRepository } from './transactions/web-transactions.repository';
import { WebTransactionsService } from './transactions/web-transactions.service';
import { VeyraController } from './veyra.controller';

@Module({
  imports: [
    BudgetsModule,
    CategoriesModule,
    ConversationStatesModule,
    ConversationalModule,
    DashboardModule,
    IntentsModule,
    VeyraMessagesModule,
  ],
  controllers: [VeyraController, WebTransactionsController, InstallmentsController],
  providers: [
    IntentService,
    TelegramResponseFormatterService,
    EmailParserTemplateRepository,
    InstallmentsRepository,
    InstallmentsService,
    TransactionRiskReviewRepository,
    TransactionService,
    TransactionTimelineRepository,
    TransactionTimelineService,
    WebTransactionsRepository,
    WebTransactionsService,
  ],
})
export class VeyraModule {}
