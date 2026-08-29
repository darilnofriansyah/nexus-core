import * as assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { BadRequestException } from '@nestjs/common';
import {
  RovelleCanonEntityType,
  type RovelleCanonEntityType as RovelleCanonEntityTypeValue,
} from '../../generated/prisma/client';
import type {
  AttachCanonAssetRequestDto,
  CreateCanonEntityRequestDto,
  CreateCanonVersionRequestDto,
  PinCanonVersionRequestDto,
} from './dto/canon.dto';
import {
  normalizeAttachCanonAssetRequest,
  normalizeCanonVersionRequest,
  normalizeCreateCanonEntityRequest,
  normalizePinCanonVersionRequest,
} from './canon-validation';

const ASSET_ID = '550e8400-e29b-41d4-a716-446655440000';
const VERSION_ID = '123e4567-e89b-42d3-a456-426614174000';

function assertBadRequest(action: () => unknown): void {
  assert.throws(action, BadRequestException);
}

describe('Rovelle canon input validation', () => {
  test('normalizes canon entity strings and preserves optional description', () => {
    const request: CreateCanonEntityRequestDto = {
      code: '  koko_01  ',
      displayName: '  Koko  ',
      entityType: RovelleCanonEntityType.CHARACTER,
      description: '  The lead character.  ',
    };

    const normalized = normalizeCreateCanonEntityRequest(request);

    assert.deepEqual(normalized, {
      code: 'KOKO_01',
      displayName: 'Koko',
      entityType: RovelleCanonEntityType.CHARACTER,
      description: 'The lead character.',
    });
    assert.notStrictEqual(normalized, request);
    assert.deepEqual(request, {
      code: '  koko_01  ',
      displayName: '  Koko  ',
      entityType: RovelleCanonEntityType.CHARACTER,
      description: '  The lead character.  ',
    });
  });

  test('accepts entity field boundaries and optional description values', () => {
    const maximumCode = `A${'B'.repeat(63)}`;
    const maximumDisplayName = 'D'.repeat(120);
    const maximumDescription = 'x'.repeat(4000);

    assert.deepEqual(
      normalizeCreateCanonEntityRequest({
        code: maximumCode,
        displayName: maximumDisplayName,
        entityType: RovelleCanonEntityType.STYLE,
        description: maximumDescription,
      }),
      {
        code: maximumCode,
        displayName: maximumDisplayName,
        entityType: RovelleCanonEntityType.STYLE,
        description: maximumDescription,
      },
    );
    assert.equal(
      normalizeCreateCanonEntityRequest({
        code: 'KOKO',
        displayName: 'Koko',
        entityType: RovelleCanonEntityType.CHARACTER,
        description: null,
      }).description,
      null,
    );
    assert.equal(
      normalizeCreateCanonEntityRequest({
        code: 'KOKO',
        displayName: 'Koko',
        entityType: RovelleCanonEntityType.CHARACTER,
      }).description,
      undefined,
    );
  });

  test('rejects malformed canon entity fields and request containers', () => {
    for (const code of [
      '',
      ' '.repeat(2),
      '_KOKO',
      'KOKO-NAME',
      'A'.repeat(65),
      1,
      null,
      undefined,
    ]) {
      assertBadRequest(() =>
        normalizeCreateCanonEntityRequest({
          code,
          displayName: 'Koko',
          entityType: RovelleCanonEntityType.CHARACTER,
        } as unknown as CreateCanonEntityRequestDto),
      );
    }

    for (const displayName of ['', ' '.repeat(2), 'D'.repeat(121), 1, null, undefined]) {
      assertBadRequest(() =>
        normalizeCreateCanonEntityRequest({
          code: 'KOKO',
          displayName,
          entityType: RovelleCanonEntityType.CHARACTER,
        } as unknown as CreateCanonEntityRequestDto),
      );
    }

    for (const description of ['x'.repeat(4001), 1, [], {}]) {
      assertBadRequest(() =>
        normalizeCreateCanonEntityRequest({
          code: 'KOKO',
          displayName: 'Koko',
          entityType: RovelleCanonEntityType.CHARACTER,
          description,
        } as unknown as CreateCanonEntityRequestDto),
      );
    }

    for (const entityType of [
      '',
      'character',
      ' CHARACTER ',
      'UNKNOWN',
      1,
      null,
      undefined,
    ]) {
      assertBadRequest(() =>
        normalizeCreateCanonEntityRequest({
          code: 'KOKO',
          displayName: 'Koko',
          entityType: entityType as RovelleCanonEntityTypeValue,
        }),
      );
    }

    for (const input of [null, [], 'request', 1, false]) {
      assertBadRequest(() => normalizeCreateCanonEntityRequest(input));
    }
  });

  test('normalizes a non-array plain definition for create and update requests', () => {
    const definition = { appearance: { color: 'yellow' }, age: 4 };
    const request: CreateCanonVersionRequestDto = { definition };
    const normalized = normalizeCanonVersionRequest(request);

    assert.deepEqual(normalized, { definition });
    assert.notStrictEqual(normalized.definition, definition);
    assert.deepEqual(definition, {
      appearance: { color: 'yellow' },
      age: 4,
    });

    const update: CreateCanonVersionRequestDto = {
      definition: { style: 'storybook' },
    };
    assert.deepEqual(normalizeCanonVersionRequest(update), update);
  });

  test('rejects empty, array, and non-plain canon definitions', () => {
    const inherited = Object.create({ inherited: true }) as Record<string, unknown>;
    inherited.__proto__ = { inherited: true };

    for (const definition of [
      null,
      [],
      'definition',
      1,
      new Date(),
      new Map([['key', 'value']]),
      {},
      inherited,
    ]) {
      assertBadRequest(() =>
        normalizeCanonVersionRequest({
          definition,
        } as unknown as CreateCanonVersionRequestDto),
      );
    }

    assertBadRequest(() => normalizeCanonVersionRequest(null));
    assertBadRequest(() => normalizeCanonVersionRequest([]));
  });

  test('normalizes asset attachments and defaults sort order to zero', () => {
    const request: AttachCanonAssetRequestDto = {
      assetId: `  ${ASSET_ID}  `,
      role: '  transparent  ',
    };

    assert.deepEqual(normalizeAttachCanonAssetRequest(request), {
      assetId: ASSET_ID,
      role: 'TRANSPARENT',
      sortOrder: 0,
    });

    for (const sortOrder of [0, 999]) {
      assert.equal(
        normalizeAttachCanonAssetRequest({
          assetId: ASSET_ID,
          role: 'PORTRAIT',
          sortOrder,
        }).sortOrder,
        sortOrder,
      );
    }
  });

  test('rejects malformed asset attachment fields', () => {
    for (const assetId of [
      '',
      ' asset-id ',
      '00000000-0000-0000-0000-000000000000',
      'not-a-uuid',
      1,
      null,
      undefined,
    ]) {
      assertBadRequest(() =>
        normalizeAttachCanonAssetRequest({
          assetId,
          role: 'PORTRAIT',
        } as unknown as AttachCanonAssetRequestDto),
      );
    }

    for (const role of ['', ' '.repeat(2), '_ROLE', 'ROLE-NAME', 'R'.repeat(65), 1, null, undefined]) {
      assertBadRequest(() =>
        normalizeAttachCanonAssetRequest({
          assetId: ASSET_ID,
          role,
        } as unknown as AttachCanonAssetRequestDto),
      );
    }

    for (const sortOrder of [-1, 1000, 1.5, NaN, Infinity, '1', null, false]) {
      assertBadRequest(() =>
        normalizeAttachCanonAssetRequest({
          assetId: ASSET_ID,
          role: 'PORTRAIT',
          sortOrder,
        } as unknown as AttachCanonAssetRequestDto),
      );
    }
  });

  test('normalizes and validates a canon version pin identifier', () => {
    const request: PinCanonVersionRequestDto = {
      canonVersionId: `  ${VERSION_ID}  `,
    };

    assert.deepEqual(normalizePinCanonVersionRequest(request), {
      canonVersionId: VERSION_ID,
    });

    for (const canonVersionId of [
      '',
      '00000000-0000-0000-0000-000000000000',
      'not-a-uuid',
      1,
      null,
      undefined,
    ]) {
      assertBadRequest(() =>
        normalizePinCanonVersionRequest({
          canonVersionId,
        } as unknown as PinCanonVersionRequestDto),
      );
    }

    assertBadRequest(() => normalizePinCanonVersionRequest(null));
    assertBadRequest(() => normalizePinCanonVersionRequest([]));
  });
});
