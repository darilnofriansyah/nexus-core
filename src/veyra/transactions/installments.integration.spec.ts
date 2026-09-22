import * as assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { ConflictException } from '@nestjs/common';
import { Pool, PoolClient, QueryResultRow } from 'pg';
import { DatabaseService } from '../../database/database.service';
import { BudgetRepository } from '../budgets/budget.repository';
import { DashboardOverviewRepository } from '../dashboard/dashboard-overview.repository';
import { InstallmentsRepository } from './installments.repository';
import { InstallmentsService } from './installments.service';
import { WebTransactionsRepository } from './web-transactions.repository';
import { TransactionTimelineRepository } from './transaction-timeline.repository';
import { TransactionTimelineService } from './transaction-timeline.service';
import { WebTransactionsService } from './web-transactions.service';

const testUrl = process.env.INSTALLMENTS_TEST_DATABASE_URL;
const skipReason = dedicatedTestUrl(testUrl)
  ? false
  : 'INSTALLMENTS_TEST_DATABASE_URL must name a dedicated disposable installments_test database';

const request = {
  telegramUserId: '976684739',
  expectedUpdatedAt: '2026-09-18T04:00:00.000000Z',
  tenorMonths: 2,
  monthlyRatePercent: '1',
  firstDueDate: '2026-10-18',
};

const FIXTURE_TABLES = [
  'telegram_users',
  'budgets',
  'transactions',
  'credit_card_installment_plans',
  'credit_card_installments',
] as const;

type FixtureTable = (typeof FIXTURE_TABLES)[number];

interface Fixture {
  tables: Set<FixtureTable>;
}

const TELEGRAM_USERS_SQL = `
  CREATE TABLE public.telegram_users (
    id bigserial NOT NULL,
    telegram_id int8 NOT NULL,
    username text NULL,
    first_name text NULL,
    last_name text NULL,
    timezone text DEFAULT 'Asia/Jakarta'::text NULL,
    currency_code varchar(3) DEFAULT 'IDR'::character varying NULL,
    is_active bool DEFAULT true NULL,
    created_at timestamptz DEFAULT now() NULL,
    updated_at timestamptz DEFAULT now() NULL,
    cycle_start_day int4 DEFAULT 1 NULL,
    CONSTRAINT telegram_users_pkey PRIMARY KEY (id),
    CONSTRAINT telegram_users_telegram_id_key UNIQUE (telegram_id),
    CONSTRAINT telegram_users_telegram_id_unique UNIQUE (telegram_id)
  );
`;

const BUDGETS_SQL = `
  CREATE TABLE public.budgets (
    id bigserial NOT NULL,
    user_id int8 NOT NULL,
    parent_budget_id int8 NULL,
    category text NOT NULL,
    amount numeric(15, 2) NULL,
    period_type varchar(20) DEFAULT 'monthly'::character varying NOT NULL,
    is_active bool DEFAULT true NOT NULL,
    is_default boolean NOT NULL DEFAULT false,
    created_at timestamptz DEFAULT now() NULL,
    CONSTRAINT budgets_period_type_check CHECK (((period_type)::text = ANY ((ARRAY['weekly'::character varying, 'monthly'::character varying, 'yearly'::character varying])::text[]))),
    CONSTRAINT budgets_pkey PRIMARY KEY (id),
    CONSTRAINT budgets_parent_budget_id_fkey FOREIGN KEY (parent_budget_id) REFERENCES public.budgets(id) ON DELETE SET NULL,
    CONSTRAINT budgets_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.telegram_users(id) ON DELETE CASCADE
  );
  CREATE UNIQUE INDEX budgets_unique_child_category_per_parent_per_user
    ON public.budgets USING btree (user_id, parent_budget_id, lower(category))
    WHERE (parent_budget_id IS NOT NULL);
  CREATE UNIQUE INDEX budgets_unique_top_level_category_per_user
    ON public.budgets USING btree (user_id, lower(category))
    WHERE (parent_budget_id IS NULL);
  CREATE INDEX idx_budgets_user ON public.budgets USING btree (user_id);
  CREATE UNIQUE INDEX budgets_unique_default_active_top_level_per_user
    ON public.budgets USING btree (user_id)
    WHERE (is_default AND is_active AND (parent_budget_id IS NULL));
`;

