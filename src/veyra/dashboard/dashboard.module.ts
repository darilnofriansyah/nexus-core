import { Module } from '@nestjs/common';
import { DashboardOverviewController } from './dashboard-overview.controller';
import { DashboardOverviewRepository } from './dashboard-overview.repository';
import { DashboardOverviewService } from './dashboard-overview.service';

@Module({
  controllers: [DashboardOverviewController],
  providers: [DashboardOverviewRepository, DashboardOverviewService],
})
export class DashboardModule {}
