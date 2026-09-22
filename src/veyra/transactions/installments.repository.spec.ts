import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseService } from '../../database/database.service';
import { InstallmentsRepository } from './installments.repository';

const originalRow = {
  id: '123',
  amount: '6000000.00',
  merchant: 'Electronics',
  category: 'Shopping',
  pocket_id: '9',
  transaction_type: 'expense',
  source: 'email',
  status: 'confirmed',
  credit_card: true,
  local_date: '2026-09-18',
  updated_at: '2026-09-18T04:00:00.000000Z',
};

function createRepository(rowsByCall: unknown[][] = []) {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const database = {
    query: async (text: string, values: unknown[] = []) => {
      calls.push({ text, values });
      return { rows: rowsByCall.shift() ?? [] };
    },
    withTransaction: async <T>(
      callback: (client: { query: typeof database.query }) => Promise<T>,
    ) => callback(database),
  } as unknown as DatabaseService;

  return { calls, repository: new InstallmentsRepository(database) };
}

test('installments repository scopes preview originals to the active internal owner', async () => {
  const { calls, repository } = createRepository([[originalRow]]);

  const original = await repository.findOriginal('1', '123', 'Asia/Jakarta');

  assert.equal(original?.id, '123');
  assert.match(calls[0]?.text ?? '', /FROM transactions/);
  assert.match(calls[0]?.text ?? '', /id = \$1::bigint/);
  assert.match(calls[0]?.text ?? '', /user_id = \$2::bigint/);
  assert.match(calls[0]?.text ?? '', /raw_payload -> 'parsed' ->> 'paymentType'/);
  assert.deepEqual(calls[0]?.values, ['123', '1', 'Asia/Jakarta']);
});

test('installments repository creates a locked plan and every schedule row in one transaction', async () => {
  const { calls, repository } = createRepository([
    [originalRow],
    [],
    [{ id: '9' }],
    [{ id: '7' }],
    [
      { sequence: 1, due_date: '2026-10-18', principal: '3000000', interest: '30000' },
      { sequence: 2, due_date: '2026-11-18', principal: '3000000', interest: '30000' },
    ],
  ]);

  const result = await repository.create({
    userId: '1',
    transactionId: '123',
    expectedUpdatedAt: '2026-09-18T04:00:00.000000Z',
    timezone: 'Asia/Jakarta',
    terms: { tenorMonths: 2, monthlyRatePercent: '1', firstDueDate: '2026-10-18' },
    rateUnits: 10_000n,
    buildSchedule: () => ({
      items: [
        { sequence: 1, dueDate: '2026-10-18', principal: 3_000_000, interest: 30_000, total: 3_030_000 },
        { sequence: 2, dueDate: '2026-11-18', principal: 3_000_000, interest: 30_000, total: 3_030_000 },
      ],
      totalInterest: 60_000,
      totalPayable: 6_060_000,
    }),
  });

  assert.equal(result.kind, 'created');
  assert.match(calls[0]?.text ?? '', /FOR UPDATE/);
  assert.match(calls[0]?.text ?? '', /user_id = \$2::bigint/);
  assert.match(calls[1]?.text ?? '', /FROM credit_card_installment_plans/);
  assert.match(calls[2]?.text ?? '', /FROM budgets/);
  assert.match(calls[2]?.text ?? '', /user_id = \$2::bigint/);
  assert.match(calls[3]?.text ?? '', /INSERT INTO credit_card_installment_plans/);
  assert.match(calls[4]?.text ?? '', /INSERT INTO credit_card_installments/);
  assert.match(calls[4]?.text ?? '', /unnest/);
  assert.equal(result.kind === 'created' ? result.plan.planId : null, '7');
  assert.equal(result.kind === 'created' ? result.plan.items.length : null, 2);
});

test('installments repository returns a conflict when an existing plan has different terms', async () => {
  const { repository } = createRepository([
    [originalRow],
    [{ id: '7', tenor_months: 6, monthly_rate_units: 10000, first_due_date: '2026-10-18' }],
  ]);

  const result = await repository.create({
    userId: '1',
    transactionId: '123',
    expectedUpdatedAt: '2026-09-18T04:00:00.000000Z',
    timezone: 'Asia/Jakarta',
    terms: { tenorMonths: 2, monthlyRatePercent: '1', firstDueDate: '2026-10-18' },
    rateUnits: 10_000n,
    buildSchedule: () => ({ items: [], totalInterest: 0, totalPayable: 6_000_000 }),
  });

  assert.deepEqual(result, { kind: 'conflict' });
});

test('installments repository returns a matching locked plan before building a new schedule', async () => {
  const { repository } = createRepository([
    [originalRow],
    [{ id: '7', tenor_months: 2, monthly_rate_units: 10000, first_due_date: '2026-10-18' }],
    [{
      id: '7',
      transaction_id: '123',
      principal: '6000000',
      tenor_months: 2,
      monthly_rate_units: 10000,
      first_due_date: '2026-10-18',
      timezone: 'Asia/Jakarta',
      original_updated_at: '2026-09-18T04:00:00.000000Z',
      total_interest: '60000',
      items: [],
    }],
  ]);
  let scheduleBuilt = false;

  const result = await repository.create({
    userId: '1',
    transactionId: '123',
    expectedUpdatedAt: '2026-09-18T04:00:00.000000Z',
    timezone: 'Pacific/Kiritimati',
    terms: { tenorMonths: 2, monthlyRatePercent: '1', firstDueDate: '2026-10-18' },
    rateUnits: 10_000n,
    buildSchedule: () => {
      scheduleBuilt = true;
      throw new Error('new-plan validation must not run for an idempotent retry');
    },
  });

  assert.equal(result.kind, 'existing');
  assert.equal(scheduleBuilt, false);
});

test('installments repository posts a locked batch of due schedule interest only once', async () => {
  const { calls, repository } = createRepository([
    [{
      installment_id: '8', interest: '60000', due_date: '2026-10-18', sequence: 1,
      tenor_months: 6, timezone: 'Asia/Jakarta', merchant: 'Electronics',
      category: 'Shopping', pocket_id: '9', user_id: '1',
    }],
    [{ id: '19' }],
    [{ has_more: false }],
  ]);

  const result = await repository.postDueInterest(new Date('2026-10-18T00:00:00.000Z'));

  assert.deepEqual(result, { postedCount: 1, hasMore: false });
  assert.match(calls[0]?.text ?? '', /FOR UPDATE OF installment SKIP LOCKED/);
  assert.match(calls[0]?.text ?? '', /ORDER BY installment\.due_date, installment\.id/);
  assert.match(calls[0]?.text ?? '', /LIMIT 100/);
  assert.match(calls[0]?.text ?? '', /installment\.interest > 0/);
  assert.match(calls[0]?.text ?? '', /interest_transaction_id IS NULL/);
  assert.match(calls[1]?.text ?? '', /INSERT INTO transactions/);
  assert.deepEqual(calls[1]?.values?.slice(1, 8), [
    '1', '60000', 'Electronics', 'Shopping', '9', 'Installment interest 1/6', '2026-10-18',
  ]);
  assert.match(calls[1]?.text ?? '', /UPDATE credit_card_installments/);
  assert.match(calls[2]?.text ?? '', /interest_transaction_id IS NULL/);
});
