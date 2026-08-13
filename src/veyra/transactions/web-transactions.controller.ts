import { Body, Controller, Post } from '@nestjs/common';
import {
  WebTransactionsQueryRequestDto,
  WebTransactionsQueryResponseDto,
} from './dto/web-transactions.dto';
import { WebTransactionsService } from './web-transactions.service';

@Controller('veyra/transactions')
export class WebTransactionsController {
  constructor(private readonly service: WebTransactionsService) {}

  @Post('query')
  query(
    @Body() body: WebTransactionsQueryRequestDto,
  ): Promise<WebTransactionsQueryResponseDto> {
    return this.service.queryTransactions(body);
  }
}
