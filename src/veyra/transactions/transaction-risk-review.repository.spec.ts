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
  risk_type: 'regret_detector',
  risk_level: 'high',
  risk_score: '82.50',
  risk_reasons: ['large_purchase'],
  risk_metrics: { merchant: 'Uniqlo' },
  status: 'pending',
  user_response: null,
  note: null,
  created_at: '2026-07-06T00:00:00.000Z',
  updated_at: '2026-07-06T00:00:00.000Z',
  resolved_at: null,
};

test('createPendingReview upserts pending regret detector review', async () => {
  const { calls, repository } = createRepository([[reviewRow]]);

  const review = await repository.createPendingReview({
    userId: 1,
    transactionId: 123,
    riskLevel: 'high',
    riskScore: 82.5,
    riskReasons: ['large_purchase'],
    riskMetrics: { merchant: 'Uniqlo' },
  });

  assert.match(calls[0].text, /ON CONFLICT \(transaction_id, risk_type\)/);
  assert.match(calls[0].text, /WHERE status = 'pending'/);
  assert.deepEqual(calls[0].values, [
    '1',
    '123',
    'regret_detector',
    'high',
    82.5,
    '["large_purchase"]',
    '{"merchant":"Uniqlo"}',
  ]);
  assert.equal(review.id, '7');
  assert.equal(review.riskType, 'regret_detector');
  assert.deepEqual(review.riskReasons, ['large_purchase']);
});

test('resolve stores response, status, optional note, and resolved_at', async () => {
  const { calls, repository } = createRepository([
    [
      {
        ...reviewRow,
        status: 'resolved',
        user_response: 'note_added',
        note: 'Planned sale',
        resolved_at: '2026-07-06T01:00:00.000Z',
      },
    ],
  ]);

  const review = await repository.resolve(
    7,
    1,
    'note_added',
    'resolved',
    'Planned sale',
  );

  assert.match(calls[0].text, /resolved_at = now\(\)/);
  assert.deepEqual(calls[0].values, [
    '7',
    '1',
    'resolved',
    'note_added',
    'Planned sale',
  ]);
  assert.equal(review?.status, 'resolved');
  assert.equal(review?.note, 'Planned sale');
});