const TRANSACTIONS_SQL = `
  CREATE TABLE public.transactions (
    id bigserial NOT NULL,
    user_id int8 NOT NULL,
    transaction_type varchar(20) NOT NULL,
    amount numeric(15, 2) NOT NULL,
    merchant text NULL,
    merchant_normalized text NULL,
    category text NULL,
    transaction_date timestamptz NOT NULL,
    "source" varchar(30) NOT NULL,
    notes text NULL,
    created_at timestamptz DEFAULT now() NULL,
    updated_at timestamptz DEFAULT now() NULL,
    status varchar(20) DEFAULT 'confirmed'::character varying NOT NULL,
    confidence int4 NULL,
    raw_payload jsonb NULL,
    pocket_id bigint NULL,
    CONSTRAINT transactions_pkey PRIMARY KEY (id),
    CONSTRAINT transactions_source_check CHECK (((source)::text = ANY ((ARRAY['telegram'::character varying, 'email'::character varying, 'manual'::character varying, 'import'::character varying])::text[]))),
    CONSTRAINT transactions_status_check CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'confirmed'::character varying, 'rejected'::character varying])::text[]))),
    CONSTRAINT transactions_transaction_type_check CHECK (((transaction_type)::text = ANY ((ARRAY['expense'::character varying, 'income'::character varying, 'transfer'::character varying, 'reversal'::character varying])::text[]))),
    CONSTRAINT transactions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.telegram_users(id) ON DELETE CASCADE,
    CONSTRAINT transactions_pocket_id_fkey FOREIGN KEY (pocket_id) REFERENCES public.budgets(id) ON DELETE SET NULL
  );
  CREATE INDEX idx_transactions_budget_lookup ON public.transactions USING btree (user_id, category, transaction_date);
  CREATE INDEX idx_transactions_category ON public.transactions USING btree (category);
  CREATE INDEX idx_transactions_status ON public.transactions USING btree (status);
  CREATE INDEX idx_transactions_user_date ON public.transactions USING btree (user_id, transaction_date DESC);
  CREATE INDEX idx_transactions_user_pocket_date ON public.transactions USING btree (user_id, pocket_id, transaction_date);
`;

test('installments integration: identical concurrent creates persist one plan and every row', { skip: skipReason }, async () => {
  await withFixture(async ({ pool, service, transactionId }) => {
    const results = await Promise.all([
      service.create(transactionId, request),
      service.create(transactionId, request),
    ]);

    assert.equal(results[0].planId, results[1].planId);
    assert.equal(await count(pool, 'credit_card_installment_plans'), 1);
    assert.equal(await count(pool, 'credit_card_installments'), 2);
  });
});

test('installments integration: conflicting concurrent terms leave one winning plan', { skip: skipReason }, async () => {
  await withFixture(async ({ pool, service, transactionId }) => {
    const results = await Promise.allSettled([
      service.create(transactionId, request),
      service.create(transactionId, { ...request, tenorMonths: 3 }),
    ]);

    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
    const rejected = results.find((result) => result.status === 'rejected');
    assert.ok(rejected?.status === 'rejected' && rejected.reason instanceof ConflictException);
    assert.equal(await count(pool, 'credit_card_installment_plans'), 1);
  });
});

test('installments integration: a schedule insert failure rolls back its plan', { skip: skipReason }, async () => {
  await withFixture(async ({ pool, service, transactionId }) => {
    await pool.query(
      'ALTER TABLE public.credit_card_installments ADD CONSTRAINT installments_test_force_failure CHECK (sequence <> 2)',
    );

    await assert.rejects(() => service.create(transactionId, request));
    assert.equal(await count(pool, 'credit_card_installment_plans'), 0);
    assert.equal(await count(pool, 'credit_card_installments'), 0);
  });
});

