import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  WebTransactionDto,
  WebTransactionUpdateRequestDto,
  WebTransactionsQueryRequestDto,
  WebTransactionsQueryResponseDto,
} from './dto/web-transactions.dto';
import { WebTransactionsController } from './web-transactions.controller';
import { WebTransactionsService } from './web-transactions.service';

test('web transaction routes are registered under the globally API-key-guarded app', () => {
  assert.equal(WebTransactionsController.name, 'WebTransactionsController');
  assert.match(readFileSync('src/app.module.ts', 'utf8'), /provide: APP_GUARD/);
  assert.match(readFileSync('src/app.module.ts', 'utf8'), /useClass: ApiKeyGuard/);
});

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

test('web transactions controller delegates update to the real service method', async () => {
  const request: WebTransactionUpdateRequestDto = {
    telegramUserId: '976684739',
    expectedUpdatedAt: '2026-08-13T03:01:00.654321Z',
    amount: 30000,
  };
  const response: WebTransactionDto = {
    id: '123',
    amount: 30000,
    merchant: 'TUKU',
    category: 'Dining',
    type: 'expense',
    source: 'email',
    transactionDate: '2026-08-13T03:00:00.123456Z',
    updatedAt: '2026-08-13T04:00:00.000001Z',
    creditCard: true,
  };
  const calls: unknown[] = [];
  const service = {
    updateTransaction: async (input: unknown) => {
      calls.push(input);
      return response;
    },
  };
  const controller = new WebTransactionsController(
    service as unknown as WebTransactionsService,
  );

  const result = await controller.update('123', request);

  assert.equal(result, response);
  assert.deepEqual(calls, [{ transactionId: '123', request }]);
});
