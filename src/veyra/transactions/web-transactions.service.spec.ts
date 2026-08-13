import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import {
  WebTransactionRow,
  WebTransactionsFilter,
  WebTransactionsQueryRequestDto,
  WebTransactionsUser,
} from './dto/web-transactions.dto';
import { WebTransactionsRepository } from './web-transactions.repository';
import { WebTransactionsService } from './web-transactions.service';

function row(overrides: Partial<WebTransactionRow> = {}): WebTransactionRow {
  return {
    id: '123',
    amount: 25000,
    merchant: 'TUKU',
    category: 'Dining',
    transactionType: 'expense',
    source: 'email',
    transactionDate: '2026-08-13T03:00:00.123456Z',
    updatedAt: '2026-08-13T03:01:00.654321Z',
    creditCard: true,
    ...overrides,
  };
}

class RepositoryFake {
  user: WebTransactionsUser | null = {
    id: '1',
    telegramUserId: '976684739',
    cycleStartDay: 15,
  };
  rows: WebTransactionRow[] = [];
  categories = ['Dining'];
  userLookups: string[] = [];
  transactionCalls: Array<{ userId: string; filter: WebTransactionsFilter }> =
    [];
  categoryCalls: Array<{
    userId: string;
    filter: Omit<
      WebTransactionsFilter,
      'category' | 'cursor' | 'direction' | 'limit'
    >;
  }> = [];

  async findActiveUserByTelegramId(
    telegramUserId: string,
  ): Promise<WebTransactionsUser | null> {
    this.userLookups.push(telegramUserId);
    return this.user;
  }

  async findTransactions(
    userId: string,
    filter: WebTransactionsFilter,
  ): Promise<WebTransactionRow[]> {
    this.transactionCalls.push({ userId, filter });
    return this.rows;
  }

  async findCategories(
    userId: string,
    filter: Omit<
      WebTransactionsFilter,
      'category' | 'cursor' | 'direction' | 'limit'
    >,
  ): Promise<string[]> {
    this.categoryCalls.push({ userId, filter });
    return this.categories;
  }
}

function createService() {
  const repository = new RepositoryFake();
  return {
    repository,
    service: new WebTransactionsService(
      repository as unknown as WebTransactionsRepository,
    ),
  };
}

function decodeCursor(cursor: string | null): unknown {
  return cursor
    ? JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    : null;
}

test('web transactions service rejects invalid public query values and forbidden fields', async () => {
  const invalidRequests: WebTransactionsQueryRequestDto[] = [
    { telegramUserId: 'x' },
    { telegramUserId: 0 },
    { telegramUserId: '9223372036854775808' },
    { telegramUserId: '1', cursor: 'not-base64' },
    { telegramUserId: '1', cycle: 'future' as never },
    { telegramUserId: '1', asOfDate: '2026-02-31' },
    { telegramUserId: '1', type: 'transfer' as never },
    { telegramUserId: '1', limit: 0 },
    { telegramUserId: '1', limit: 51 },
    { telegramUserId: '1', timezone: 'Mars/Olympus' },
    { telegramUserId: '1', category: ' ' },
    { telegramUserId: '1', merchantQuery: 'x'.repeat(201) },
    { telegramUserId: '1', direction: 'back' as never },
    { telegramUserId: '1', startDate: '2026-08-01' } as never,
    { telegramUserId: '1', status: 'confirmed' } as never,
    { telegramUserId: '1', sort: 'amount' } as never,
  ];
  const { repository, service } = createService();

  for (const request of invalidRequests) {
    await assert.rejects(
      () => service.queryTransactions(request),
      BadRequestException,
    );
  }

  assert.equal(repository.userLookups.length, 0);
});

test('web transactions service rejects malformed or non-exact cursor payloads', async () => {
  const cursors = [
    {},
    { id: '1' },
    { transactionDate: '2026-08-13T03:00:00.000000Z' },
    {
      transactionDate: '2026-08-13T03:00:00.000000Z',
      id: '1',
      extra: true,
    },
    { transactionDate: '2026-02-31T03:00:00.000000Z', id: '1' },
    { transactionDate: '2026-08-13T24:00:00.000000Z', id: '1' },
    { transactionDate: '2026-08-13T03:00:00.000Z', id: '1' },
    { transactionDate: '2026-08-13T03:00:00.000000Z', id: '0' },
    {
      transactionDate: '2026-08-13T03:00:00.000000Z',
      id: '9223372036854775808',
    },
  ].map((value) => Buffer.from(JSON.stringify(value)).toString('base64url'));
  const { service } = createService();

  for (const cursor of cursors) {
    await assert.rejects(
      () => service.queryTransactions({ telegramUserId: '1', cursor }),
      BadRequestException,
    );
  }
});

test('web transactions service returns the same not found error for an inactive or unknown identity', async () => {
  const { repository, service } = createService();
  repository.user = null;

  await assert.rejects(
    () => service.queryTransactions({ telegramUserId: '976684739' }),
    NotFoundException,
  );
});

