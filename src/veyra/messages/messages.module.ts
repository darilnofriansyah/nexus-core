import { Module } from '@nestjs/common';
import { VeyraMessageRouteRepository } from './message-route.repository';
import { VeyraMessageRouteService } from './message-route.service';
import { VeyraMessagesController } from './messages.controller';

@Module({
  controllers: [VeyraMessagesController],
  providers: [VeyraMessageRouteRepository, VeyraMessageRouteService],
})
export class VeyraMessagesModule {}
