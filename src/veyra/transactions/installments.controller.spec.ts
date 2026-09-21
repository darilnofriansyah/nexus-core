import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { HttpStatus } from '@nestjs/common';
import { HTTP_CODE_METADATA, MODULE_METADATA } from '@nestjs/common/constants';
import { InstallmentsController } from './installments.controller';
import { InstallmentsService } from './installments.service';
import { VeyraModule } from '../veyra.module';

const request = {
  telegramUserId: '976684739',
  expectedUpdatedAt: '2026-09-18T04:00:00.000000Z',
  tenorMonths: 6,
  monthlyRatePercent: '1',
  firstDueDate: '2026-10-18',
};

test('installment routes are registered and explicitly return HTTP 200', () => {
  const controllers = Reflect.getMetadata(
    MODULE_METADATA.CONTROLLERS,
    VeyraModule,
  ) as unknown[];

  assert.ok(controllers.includes(InstallmentsController));
  assert.equal(
    Reflect.getMetadata(
      HTTP_CODE_METADATA,
      InstallmentsController.prototype.preview,
    ),
    HttpStatus.OK,
  );
  assert.equal(
    Reflect.getMetadata(
      HTTP_CODE_METADATA,
      InstallmentsController.prototype.create,
    ),
    HttpStatus.OK,
  );
});

test('installment controller delegates preview and create with the route transaction id', async () => {
  const calls: unknown[] = [];
  const service = {
    preview: async (transactionId: string, body: unknown) => {
      calls.push(['preview', transactionId, body]);
      return { originalTransactionId: transactionId };
    },
    create: async (transactionId: string, body: unknown) => {
      calls.push(['create', transactionId, body]);
      return { planId: '7' };
    },
  };
  const controller = new InstallmentsController(
    service as unknown as InstallmentsService,
  );

  assert.deepEqual(await controller.preview('123', request), {
    originalTransactionId: '123',
  });
  assert.deepEqual(await controller.create('123', request), { planId: '7' });
  assert.deepEqual(calls, [
    ['preview', '123', request],
    ['create', '123', request],
  ]);
});
