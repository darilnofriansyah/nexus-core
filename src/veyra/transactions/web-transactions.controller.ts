import { Body, Controller, Param, Patch, Post } from '@nestjs/common';
import {
  WebTransactionDto,
  WebTransactionsQueryRequestDto,
  WebTransactionsQueryResponseDto,
  WebTransactionUpdateRequestDto,
} from './dto/web-transactions.dto';
import { WebTransactionsService } from './web-transactions.service';

interface WebTransactionsUpdateService {
  updateTransaction(input: {
    transactionId: string;
    request: WebTransactionUpdateRequestDto;
  }): Promise<WebTransactionDto>;
}

@Controller('veyra/transactions')
export class WebTransactionsController {
  constructor(private readonly service: WebTransactionsService) {}

  @Post('query')
  query(
    @Body() body: WebTransactionsQueryRequestDto,
  ): Promise<WebTransactionsQueryResponseDto> {
    return this.service.queryTransactions(body);
  }

  @Patch(':id')
  update(
    @Param('id') transactionId: string,
    @Body() body: WebTransactionUpdateRequestDto,
  ): Promise<WebTransactionDto> {
    const updateService = this.service as WebTransactionsService &
      WebTransactionsUpdateService;
    return updateService.updateTransaction({ transactionId, request: body });
  }
}