test('installments integration: concurrent material edit cannot leave a plan with an obsolete principal', { skip: skipReason }, async () => {
  await withFixture(async ({ database, pool, service, transactionId }) => {
    const repository = new WebTransactionsRepository(database);
    const blocker = await pool.connect();
    await blocker.query('SELECT pg_advisory_lock(918273)');
    await pool.query(`
      CREATE FUNCTION public.installments_test_pause_plan_insert()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM pg_advisory_xact_lock(918273);
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER installments_test_pause_plan_insert
      BEFORE INSERT ON public.credit_card_installment_plans
      FOR EACH ROW EXECUTE FUNCTION public.installments_test_pause_plan_insert();
    `);

    let create: Promise<unknown> | undefined;
    try {
      create = service.create(transactionId, request);
      await waitForPlanInsertBlock(pool);
      const edit = repository.updateTransaction({
        userId: '1',
        transactionId,
        expectedUpdatedAt: request.expectedUpdatedAt,
        changes: { amount: 6_500_000 },
      });

      await blocker.query('SELECT pg_advisory_unlock(918273)');
      const [created, edited] = await Promise.allSettled([create, edit]);

      assert.equal(created.status, 'fulfilled');
      assert.ok(edited.status === 'rejected' && edited.reason instanceof ConflictException);
    } finally {
      await blocker.query('SELECT pg_advisory_unlock(918273)');
      if (create) await Promise.allSettled([create]);
      await pool.query('DROP TRIGGER IF EXISTS installments_test_pause_plan_insert ON public.credit_card_installment_plans');
      await pool.query('DROP FUNCTION IF EXISTS public.installments_test_pause_plan_insert()');
      blocker.release();
    }

    const result = await pool.query<{ amount: string; principal: string | null }>(
      `
        SELECT transaction.amount::text AS amount, plan.principal::text AS principal
        FROM transactions AS transaction
        LEFT JOIN credit_card_installment_plans AS plan
          ON plan.transaction_id = transaction.id
        WHERE transaction.id = $1::bigint
      `,
      [transactionId],
    );
    const row = result.rows[0];

    assert.ok(row);
    assert.equal(row.principal, row.amount);
  });
});

class ClockedInstallmentsService extends InstallmentsService {
  constructor(
    repository: InstallmentsRepository,
    private readonly clock: Date,
  ) {
    super(repository);
  }

  protected currentTime(): Date {
    return this.clock;
  }
}

function dueService(database: DatabaseService, clock: string): InstallmentsService {
  return new ClockedInstallmentsService(
    new InstallmentsRepository(database),
    new Date(clock),
  );
}

test('installments integration: due posting is idempotent, skips zero and future rows, and keeps inactive obligations accruing', { skip: skipReason }, async () => {
  await withFixture(async ({ database, pool, service, transactionId }) => {
    await service.create(transactionId, {
      ...request,
      tenorMonths: 6,
      firstDueDate: '2026-10-18',
    });
    const october = dueService(database, '2026-10-18T00:00:00.000Z');
    const november = dueService(database, '2026-11-18T00:00:00.000Z');

    assert.deepEqual(await october.postDueInterest(), { postedCount: 1, hasMore: false });
    assert.deepEqual(await october.postDueInterest(), { postedCount: 0, hasMore: false });

    const zeroRateOriginal = await insertOriginal(pool);
    await service.create(zeroRateOriginal, {
      ...request,
      tenorMonths: 1,
      monthlyRatePercent: '0',
      firstDueDate: '2026-10-18',
    });
    assert.deepEqual(await october.postDueInterest(), { postedCount: 0, hasMore: false });
    assert.equal(await generatedInterestCount(pool), 1);

    await pool.query('UPDATE telegram_users SET is_active = false WHERE id = 1');
    assert.deepEqual(await november.postDueInterest(), { postedCount: 1, hasMore: false });
    assert.deepEqual(await generatedInterestAmounts(pool), ['60000', '60000']);
    assert.equal(await unpostedInterestCount(pool), 4);
  });
});

test('installments integration: a batch catches up at most 100 due rows and reports remaining work', { skip: skipReason }, async () => {
  await withFixture(async ({ database, pool, service, transactionId }) => {
    await service.create(transactionId, {
      ...request,
      tenorMonths: 120,
      firstDueDate: '2026-09-18',
    });
    const due = dueService(database, '2036-09-18T00:00:00.000Z');

    assert.deepEqual(await due.postDueInterest(), { postedCount: 100, hasMore: true });
    assert.deepEqual(await due.postDueInterest(), { postedCount: 20, hasMore: false });
    assert.equal(await generatedInterestCount(pool), 120);
  });
});

