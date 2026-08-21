import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { HttpStatus } from '@nestjs/common';
import { HTTP_CODE_METADATA, MODULE_METADATA } from '@nestjs/common/constants';
import { APP_GUARD } from '@nestjs/core';
import { AppModule } from '../../app.module';
import { ApiKeyGuard } from '../../common/guards/api-key.guard';
import { VeyraModule } from '../veyra.module';
import {
  WebTransactionDto,
  WebTransactionUpdateRequestDto,
  WebTransactionsQueryRequestDto,
  WebTransactionsQueryResponseDto,
} from './dto/web-transactions.dto';
import { WebTransactionsController } from './web-transactions.controller';
import { WebTransactionsService } from './web-transactions.service';

test('web transaction routes are registered under the globally API-key-guarded app', () => {
  const appImports = Reflect.getMetadata(
    MODULE_METADATA.IMPORTS,
    AppModule,
  ) as unknown[];
  const appProviders = Reflect.getMetadata(
    MODULE_METADATA.PROVIDERS,
    AppModule,
  ) as Array<{ provide?: unknown; useClass?: unknown }>;
  const veyraControllers = Reflect.getMetadata(
    MODULE_METADATA.CONTROLLERS,
    VeyraModule,
  ) as unknown[];

  assert.ok(appImports.includes(VeyraModule));
  assert.ok(veyraControllers.includes(WebTransactionsController));
  assert.ok(
    appProviders.some(
      (provider) =>
        provider.provide === APP_GUARD && provider.useClass === ApiKeyGuard,
    ),
  );
});

test('web transactions query explicitly returns HTTP 200', () => {
  assert.equal(
    Reflect.getMetadata(
      HTTP_CODE_METADATA,
      WebTransactionsController.prototype.query,
    ),
    HttpStatus.OK,
  );
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
    pocketId: '9',
  };
  const response: WebTransactionDto = {
    id: '123',
    amount: 30000,
    merchant: 'TUKU',
    category: 'Dining',
    pocketId: '9',
    pocketName: 'Daily',
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
