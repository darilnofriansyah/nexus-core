import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const migration = readFileSync(
  join(
    process.cwd(),
    'docs/migration/2026-07-12-large-transaction-risk-review-v1.sql',
  ),
  'utf8',
);

test('risk-review migration safely installs current and legacy callback values', () => {
  const responseCheck = migration.match(
    /user_response IS NULL OR user_response IN \(([\s\S]*?)\)\s*\)\s*NOT VALID/,
  );

  assert.ok(responseCheck, 'user_response check must be installed NOT VALID');
  assert.deepEqual(
    [...responseCheck[1].matchAll(/'([^']+)'/g)].map((match) => match[1]),
    [
      'planned',
      'necessary',
      'regret',
      'ignore',
      'impulse',
      'wrong_category',
      'note_added',
      'ignored',
    ],
  );
  assert.match(
    migration,
    /DROP CONSTRAINT IF EXISTS transaction_risk_reviews_user_response_check,\s*ADD CONSTRAINT transaction_risk_reviews_user_response_check/,
  );
  assert.match(
    migration,
    /VALIDATE CONSTRAINT transaction_risk_reviews_user_response_check/,
  );
  assert.match(
    migration,
    /CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_transaction_risk_reviews_risk_type\s+ON public\.transaction_risk_reviews \(risk_type\);/,
  );
  assert.match(
    migration,
    /CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_transaction_risk_reviews_fingerprint\s+ON public\.transaction_risk_reviews \(\(risk_metrics->>'evaluationFingerprint'\)\)\s+WHERE risk_type = 'large_transaction';/,
  );
  assert.doesNotMatch(migration, /\b(?:BEGIN|COMMIT)\b/i);
});