test('installments integration: concurrent due posters create each interest transaction once', { skip: skipReason }, async () => {
  await withFixture(async ({ database, pool, service, transactionId }) => {
    await service.create(transactionId, {
      ...request,
      tenorMonths: 6,
      firstDueDate: '2026-10-18',
    });
    const first = dueService(database, '2027-03-18T00:00:00.000Z');
    const second = dueService(database, '2027-03-18T00:00:00.000Z');

    const results = await Promise.all([first.postDueInterest(), second.postDueInterest()]);
    assert.equal(results[0].postedCount + results[1].postedCount, 6);
    assert.equal(await generatedInterestCount(pool), 6);
    assert.equal(await unpostedInterestCount(pool), 0);
  });
});

test('installments integration: a link failure rolls back its inserted interest transaction', { skip: skipReason }, async () => {
  await withFixture(async ({ database, pool, service, transactionId }) => {
    await service.create(transactionId, {
      ...request,
      tenorMonths: 1,
      firstDueDate: '2026-10-18',
    });
    await pool.query(`
      CREATE FUNCTION public.installments_test_reject_interest_link()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'force interest link failure';
      END;
      $$;
      CREATE TRIGGER installments_test_reject_interest_link
      BEFORE UPDATE OF interest_transaction_id ON public.credit_card_installments
      FOR EACH ROW EXECUTE FUNCTION public.installments_test_reject_interest_link();
    `);

    try {
      await assert.rejects(() => dueService(database, '2026-10-18T00:00:00.000Z').postDueInterest());
    } finally {
      await pool.query('DROP TRIGGER IF EXISTS installments_test_reject_interest_link ON public.credit_card_installments');
      await pool.query('DROP FUNCTION IF EXISTS public.installments_test_reject_interest_link()');
    }
    assert.equal(await generatedInterestCount(pool), 0);
    assert.equal(await unpostedInterestCount(pool), 1);
  });
});

test('installments integration: stored timezone midnight posts on the schedule date and accounting counts only purchase plus interest', { skip: skipReason }, async () => {
  await withFixture(async ({ database, pool, service, transactionId }) => {
    await pool.query("UPDATE telegram_users SET timezone = 'Pacific/Kiritimati' WHERE id = 1");
    await service.create(transactionId, {
      ...request,
      tenorMonths: 1,
      firstDueDate: '2026-10-18',
    });

    assert.deepEqual(
      await dueService(database, '2026-10-17T10:00:00.000Z').postDueInterest(),
      { postedCount: 1, hasMore: false },
    );
    const budget = await new BudgetRepository(database).findPocketStatus({
      userId: '1', pocketId: '9', cycleStart: '2026-09-01', cycleEnd: '2026-11-01',
    });
    const transactions = await new DashboardOverviewRepository(database).findTransactions(
      '1', '2026-09-01', '2026-11-01', 'Pacific/Kiritimati',
    );

    assert.equal(budget?.spent_amount, '6060000');
    assert.equal(transactions.reduce((total, transaction) => total + transaction.amount, 0), 6_060_000);
    assert.deepEqual(await generatedInterestAmounts(pool), ['60000']);
    const date = await pool.query<{ date: string }>(
      "SELECT to_char(transaction_date AT TIME ZONE 'Pacific/Kiritimati', 'YYYY-MM-DD') AS date FROM transactions WHERE source = 'manual'",
    );
    assert.equal(date.rows[0]?.date, '2026-10-18');
  });
});

