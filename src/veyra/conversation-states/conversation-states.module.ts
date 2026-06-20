import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { ConversationStateService } from './conversation-state.service';

@Module({
  imports: [DatabaseModule],
  providers: [ConversationStateService],
  exports: [ConversationStateService],
})
export class ConversationStatesModule {}
