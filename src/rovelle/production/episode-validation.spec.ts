import * as assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { BadRequestException } from '@nestjs/common';
import type {
  CreateEpisodeRequestDto,
  ReplaceEpisodeShotsRequestDto,
  UpdateEpisodeBriefRequestDto,
} from './dto/episode.dto';
import {
  normalizeBriefRequest,
  normalizeCreateEpisodeRequest,
  normalizeShotsRequest,
} from './episode-validation';

function assertBadRequest(action: () => unknown): void {
  assert.throws(action, BadRequestException);
}

describe('Rovelle production input validation', () => {
  test('normalizes episode strings and preserves optional duration', () => {
    const request: CreateEpisodeRequestDto = {
      code: '  EP-001  ',
      title: '  Berry Count  ',
      targetDurationSeconds: 30,
    };

    const normalized = normalizeCreateEpisodeRequest(request);

    assert.deepEqual(normalized, {
      code: 'EP-001',
      title: 'Berry Count',
      targetDurationSeconds: 30,
    });
    assert.notStrictEqual(normalized, request);
    assert.deepEqual(request, {
      code: '  EP-001  ',
      title: '  Berry Count  ',
      targetDurationSeconds: 30,
    });
  });

  test('accepts episode duration boundaries and null', () => {
    for (const targetDurationSeconds of [1, 3600, null]) {
      const normalized = normalizeCreateEpisodeRequest({
        code: 'EP-001',
        title: 'Title',
        targetDurationSeconds,
      });

      assert.equal(normalized.targetDurationSeconds, targetDurationSeconds);
    }

    const withoutDuration = normalizeCreateEpisodeRequest({
      code: 'EP-001',
      title: 'Title',
    });
    assert.equal(withoutDuration.targetDurationSeconds, undefined);
  });

  test('rejects invalid episode fields and duration', () => {
    for (const value of [
      '',
      ' '.repeat(2),
      'x'.repeat(33),
      1,
      null,
      undefined,
    ]) {
      assertBadRequest(() =>
        normalizeCreateEpisodeRequest({
          code: value as string,
          title: 'Title',
        } as unknown as CreateEpisodeRequestDto),
      );
    }

    for (const value of ['', ' '.repeat(2), 'x'.repeat(201), 1, null, undefined]) {
      assertBadRequest(() =>
        normalizeCreateEpisodeRequest({
          code: 'EP-001',
          title: value as string,
        } as unknown as CreateEpisodeRequestDto),
      );
    }

    for (const value of [0, -1, 3601, 1.5, '30', NaN, Infinity, false]) {
      assertBadRequest(() =>
        normalizeCreateEpisodeRequest({
          code: 'EP-001',
          title: 'Title',
          targetDurationSeconds: value as number,
        } as unknown as CreateEpisodeRequestDto),
      );
    }
  });

  test('copies a non-empty brief object without mutating the request', () => {
    const brief = { premise: 'Count berries', tone: 'warm' };
    const request: UpdateEpisodeBriefRequestDto = { brief };

    const normalized = normalizeBriefRequest(request);

    assert.deepEqual(normalized, { brief });
    assert.notStrictEqual(normalized, request);
    assert.notStrictEqual(normalized.brief, brief);
    assert.deepEqual(request, { brief });
  });

  test('rejects missing, empty, array, and primitive briefs', () => {
    for (const brief of [
      undefined,
      null,
      {},
      [],
      'brief',
      1,
      false,
    ]) {
      assertBadRequest(() =>
        normalizeBriefRequest({ brief } as unknown as UpdateEpisodeBriefRequestDto),
      );
    }
  });

  test('normalizes shots, enforces unique positive sequences, and copies input', () => {
    const request: ReplaceEpisodeShotsRequestDto = {
      shots: [
        {
          sequence: 2,
          name: '  Close-up  ',
          direction: '  Pan slowly  ',
          targetDurationSeconds: 300,
        },
        {
          sequence: 1,
          name: null,
          direction: '  Open on the basket  ',
          targetDurationSeconds: null,
        },
      ],
    };

    const normalized = normalizeShotsRequest(request);

    assert.deepEqual(normalized, {
      shots: [
        {
          sequence: 2,
          name: 'Close-up',
          direction: 'Pan slowly',
          targetDurationSeconds: 300,
        },
        {
          sequence: 1,
          name: null,
          direction: 'Open on the basket',
          targetDurationSeconds: null,
        },
      ],
    });
    assert.notStrictEqual(normalized, request);
    assert.notStrictEqual(normalized.shots, request.shots);
    assert.notStrictEqual(normalized.shots[0], request.shots[0]);
    assert.deepEqual(request.shots[0], {
      sequence: 2,
      name: '  Close-up  ',
      direction: '  Pan slowly  ',
      targetDurationSeconds: 300,
    });
  });

  test('accepts empty shots and optional name/duration', () => {
    assert.deepEqual(normalizeShotsRequest({ shots: [] }), { shots: [] });
    assert.deepEqual(
      normalizeShotsRequest({
        shots: [
          {
            sequence: 1,
            direction: 'Direction',
          },
        ],
      }),
      {
        shots: [
          {
            sequence: 1,
            name: undefined,
            direction: 'Direction',
            targetDurationSeconds: undefined,
          },
        ],
      },
    );
  });

  test('rejects invalid shot sequence, name, direction, and duration', () => {
    for (const sequence of [0, -1, 1.5, '1', NaN, Infinity, null, undefined]) {
      assertBadRequest(() =>
        normalizeShotsRequest({
          shots: [{ sequence, direction: 'Direction' }],
        } as unknown as ReplaceEpisodeShotsRequestDto),
      );
    }

    assertBadRequest(() =>
      normalizeShotsRequest({
        shots: [
          { sequence: 1, direction: 'First' },
          { sequence: 1, direction: 'Second' },
        ],
      }),
    );

    for (const name of [1, 'x'.repeat(121), {}, []]) {
      assertBadRequest(() =>
        normalizeShotsRequest({
          shots: [{ sequence: 1, name, direction: 'Direction' }],
        } as unknown as ReplaceEpisodeShotsRequestDto),
      );
    }

    for (const direction of ['', ' '.repeat(2), 'x'.repeat(4001), 1, null, undefined]) {
      assertBadRequest(() =>
        normalizeShotsRequest({
          shots: [{ sequence: 1, direction }],
        } as unknown as ReplaceEpisodeShotsRequestDto),
      );
    }

    for (const targetDurationSeconds of [0, -1, 301, 1.5, '30', NaN, Infinity, false]) {
      assertBadRequest(() =>
        normalizeShotsRequest({
          shots: [
            {
              sequence: 1,
              direction: 'Direction',
              targetDurationSeconds,
            },
          ],
        } as unknown as ReplaceEpisodeShotsRequestDto),
      );
    }
  });

  test('rejects malformed request containers', () => {
    assertBadRequest(() =>
      normalizeCreateEpisodeRequest(null as unknown as CreateEpisodeRequestDto),
    );
    assertBadRequest(() =>
      normalizeBriefRequest([] as unknown as UpdateEpisodeBriefRequestDto),
    );
    assertBadRequest(() =>
      normalizeShotsRequest(null as unknown as ReplaceEpisodeShotsRequestDto),
    );
    assertBadRequest(() =>
      normalizeShotsRequest({ shots: null } as unknown as ReplaceEpisodeShotsRequestDto),
    );
  });
});
