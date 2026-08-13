import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  WebTransactionDto,
  WebTransactionsQueryRequestDto,
  WebTransactionsQueryResponseDto,
  WebTransactionUpdateRequestDto,
} from './dto/web-transactions.dto';
import { WebTransactionsController } from './web-transactions.controller';
import { WebTransactionsService } from './web-transactions.service';

test('web transactions controller delegates query to the service', async () => {
  const request: WebTransactionsQueryRequestDto = {
    telegramUserId: '976684739',
    cycle: 'current',
  };
  const response: WebTransactionsQueryResponseDto = {
    items: [],
    previousCursor: null,
    nextCursor: null,
    categories: ['Dining'],
  };
  const calls: WebTransactionsQueryRequestDto[] = [];
  const service = {
    queryTransactions: async (body: WebTransactionsQueryRequestDto) => {
      calls.push(body);
      return response;
    },
    updateTransaction: async () => transactionResponse,
  };
  const controller = new WebTransactionsController(
    service as unknown as WebTransactionsService,
  );

  const result = await controller.query(request);

  assert.equal(result, response);
  assert.deepEqual(calls, [request]);
});

const transactionResponse: WebTransactionDto = {
  id: '123',
  amount: 25000,
  merchant: 'TUKU',
  category: 'Dining',
  type: 'expense',
  source: 'email',
  transactionDate: '2026-08-13T03:00:00.123456Z',
  updatedAt: '2026-08-13T03:01:00.654321Z',
  creditCard: true,
};

test('web transactions controller delegates update route input without patch logic', async () => {
  const request: WebTransactionUpdateRequestDto = {
    telegramUserId: '976684739',
    amount: 25000,
    expectedUpdatedAt: '2026-08-13T03:01:00.654321Z',
  };
  const calls: Array<{
    transactionId: string;
    request: WebTransactionUpdateRequestDto;
  }> = [];
  const service = {
    queryTransactions: async () => ({
      items: [],
      previousCursor: null,
      nextCursor: null,
      categories: [],
    }),
    updateTransaction: async (input: {
      transactionId: string;
      request: WebTransactionUpdateRequestDto;
    }) => {
      calls.push(input);
      return transactionResponse;
    },
  };
  const controller = new WebTransactionsController(
    service as unknown as WebTransactionsService,
  );

  const result = await controller.update('123', request);

  assert.equal(result, transactionResponse);
  assert.deepEqual(calls, [{ transactionId: '123', request }]);
});
