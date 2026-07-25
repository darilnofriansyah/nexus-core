import { Body, Controller, Post } from '@nestjs/common';
import {
  DashboardOverviewRequestDto,
  DashboardOverviewResponseDto,
} from './dto/dashboard-overview.dto';
import { DashboardOverviewService } from './dashboard-overview.service';

@Controller('veyra/dashboard')
export class DashboardOverviewController {
  constructor(private readonly service: DashboardOverviewService) {}

  @Post('overview')
  overview(
    @Body() body: DashboardOverviewRequestDto,
  ): Promise<DashboardOverviewResponseDto> {
    return this.service.getOverview(body);
  }
}
