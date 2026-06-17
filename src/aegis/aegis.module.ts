import { Module } from '@nestjs/common';
import { AegisController } from './aegis.controller';
import { AegisAlertFormatterService } from './aegis-alert-formatter.service';

@Module({
  controllers: [AegisController],
  providers: [AegisAlertFormatterService],
})
export class AegisModule {}