test('timeline integration: 58 mixed entries traverse tied timestamps forward and backward without gaps', { skip: skipReason }, async () => {
  await withFixture(async ({ database, pool, service, transactionId }) => {
    await pool.query(`
      INSERT INTO transactions (user_id, transaction_type, amount, merchant, category, transaction_date, source)
      SELECT 1, 'expense', 100, 'Coffee', 'Dining',
        '2026-10-17T17:00:00.000000Z'::timestamptz + CASE WHEN n <= 2 THEN n ELSE 0 END * interval '1 microsecond', 'manual'
      FROM generate_series(1, 55) n
    `);
    for (const originalId of [transactionId, await insertOriginal(pool), await insertOriginal(pool)]) {
      await service.create(originalId, { ...request, tenorMonths: 1 });
    }
    const timeline = timelineService(database);
    const first = await timeline.query({ telegramUserId: request.telegramUserId, month: '2026-10', limit: 50 });
    assert.equal(first.items.length, 50);
    assert.equal(first.previousCursor, null);
    assert.deepEqual(first.items.slice(0, 6).map(item => item.entryId), [
      'transaction:3', 'transaction:2', 'installment:3', 'installment:2', 'installment:1', 'transaction:56',
    ]);
    const last = await timeline.query({ telegramUserId: request.telegramUserId, month: '2026-10', cursor: first.nextCursor });
    assert.deepEqual(last.items.map(item => item.entryId), ['transaction:11', 'transaction:10', 'transaction:9', 'transaction:8', 'transaction:7', 'transaction:6', 'transaction:5', 'transaction:4']);
    assert.equal(last.nextCursor, null);
    assert.equal(new Set([...first.items, ...last.items].map(item => item.entryId)).size, 58);
    const back = await timeline.query({ telegramUserId: request.telegramUserId, month: '2026-10', cursor: last.previousCursor, direction: 'previous' });
    assert.deepEqual(back, first);
    const categories = await timeline.query({ telegramUserId: request.telegramUserId, month: '2026-10', category: 'Dining', limit: 1 });
    assert.deepEqual(categories.categories, ['Dining', 'Shopping']);
  });
});

test('timeline integration: filters scope both kinds, preserve stored calendar dates and exclude foreign plans', { skip: skipReason }, async () => {
  await withFixture(async ({ database, pool, service, transactionId }) => {
    await pool.query("UPDATE telegram_users SET timezone = 'Pacific/Kiritimati', cycle_start_day = 31 WHERE id = 1");
    await service.create(transactionId, { ...request, tenorMonths: 1, firstDueDate: '2090-10-01' });
    await pool.query(`
      UPDATE credit_card_installment_plans SET category = E'\\tShopping\\n';
      INSERT INTO transactions (user_id, transaction_type, amount, merchant, merchant_normalized, category, transaction_date, source)
      VALUES (1, 'expense', 100, 'Electronics', 'Electronics', E'\\tShopping\\n', '2090-10-01T10:00:00Z', 'manual'),
             (1, 'income', 200, 'Employer', NULL, 'Salary', '2090-10-05T10:00:00Z', 'manual'),
             (1, 'transfer', 300, 'Electronics', NULL, 'Hidden', '2090-10-05T10:00:00Z', 'manual');
      INSERT INTO telegram_users (id, telegram_id) VALUES (2, 123456);
      INSERT INTO transactions (user_id, transaction_type, amount, merchant, category, transaction_date, source, raw_payload)
      VALUES (2, 'expense', 500, 'Foreign', 'Foreign', '2090-10-01T10:00:00Z', 'email', '{"parsed":{"paymentType":"credit card"}}');
      INSERT INTO credit_card_installment_plans (transaction_id, principal, tenor_months, monthly_rate_units, first_due_date, timezone, merchant, category, original_updated_at)
      SELECT id, 500, 1, 0, '2090-10-01', 'Asia/Jakarta', 'Foreign', 'Foreign', updated_at FROM transactions WHERE user_id = 2;
      INSERT INTO credit_card_installments (plan_id, sequence, due_date, principal, interest)
      SELECT id, 1, '2090-10-01', 500, 0 FROM credit_card_installment_plans WHERE merchant = 'Foreign';
    `);
    const timeline = timelineService(database);
    const october = { telegramUserId: request.telegramUserId, month: '2090-10', timezone: 'America/Los_Angeles' };
    const page = await timeline.query(october);
    assert.equal(page.items.length, 3);
    assert.deepEqual(page.categories, ['Salary', 'Shopping']);
    const income = await timeline.query({ ...october, type: 'income' });
    assert.equal(income.items.length, 1);
    assert.equal(income.items[0].kind, 'transaction');
    assert.equal(income.items[0].budgetAmount, 0);
    assert.deepEqual(income.categories, ['Salary']);
    const shopping = await timeline.query({ ...october, category: ' Shopping ', merchantQuery: 'electronics' });
    assert.equal(shopping.items.length, 2);
    assert.ok(shopping.items.some(item => item.kind === 'installment' && item.dueDate === '2090-10-01' && item.state === 'scheduled'));
    const september = await timeline.query({ ...october, month: '2090-09' });
    assert.equal(september.items.length, 0);
    const cycle = await timeline.query({ telegramUserId: request.telegramUserId, cycle: 'current', asOfDate: '2090-10-01', timezone: october.timezone });
    assert.equal(cycle.items.length, 3);
    const unbounded = await timeline.query({ telegramUserId: request.telegramUserId, asOfDate: '2090-10-01' });
    assert.equal(unbounded.items.some(item => item.kind === 'installment'), false);
  });
});

