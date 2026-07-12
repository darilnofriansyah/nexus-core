import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseService } from '../../database/database.service';
import { TransactionRiskReviewRepository } from './transaction-risk-review.repository';

function createRepository(rowsByCall: unknown[][] = []) {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const database = {
    query: async (text: string, values: unknown[] = []) => {
      calls.push({ text, values });
      return { rows: rowsByCall.shift() ?? [] };
    },
  } as unknown as DatabaseService;

  return {
    calls,
    repository: new TransactionRiskReviewRepository(database),
  };
}

const reviewRow = {
  id: '7',
  user_id: '1',
  transaction_id: '123',
  risk_type: 'large_transaction',
  risk_level: 'high',
  risk_score: '82.50',
  risk_reasons: [{ code: 'high_budget_share', score: 40 }],
  risk_metrics: { merchant: 'Uniqlo', evaluationFingerprint: 'fp-1' },
  status: 'pending',
  user_response: null,
  note: null,
  created_at: '2026-07-06T00:00:00.000Z',
  updated_at: '2026-07-06T00:00:00.000Z',
  resolved_at: null,
};

test('saveLargeTransactionEvaluation cancels stale pending review and inserts current fingerprint', async () => {
  const { calls, repository } = createRepository([[], [], [reviewRow]]);

  const result = await repository.saveLargeTransactionEvaluation({
    userId: 1,
    transactionId: 123,
    riskLevel: 'high',
    riskScore: 82.5,
    riskReasons: [{ code: 'high_budget_share', score: 40 }],
    riskMetrics: { merchant: 'Uniqlo', evaluationFingerprint: 'fp-1' },
  });

  assert.match(calls[0].text, /risk_metrics->>'evaluationFingerprint'/);
  assert.match(calls[1].text, /status = 'cancelled'/);
  assert.deepEqual(calls[2].values, [
    '1',
    '123',
    'large_transaction',
    'high',
    82.5,
    '[{"code":"high_budget_share","score":40}]',
    '{"merchant":"Uniqlo","evaluationFingerprint":"fp-1"}',
    'pending',
  ]);
  assert.equal(result.review.id, '7');
  assert.equal(result.review.riskType, 'large_transaction');
  assert.equal(result.shouldNotify, true);
});

test('saveLargeTransactionEvaluation reuses matching fingerprint without notifying', async () => {
  const { calls, repository } = createRepository([[reviewRow]]);

  const result = await repository.saveLargeTransactionEvaluation({
    userId: 1,
    transactionId: 123,
    riskLevel: 'high',
    riskReasons: [],
    riskMetrics: { evaluationFingerprint: 'fp-1' },
  });

  assert.equal(calls.length, 1);
  assert.equal(result.review.id, '7');
  assert.equal(result.shouldNotify, false);
});

test('resolve stores response, status, optional note, and resolved_at', async () => {
  const { calls, repository } = createRepository([
    [
      {
        ...reviewRow,
        status: 'resolved',
        user_response: 'regret',
        note: 'Planned sale',
        resolved_at: '2026-07-06T01:00:00.000Z',
      },
    ],
  ]);

  const review = await repository.resolve(
    7,
    1,
    'regret',
    'resolved',
    'Planned sale',
  );

  assert.match(calls[0].text, /resolved_at = now\(\)/);
  assert.match(calls[0].text, /status = 'pending'/);
  assert.deepEqual(calls[0].values, [
    '7',
    '1',
    'resolved',
    'regret',
    'Planned sale',
    'large_transaction',
  ]);
  assert.equal(review?.status, 'resolved');
  assert.equal(review?.note, 'Planned sale');
});
