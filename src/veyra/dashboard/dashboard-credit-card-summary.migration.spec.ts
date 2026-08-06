import * as assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const migrationsDirectory = join(process.cwd(), 'docs/migration');

test('credit-card cycle summaries persist safe IDR amounts once per user and cycle', () => {
  const migrationName = readdirSync(migrationsDirectory).find((name) =>
    name.endsWith('-credit-card-cycle-summaries.sql'),
  );

  assert.ok(migrationName, 'credit-card cycle summary migration is required');

  const migration = readFileSync(
    join(migrationsDirectory, migrationName),
    'utf8',
  );

  assert.match(migration, /CREATE TABLE public\.credit_card_cycle_summaries/);
  assert.match(
    migration,
    /user_id bigint NOT NULL REFERENCES public\.telegram_users\(id\) ON DELETE CASCADE/,
  );
  assert.match(migration, /cycle_start date NOT NULL/);
  assert.match(
    migration,
    /UNIQUE \(user_id, cycle_start\)/,
  );
  assert.match(
    migration,
    /credit_limit bigint NOT NULL CHECK \(credit_limit >= 0 AND credit_limit <= 9007199254740991\)/,
  );
  assert.match(
    migration,
    /credit_used bigint NOT NULL CHECK \(credit_used >= 0 AND credit_used <= 9007199254740991\)/,
  );
  assert.match(
    migration,
    /statement_balance bigint NOT NULL CHECK \(statement_balance >= 0 AND statement_balance <= 9007199254740991\)/,
  );
});

test('veyra can read credit-card cycle summaries', () => {
  const migrationName = readdirSync(migrationsDirectory).find((name) =>
    name.endsWith('-credit-card-cycle-summary-access.sql'),
  );

  assert.ok(migrationName, 'Veyra access migration is required');

  const migration = readFileSync(
    join(migrationsDirectory, migrationName),
    'utf8',
  );

  assert.match(migration, /GRANT USAGE ON SCHEMA public TO veyra/);
  assert.match(
    migration,
    /GRANT SELECT ON TABLE public\.credit_card_cycle_summaries TO veyra/,
  );
});
