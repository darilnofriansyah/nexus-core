import * as assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { RovelleModule } from './rovelle.module';

describe('RovelleModule', () => {
  test('is defined', () => {
    assert.ok(RovelleModule);
  });
});
