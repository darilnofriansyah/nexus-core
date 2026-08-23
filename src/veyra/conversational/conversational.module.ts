import { Module } from '@nestjs/common';
import { ConversationalController } from './conversational.controller';
import { ConversationalRepository } from './conversational.repository';
import { ConversationalService } from './conversational.service';
import { VeyraMessagesModule } from '../messages/messages.module';

@Module({
  imports: [VeyraMessagesModule],
  controllers: [ConversationalController],
  providers: [ConversationalRepository, ConversationalService],
})
export class ConversationalModule {}
