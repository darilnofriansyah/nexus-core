import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  WebTransactionsQueryRequestDto,
  WebTransactionsQueryResponseDto,
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
  };
  const controller = new WebTransactionsController(
    service as unknown as WebTransactionsService,
  );

  const result = await controller.query(request);

  assert.equal(result, response);
  assert.deepEqual(calls, [request]);
});

test('web transactions controller does not expose PATCH behavior before Task 4', () => {
  assert.equal('update' in WebTransactionsController.prototype, false);
});
