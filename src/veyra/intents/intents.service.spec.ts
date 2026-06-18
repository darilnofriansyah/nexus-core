import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { IntentsService } from './intents.service';

function classify(
  message: string,
  conversationState: Record<string, unknown> = {},
) {
  return new IntentsService().classify({
    userId: 1,
    message,
    conversationState,
    timezone: 'Asia/Jakarta',
  });
}

test('classifies budget creation from category and amount', () => {
  const result = classify('Food budget 1 million');

  assert.equal(result.intent, 'set_budget');
  assert.equal(result.amount, 1000000);
  assert.equal(result.category, 'Food');
  assert.deepEqual(result.missingFields, []);
  assert.equal(result.requiresConfirmation, true);
});

test('classifies add transaction and extracts amount and merchant', () => {
  const result = classify('I spent 45k at GoPay');

  assert.equal(result.intent, 'add_transaction');
  assert.equal(result.amount, 45000);
  assert.equal(result.merchant, 'GoPay');
  assert.equal(result.requiresConfirmation, true);
});

test('classifies delete transaction by merchant target', () => {
  const result = classify('Delete my Netflix transaction');

  assert.equal(result.intent, 'delete_transaction');
  assert.equal(result.merchant, 'Netflix');
  assert.deepEqual(result.target, { type: 'merchant', value: 'Netflix' });
  assert.deepEqual(result.missingFields, []);
});

test('classifies monthly spending summary', () => {
  const result = classify('How much did I spend this month?');

  assert.equal(result.intent, 'spending_summary');
  assert.equal(result.period, 'this_month');
  assert.equal(result.requiresConfirmation, false);
});

test('classifies top merchants last month', () => {
  const result = classify('Top 5 merchants last month');

  assert.equal(result.intent, 'top_merchants');
  assert.equal(result.period, 'last_month');
  assert.equal(result.limit, 5);
});

test('returns production-shaped target, selection, and limit fields', () => {
  const result = classify('Choose 2');

  assert.equal(result.intent, 'select_transaction');
  assert.deepEqual(result.selection, { type: 'index', value: 2 });
  assert.equal(result.limit, null);
  assert.equal(result.target, null);
});

test('prioritizes conversation state before generic classification', () => {
  const result = classify('2', { expectedIntent: 'select_transaction' });

  assert.equal(result.intent, 'select_transaction');
  assert.deepEqual(result.selection, { type: 'index', value: 2 });
});

test('classifies conversation control from active state', () => {
  const result = classify('yes', { pendingIntent: 'delete_transaction' });

  assert.equal(result.intent, 'confirm_action');
  assert.equal(result.requiresConfirmation, true);
});

test('classifies additional analytics production intents', () => {
  assert.equal(classify('daily average spending this month').intent, 'daily_average_spending');
  assert.equal(classify('most frequent merchant').intent, 'most_frequent_merchant');
  assert.equal(classify('spending by day last month').intent, 'spending_by_day');
  assert.equal(classify('weekday analysis').intent, 'weekday_analysis');
  assert.equal(classify('compare merchant spending').intent, 'merchant_comparison');
  assert.equal(classify('compare category spending').intent, 'category_comparison');
});

test('returns structured unknown result for unsupported text', () => {
  const result = classify('please remember this random note');

  assert.equal(result.intent, 'unknown');
  assert.equal(result.amount, null);
  assert.deepEqual(result.missingFields, []);
  assert.deepEqual(result.warnings, []);
});

test('reports missing fields for incomplete add transaction', () => {
  const result = classify('I spent money today');

  assert.equal(result.intent, 'add_transaction');
  assert.deepEqual(result.missingFields, ['amount', 'merchant']);
});