test('timeline integration: folds posted interest only here, keeps original purchase and zero-rate due state', { skip: skipReason }, async () => {
  await withFixture(async ({ database, pool, service, transactionId }) => {
    await pool.query("UPDATE transactions SET transaction_date = '1999-12-01T00:00:00Z' WHERE id = $1", [transactionId]);
    await service.create(transactionId, { ...request, tenorMonths: 1, firstDueDate: '2000-01-01' });
    const zeroOriginal = await insertOriginal(pool);
    await pool.query("UPDATE transactions SET transaction_date = '1999-12-01T00:00:00Z' WHERE id = $1", [zeroOriginal]);
    await service.create(zeroOriginal, { ...request, tenorMonths: 1, monthlyRatePercent: '0', firstDueDate: '2000-01-01' });
    const timeline = timelineService(database);
    const january = { telegramUserId: request.telegramUserId, month: '2000-01', asOfDate: '1900-01-01' };
    const pending = await timeline.query(january);
    assert.deepEqual(pending.items.map(item => item.kind === 'installment' && [item.state, item.budgetAmount, item.scheduledBudgetAmount, item.interestPostingPending]), [
      ['due', 0, 0, false], ['due', 0, 60000, true],
    ]);
    await dueService(database, '2000-01-01T00:00:00Z').postDueInterest();
    const posted = await timeline.query(january);
    assert.equal(posted.items.length, 2);
    assert.equal(posted.items.reduce((sum, item) => sum + item.budgetAmount, 0), 60000);
    const legacy = await new WebTransactionsService(new WebTransactionsRepository(database)).queryTransactions({
      telegramUserId: request.telegramUserId, cycle: 'current', asOfDate: '2000-01-15',
    });
    assert.equal(legacy.items.length, 1);
    assert.equal(legacy.items[0].amount, 60000);
    const original = await timeline.query({ telegramUserId: request.telegramUserId, month: '1999-12' });
    assert.equal(original.items.length, 2);
    assert.ok(original.items.every(item => item.kind === 'transaction' && item.hasInstallmentPlan && item.budgetAmount === 6000000));
  });
});

function timelineService(database: DatabaseService): TransactionTimelineService {
  return new TransactionTimelineService(new TransactionTimelineRepository(database), new WebTransactionsRepository(database));
}

async function waitForPlanInsertBlock(pool: Pool): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await pool.query<{ waiting: boolean }>(
      `
        SELECT EXISTS (
          SELECT 1
          FROM pg_locks
          WHERE locktype = 'advisory'
            AND classid = 0
            AND objid = 918273
            AND objsubid = 1
            AND granted = false
        ) AS waiting
      `,
    );
    if (result.rows[0]?.waiting) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('plan creation did not reach the advisory lock');
}

async function withFixture(
  run: (fixture: {
    database: DatabaseService;
    pool: Pool;
    service: InstallmentsService;
    transactionId: string;
  }) => Promise<void>,
): Promise<void> {
  if (!testUrl) throw new Error('Missing disposable test database URL');
  const pool = new Pool({ connectionString: testUrl });
  let fixture: Fixture | undefined;
  try {
    fixture = await createFixture(pool);
    const database = databaseFor(pool);
    const service = new InstallmentsService(new InstallmentsRepository(database));
    await run({ database, pool, service, transactionId: await insertOriginal(pool) });
  } finally {
    if (fixture) await cleanupFixture(pool, fixture);
    await pool.end();
  }
}

