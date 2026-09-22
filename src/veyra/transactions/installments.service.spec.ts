import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { InstallmentsRepository } from './installments.repository';
import { InstallmentsService } from './installments.service';

const request = {
  telegramUserId: '976684739',
  expectedUpdatedAt: '2026-09-18T04:00:00.000000Z',
  tenorMonths: 6,
  monthlyRatePercent: '1',
  firstDueDate: '2026-10-18',
};

function original(overrides: Record<string, unknown> = {}) {
  return {
    id: '123',
    amount: '6000000.00',
    merchant: 'Electronics',
    category: 'Shopping',
    pocketId: '9',
    transactionType: 'expense',
    source: 'email',
    status: 'confirmed',
    creditCard: true,
    localDate: '2026-09-18',
    updatedAt: '2026-09-18T04:00:00.000000Z',
    ...overrides,
  };
}

class RepositoryFake {
  user: { id: string; timezone: string } | null = {
    id: '1',
    timezone: 'Asia/Jakarta',
  };
  original: ReturnType<typeof original> | null = original();
  createResult: unknown = null;
  createCalls: unknown[] = [];
  postDueInterestCalls: Date[] = [];
  dueInterestResult = { postedCount: 0, hasMore: false };
  userLookups = 0;
  originalLookups = 0;

  async findActiveUserByTelegramId() {
    this.userLookups++;
    return this.user;
  }

  async findOriginal() {
    this.originalLookups++;
    return this.original;
  }

  async create(input: unknown) {
    this.createCalls.push(input);
    return this.createResult;
  }

  async postDueInterest(now: Date) {
    this.postDueInterestCalls.push(now);
    return this.dueInterestResult;
  }
}

function createService() {
  const repository = new RepositoryFake();
  return {
    repository,
    service: new InstallmentsService(
      repository as unknown as InstallmentsRepository,
    ),
  };
}

test('installments preview rejects unknown request fields before querying', async () => {
  const { repository, service } = createService();

  await assert.rejects(
    () => service.preview('123', { ...request, unexpected: true } as never),
    BadRequestException,
  );
  assert.equal(repository.userLookups, 0);
});

test('installments preview hides an original transaction owned by another user', async () => {
  const { repository, service } = createService();
  repository.original = null;

  await assert.rejects(
    () => service.preview('123', request),
    NotFoundException,
  );
});

test('installments preview rejects ineligible originals', async () => {
  const invalidOriginals = [
    original({ status: 'pending' }),
    original({ creditCard: false }),
    original({ transactionType: 'income' }),
  ];

  for (const invalidOriginal of invalidOriginals) {
    const { repository, service } = createService();
    repository.original = invalidOriginal;
    await assert.rejects(
      () => service.preview('123', request),
      BadRequestException,
    );
  }
});

test('installments preview rejects a stale original version', async () => {
  const { repository, service } = createService();
  repository.original = original({
    updatedAt: '2026-09-18T04:00:01.000000Z',
  });

  await assert.rejects(
    () => service.preview('123', request),
    ConflictException,
  );
});

test('installments create maps the locked stale-version result to conflict', async () => {
  const { repository, service } = createService();
  repository.createResult = { kind: 'conflict' };

  await assert.rejects(
    () => service.create('123', request),
    ConflictException,
  );
  assert.equal(repository.createCalls.length, 1);
});

test('installments create returns a matching locked plan before current-timezone due-date validation', async () => {
  const { repository, service } = createService();
  repository.user = { id: '1', timezone: 'Pacific/Kiritimati' };
  repository.original = original({ localDate: '2026-10-19' });
  repository.createResult = {
    kind: 'existing',
    plan: {
      planId: '7',
      originalTransactionId: '123',
      originalUpdatedAt: request.expectedUpdatedAt,
      principal: 6_000_000,
      totalInterest: 360_000,
      totalPayable: 6_360_000,
      timezone: 'Asia/Jakarta',
      terms: {
        tenorMonths: 6,
        monthlyRatePercent: '1',
        firstDueDate: '2026-10-18',
      },
      items: [],
    },
  };

  assert.equal((await service.create('123', request)).planId, '7');
  assert.equal(repository.originalLookups, 0);
  assert.equal(repository.createCalls.length, 1);
});

test('installments preview returns canonical server-calculated terms', async () => {
  const { service } = createService();

  const preview = await service.preview('123', {
    ...request,
    monthlyRatePercent: '1.0',
  });

  assert.deepEqual(preview, {
    originalTransactionId: '123',
    originalUpdatedAt: '2026-09-18T04:00:00.000000Z',
    principal: 6_000_000,
    totalInterest: 360_000,
    totalPayable: 6_360_000,
    timezone: 'Asia/Jakarta',
    terms: {
      tenorMonths: 6,
      monthlyRatePercent: '1',
      firstDueDate: '2026-10-18',
    },
    items: [
      { sequence: 1, dueDate: '2026-10-18', principal: 1_000_000, interest: 60_000, total: 1_060_000 },
      { sequence: 2, dueDate: '2026-11-18', principal: 1_000_000, interest: 60_000, total: 1_060_000 },
      { sequence: 3, dueDate: '2026-12-18', principal: 1_000_000, interest: 60_000, total: 1_060_000 },
      { sequence: 4, dueDate: '2027-01-18', principal: 1_000_000, interest: 60_000, total: 1_060_000 },
      { sequence: 5, dueDate: '2027-02-18', principal: 1_000_000, interest: 60_000, total: 1_060_000 },
      { sequence: 6, dueDate: '2027-03-18', principal: 1_000_000, interest: 60_000, total: 1_060_000 },
    ],
  });
});

test('installments posts due interest using its internal clock', async () => {
  const { repository } = createService();
  const service = new (class extends InstallmentsService {
    protected currentTime(): Date {
      return new Date('2026-10-18T00:00:00.000Z');
    }
  })(repository as unknown as InstallmentsRepository);
  repository.dueInterestResult = { postedCount: 1, hasMore: true };

  assert.deepEqual(await service.postDueInterest(), { postedCount: 1, hasMore: true });
  assert.deepEqual(repository.postDueInterestCalls, [new Date('2026-10-18T00:00:00.000Z')]);
});
