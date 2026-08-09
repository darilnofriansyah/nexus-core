import { Module } from '@nestjs/common';
import { VeyraAiService } from '../../ai/veyra-ai.service';
import { VeyraMessageRouteRepository } from './message-route.repository';
import { VeyraMessageRouteService } from './message-route.service';
import { VeyraMessagesController } from './messages.controller';

@Module({
  controllers: [VeyraMessagesController],
  providers: [
    VeyraAiService,
    VeyraMessageRouteRepository,
    VeyraMessageRouteService,
  ],
  exports: [VeyraAiService],
})
export class VeyraMessagesModule {}
