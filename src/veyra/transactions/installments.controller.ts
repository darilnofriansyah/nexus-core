import { Body, Controller, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import {
  InstallmentPlan,
  InstallmentPreview,
  InstallmentRequest,
} from './dto/installments.dto';
import { InstallmentsService } from './installments.service';

@Controller('veyra/transactions')
export class InstallmentsController {
  constructor(private readonly service: InstallmentsService) {}

  @Post(':id/installments/preview')
  @HttpCode(HttpStatus.OK)
  preview(
    @Param('id') transactionId: string,
    @Body() request: InstallmentRequest,
  ): Promise<InstallmentPreview> {
    return this.service.preview(transactionId, request);
  }

  @Post(':id/installments')
  @HttpCode(HttpStatus.OK)
  create(
    @Param('id') transactionId: string,
    @Body() request: InstallmentRequest,
  ): Promise<InstallmentPlan> {
    return this.service.create(transactionId, request);
  }
}
