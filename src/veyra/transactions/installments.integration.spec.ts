import * as assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { ConflictException } from '@nestjs/common';
import { Pool, PoolClient, QueryResultRow } from 'pg';
import { DatabaseService } from '../../database/database.service';
import { InstallmentsRepository } from './installments.repository';
import { InstallmentsService } from './installments.service';

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

async function withFixture(
  run: (fixture: {
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
    await run({ pool, service, transactionId: await insertOriginal(pool) });
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

function dedicatedTestUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    return new URL(value).pathname.includes('installments_test');
  } catch {
    return false;
  }
}