test('web transactions service resolves current and previous financial cycle boundaries after user lookup', async () => {
  const { repository, service } = createService();

  await service.queryTransactions({
    telegramUserId: '976684739',
    cycle: 'current',
    asOfDate: '2026-08-13',
    timezone: 'Asia/Jakarta',
  });
  await service.queryTransactions({
    telegramUserId: '976684739',
    cycle: 'previous',
    asOfDate: '2026-08-13',
    timezone: 'Asia/Jakarta',
  });

  assert.equal(repository.transactionCalls[0]?.filter.startDate, '2026-07-15');
  assert.equal(repository.transactionCalls[0]?.filter.endDate, '2026-08-15');
  assert.equal(repository.transactionCalls[1]?.filter.startDate, '2026-06-15');
  assert.equal(repository.transactionCalls[1]?.filter.endDate, '2026-07-15');
  assert.equal(repository.userLookups.length, 2);
  assert.deepEqual(
    repository.categoryCalls.map(({ filter }) => ({
      startDate: filter.startDate,
      endDate: filter.endDate,
    })),
    [
      { startDate: '2026-07-15', endDate: '2026-08-15' },
      { startDate: '2026-06-15', endDate: '2026-07-15' },
    ],
  );
});

test('web transactions service clamps cycle boundaries to shorter month ends', async () => {
  const { repository, service } = createService();
  repository.user = {
    id: '1',
    telegramUserId: '976684739',
    cycleStartDay: 31,
  };

  await service.queryTransactions({
    telegramUserId: '976684739',
    cycle: 'current',
    asOfDate: '2026-03-01',
  });

  assert.equal(repository.transactionCalls[0]?.filter.startDate, '2026-02-28');
  assert.equal(repository.transactionCalls[0]?.filter.endDate, '2026-03-31');
});

test('web transactions service normalizes filters and queries rows and categories by internal user id', async () => {
  const { repository, service } = createService();

  await service.queryTransactions({
    telegramUserId: 976684739,
    type: 'expense',
    category: ' Dining ',
    merchantQuery: ' tuku ',
    limit: 25,
  });

  assert.deepEqual(repository.userLookups, ['976684739']);
  assert.equal(repository.transactionCalls[0]?.userId, '1');
  assert.equal(repository.transactionCalls[0]?.filter.category, 'Dining');
  assert.equal(repository.transactionCalls[0]?.filter.merchantQuery, 'tuku');
  assert.equal(repository.transactionCalls[0]?.filter.limit, 25);
  assert.equal(repository.categoryCalls[0]?.userId, '1');
  assert.equal(
    'category' in (repository.categoryCalls[0]?.filter ?? {}),
    false,
  );
});

test('web transactions service maps only public fields and preserves microsecond timestamp cursor text', async () => {
  const { repository, service } = createService();
  repository.rows = [
    row(),
    row({
      id: '122',
      transactionDate: '2026-08-12T03:00:00.000001Z',
      updatedAt: '2026-08-12T03:01:00.000002Z',
    }),
  ];

  const result = await service.queryTransactions({
    telegramUserId: '976684739',
    limit: 1,
  });

  assert.deepEqual(decodeCursor(result.nextCursor), {
    transactionDate: '2026-08-13T03:00:00.123456Z',
    id: '123',
  });
  assert.equal(result.previousCursor, null);
  assert.deepEqual(Object.keys(result.items[0] ?? {}).sort(), [
    'amount',
    'category',
    'creditCard',
    'id',
    'merchant',
    'source',
    'transactionDate',
    'type',
    'updatedAt',
  ]);
  assert.equal(result.items[0]?.transactionDate, row().transactionDate);
  assert.equal(result.items[0]?.updatedAt, row().updatedAt);
});

test('web transactions service returns duplicate-timestamp previous page in newest-first order', async () => {
  const { repository, service } = createService();
  repository.rows = [
    row({ id: '125' }),
    row({ id: '124' }),
    row({ id: '123' }),
  ];
  const cursor = Buffer.from(
    JSON.stringify({
      transactionDate: '2026-08-13T03:00:00.123456Z',
      id: '122',
    }),
  ).toString('base64url');

  const result = await service.queryTransactions({
    telegramUserId: '976684739',
    cursor,
    direction: 'previous',
    limit: 2,
  });

  assert.deepEqual(
    result.items.map(({ id }) => id),
    ['124', '123'],
  );
  assert.deepEqual(decodeCursor(result.previousCursor), {
    transactionDate: '2026-08-13T03:00:00.123456Z',
    id: '124',
  });
});

test('web transactions service does not expose a previous cursor without a request cursor', async () => {
  const { repository, service } = createService();
  repository.rows = [
    row({ id: '125' }),
    row({ id: '124' }),
    row({ id: '123' }),
  ];

  const result = await service.queryTransactions({
    telegramUserId: '976684739',
    direction: 'previous',
    limit: 2,
  });

  assert.equal(result.previousCursor, null);
});

test('web transactions service maps unsafe or non-whole IDR amounts to safe integers', async () => {
  const { repository, service } = createService();
  repository.rows = [
    row({ amount: 25000.49 }),
    row({ id: '122', amount: Number.POSITIVE_INFINITY }),
  ];

  const result = await service.queryTransactions({
    telegramUserId: '976684739',
  });

  assert.deepEqual(
    result.items.map(({ amount }) => amount),
    [25000, 0],
  );
});