function databaseFor(pool: Pool): DatabaseService {
  return {
    query: <T extends QueryResultRow>(text: string, values: unknown[] = []) =>
      pool.query<T>(text, values),
    withTransaction: async <T>(callback: (client: Pick<PoolClient, 'query'>) => Promise<T>) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await callback(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
  } as unknown as DatabaseService;
}

async function createFixture(pool: Pool): Promise<Fixture> {
  await assertFixtureAbsent(pool);
  const fixture: Fixture = { tables: new Set() };
  try {
    await pool.query(TELEGRAM_USERS_SQL);
    fixture.tables.add('telegram_users');
    await pool.query(BUDGETS_SQL);
    fixture.tables.add('budgets');
    await pool.query(TRANSACTIONS_SQL);
    fixture.tables.add('transactions');
    const migration = await readFile(
      join(process.cwd(), 'docs/migration/2026-09-18-credit-card-installments.sql'),
      'utf8',
    );
    await pool.query(migration);
    fixture.tables.add('credit_card_installment_plans');
    fixture.tables.add('credit_card_installments');
    await pool.query(
      "INSERT INTO public.telegram_users (id, telegram_id, timezone, is_active) VALUES (1, 976684739, 'Asia/Jakarta', true)",
    );
    await pool.query(
      "INSERT INTO public.budgets (id, user_id, category) VALUES (9, 1, 'Shopping')",
    );
    return fixture;
  } catch (error) {
    await addCreatedMigrationTables(pool, fixture);
    await cleanupFixture(pool, fixture);
    throw error;
  }
}

async function insertOriginal(pool: Pool): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `
      INSERT INTO public.transactions (
        user_id, transaction_type, amount, merchant, category, transaction_date,
        source, status, raw_payload, pocket_id, updated_at
      )
      VALUES (
        1, 'expense', 6000000, 'Electronics', 'Shopping',
        '2026-09-18T00:00:00.000Z', 'email', 'confirmed',
        '{"parsed":{"paymentType":"credit card"}}'::jsonb, 9,
        '2026-09-18T04:00:00.000000Z'
      )
      RETURNING id::text AS id
    `,
  );
  return result.rows[0]?.id ?? '';
}

async function assertFixtureAbsent(pool: Pool): Promise<void> {
  const result = await pool.query<{ table_name: FixtureTable }>(
    `
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = ANY($1::text[])
    `,
    [FIXTURE_TABLES],
  );
  if (result.rows.length > 0) {
    throw new Error('Disposable installment test database has fixture prerequisites already present');
  }
}

async function addCreatedMigrationTables(pool: Pool, fixture: Fixture): Promise<void> {
  const result = await pool.query<{ table_name: FixtureTable }>(
    `
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = ANY($1::text[])
    `,
    [['credit_card_installment_plans', 'credit_card_installments']],
  );
  for (const row of result.rows) fixture.tables.add(row.table_name);
}

async function cleanupFixture(pool: Pool, fixture: Fixture): Promise<void> {
  for (const table of [
    'credit_card_installments',
    'credit_card_installment_plans',
    'transactions',
    'budgets',
    'telegram_users',
  ] as const) {
    if (fixture.tables.has(table)) await pool.query(`DROP TABLE public.${table}`);
  }
}

async function count(pool: Pool, table: string): Promise<number> {
  const result = await pool.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM public.${table}`);
  return Number(result.rows[0]?.count);
}

async function generatedInterestCount(pool: Pool): Promise<number> {
  const result = await pool.query<{ count: string }>(
    "SELECT COUNT(*)::text AS count FROM transactions WHERE source = 'manual' AND notes LIKE 'Installment interest %'",
  );
  return Number(result.rows[0]?.count);
}

async function generatedInterestAmounts(pool: Pool): Promise<string[]> {
  const result = await pool.query<{ amount: string }>(
    "SELECT amount::text AS amount FROM transactions WHERE source = 'manual' AND notes LIKE 'Installment interest %' ORDER BY transaction_date, id",
  );
  return result.rows.map((row) => row.amount);
}

async function unpostedInterestCount(pool: Pool): Promise<number> {
  const result = await pool.query<{ count: string }>(
    'SELECT COUNT(*)::text AS count FROM credit_card_installments WHERE interest > 0 AND interest_transaction_id IS NULL',
  );
  return Number(result.rows[0]?.count);
}

function dedicatedTestUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    return new URL(value).pathname.includes('installments_test');
  } catch {
    return false;
  }
}
