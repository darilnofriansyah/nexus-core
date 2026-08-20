import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { BadRequestException } from '@nestjs/common';
import { CategoryRepository } from './category.repository';
import { CategoryService } from './category.service';

class StubCategoryRepository implements Pick<
  CategoryRepository,
  | 'ensureDefaults'
  | 'listActive'
  | 'findActiveById'
  | 'findActiveByName'
  | 'create'
  | 'archive'
> {
  defaultsFor: string[] = [];
  activeById: { id: string; name: string } | null = null;
  activeByName: { id: string; name: string } | null = null;

  async ensureDefaults(userId: string) {
    this.defaultsFor.push(userId);
  }

  async listActive() {
    return [];
  }

  async findActiveById() {
    return this.activeById;
  }

  async findActiveByName() {
    return this.activeByName;
  }

  async create(userId: string, name: string) {
    return { id: '2', name: `${userId}:${name}` };
  }

  async archive() {
    return true;
  }
}

function createService() {
  const repository = new StubCategoryRepository();
  return {
    repository,
    service: new CategoryService(repository as unknown as CategoryRepository),
  };
}

test('unknown category resolves to reserved Uncategorized', async () => {
  const { repository, service } = createService();

  const result = await service.resolveForSave('1', 'Toys');

  assert.deepEqual(result, { category: 'Uncategorized', needsReview: true });
  assert.deepEqual(repository.defaultsFor, ['1']);
});

test('active category resolves with its stored name', async () => {
  const { repository, service } = createService();
  repository.activeByName = { id: '2', name: 'Food' };

  const result = await service.resolveForSave('1', 'food');

  assert.deepEqual(result, { category: 'Food', needsReview: false });
});

test('reserved Uncategorized cannot be archived', async () => {
  const { repository, service } = createService();
  repository.activeById = { id: '10', name: 'Uncategorized' };

  await assert.rejects(
    () => service.archive({ userId: '1', categoryId: '10' }),
    BadRequestException,
  );
});
