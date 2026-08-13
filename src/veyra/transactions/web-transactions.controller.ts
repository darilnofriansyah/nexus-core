import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import {
  WebTransactionDto,
  WebTransactionUpdateRequestDto,
  WebTransactionsQueryRequestDto,
  WebTransactionsQueryResponseDto,
} from './dto/web-transactions.dto';
import { WebTransactionsService } from './web-transactions.service';

@Controller('veyra/transactions')
export class WebTransactionsController {
  constructor(private readonly service: WebTransactionsService) {}

  @Post('query')
  @HttpCode(HttpStatus.OK)
  query(
    @Body() body: WebTransactionsQueryRequestDto,
  ): Promise<WebTransactionsQueryResponseDto> {
    return this.service.queryTransactions(body);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() body: WebTransactionUpdateRequestDto,
  ): Promise<WebTransactionDto> {
    return this.service.updateTransaction({ transactionId: id, request: body });
  }
}
