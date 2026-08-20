import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseService } from '../../database/database.service';
import { CategoryRepository } from './category.repository';

function createRepository(rowsByCall: unknown[][] = []) {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const database = {
    query: async (text: string, values: unknown[] = []) => {
      calls.push({ text, values });
      return { rows: rowsByCall.shift() ?? [], rowCount: 0 };
    },
  } as unknown as DatabaseService;

  return { calls, repository: new CategoryRepository(database) };
}

test('copies templates without reactivating archived categories', async () => {
  const { calls, repository } = createRepository();

  await repository.ensureDefaults('1');

  assert.match(calls[0].text, /INSERT INTO categories/);
  assert.match(calls[0].text, /WHERE template\.user_id IS NULL/);
  assert.match(calls[0].text, /DO NOTHING/);
  assert.doesNotMatch(calls[0].text, /DO UPDATE/);
  assert.deepEqual(calls[0].values, ['1']);
});

test('lists only active categories owned by the user', async () => {
  const { calls, repository } = createRepository([
    [{ id: '2', name: 'Food' }],
  ]);

  const categories = await repository.listActive('1');

  assert.match(calls[0].text, /user_id = \$1/);
  assert.match(calls[0].text, /is_active = true/);
  assert.deepEqual(calls[0].values, ['1']);
  assert.deepEqual(categories, [{ id: '2', name: 'Food' }]);
});

test('looks up an active category by user and case-insensitive name', async () => {
  const { calls, repository } = createRepository([
    [{ id: 2, name: 'Food' }],
  ]);

  const category = await repository.findActiveByName('1', 'food');

  assert.match(calls[0].text, /user_id = \$1/);
  assert.match(calls[0].text, /lower\(name\) = lower\(\$2\)/);
  assert.match(calls[0].text, /is_active = true/);
  assert.deepEqual(calls[0].values, ['1', 'food']);
  assert.deepEqual(category, { id: '2', name: 'Food' });
});

test('archives only the selected active category owned by the user', async () => {
  const { calls, repository } = createRepository([[]]);

  const archived = await repository.archive('1', '2');

  assert.match(calls[0].text, /UPDATE categories/);
  assert.match(calls[0].text, /user_id = \$1/);
  assert.match(calls[0].text, /id::text = \$2/);
  assert.match(calls[0].text, /is_active = true/);
  assert.deepEqual(calls[0].values, ['1', '2']);
  assert.equal(archived, false);
});
