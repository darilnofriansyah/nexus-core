import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AegisModule } from './aegis/aegis.module';
import { ApiKeyGuard } from './common/guards/api-key.guard';
import { DatabaseModule } from './database/database.module';
import { HealthController } from './health/health.controller';
import { VeyraModule } from './veyra/veyra.module';

@Module({
  imports: [DatabaseModule, AegisModule, VeyraModule],
  controllers: [HealthController],
  providers: [
    {
      provide: APP_GUARD,
      useClass: ApiKeyGuard,
    },
  ],
})
export class AppModule {}
