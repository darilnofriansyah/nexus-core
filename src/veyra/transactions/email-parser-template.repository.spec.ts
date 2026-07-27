import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseService } from '../../database/database.service';
import {
  EmailParserTemplateRepository,
} from './email-parser-template.repository';
import { EmailParserTemplateProposalDto } from './dto/email-transaction.dto';

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
    repository: new EmailParserTemplateRepository(database),
  };
}

const proposal: EmailParserTemplateProposalDto = {
  provider: 'BCA',
  templateKey: 'learned-bca-card',
  requiredAnchors: ['transaksi'],
  amount: { kind: 'idr_amount', after: 'Total: ' },
  merchant: { kind: 'text', after: 'Merchant: ' },
  transactionDate: { kind: 'datetime', after: 'Tanggal: ' },
  transactionType: 'expense',
  paymentType: 'card',
};

const templateRow = {
  id: '7',
  user_id: '1',
  sender_address: 'card@bca.co.id',
  fingerprint: 'a'.repeat(64),
  rules: proposal,
};

test('findActive returns only active templates for the user and exact sender', async () => {
  const { calls, repository } = createRepository([[templateRow]]);

  const templates = await repository.findActive('1', 'card@bca.co.id');

  assert.match(calls[0].text, /status = 'active'/);
  assert.match(calls[0].text, /lower\(sender_address\) = lower\(\$2\)/);
  assert.deepEqual(calls[0].values, ['1', 'card@bca.co.id']);
  assert.equal(templates[0].id, '7');
});

test('activate upserts a user fingerprint without executable fields', async () => {
  const { calls, repository } = createRepository([[templateRow]]);

  await repository.activate({
    userId: '1',
    senderAddress: 'card@bca.co.id',
    fingerprint: 'a'.repeat(64),
    proposal,
  });

  assert.match(calls[0].text, /ON CONFLICT \(user_id, fingerprint\)/);
  assert.deepEqual(calls[0].values, [
    '1',
    'BCA',
    'card@bca.co.id',
    'learned-bca-card',
    'a'.repeat(64),
    JSON.stringify(proposal),
  ]);
});

test('markMatched only updates matching timestamps for the user template', async () => {
  const { calls, repository } = createRepository();

  await repository.markMatched('7', '1');

  assert.match(calls[0].text, /last_matched_at = now\(\)/);
  assert.match(calls[0].text, /updated_at = now\(\)/);
  assert.match(calls[0].text, /user_id::text = \$2/);
  assert.deepEqual(calls[0].values, ['7', '1']);
});

test('disable is user-scoped', async () => {
  const { calls, repository } = createRepository();

  await repository.disable('7', '1');

  assert.match(calls[0].text, /status = 'disabled'/);
  assert.match(calls[0].text, /user_id::text = \$2/);
  assert.deepEqual(calls[0].values, ['7', '1']);
});
