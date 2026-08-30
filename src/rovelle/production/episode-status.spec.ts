import * as assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { BadRequestException } from '@nestjs/common';
import { RovelleEpisodeStatus } from '../../generated/prisma/client';
import {
  assertEpisodeTransition,
  canTransitionEpisode,
} from './episode-status';

describe('episode status transitions', () => {
  test('allows the generation entry lifecycle', () => {
    assert.equal(
      canTransitionEpisode(
        RovelleEpisodeStatus.DRAFT,
        RovelleEpisodeStatus.BRIEF_APPROVED,
      ),
      true,
    );
    assert.equal(
      canTransitionEpisode(
        RovelleEpisodeStatus.BRIEF_APPROVED,
        RovelleEpisodeStatus.PREPRODUCTION,
      ),
      true,
    );
    assert.equal(
      canTransitionEpisode(
        RovelleEpisodeStatus.PREPRODUCTION,
        RovelleEpisodeStatus.READY_TO_GENERATE,
      ),
      true,
    );
    assert.equal(
      canTransitionEpisode(
        RovelleEpisodeStatus.READY_TO_GENERATE,
        RovelleEpisodeStatus.GENERATING,
      ),
      true,
    );
  });

  test('rejects transitions outside Phase 1', () => {
    assert.equal(
      canTransitionEpisode(
        RovelleEpisodeStatus.DRAFT,
        RovelleEpisodeStatus.READY_TO_GENERATE,
      ),
      false,
    );
    assert.equal(
      canTransitionEpisode(
        RovelleEpisodeStatus.PUBLISHED,
        RovelleEpisodeStatus.DRAFT,
      ),
      false,
    );
  });

  test('allows review-required episodes to resume or finish generation review', () => {
    assert.equal(
      canTransitionEpisode(
        RovelleEpisodeStatus.REVIEW_REQUIRED,
        RovelleEpisodeStatus.GENERATING,
      ),
      true,
    );
    assert.equal(
      canTransitionEpisode(
        RovelleEpisodeStatus.REVIEW_REQUIRED,
        RovelleEpisodeStatus.GENERATION_APPROVED,
      ),
      true,
    );
    assert.equal(
      canTransitionEpisode(
        RovelleEpisodeStatus.GENERATION_APPROVED,
        RovelleEpisodeStatus.GENERATING,
      ),
      false,
    );
    assert.equal(
      canTransitionEpisode(
        RovelleEpisodeStatus.GENERATION_APPROVED,
        RovelleEpisodeStatus.RENDERING,
      ),
      true,
    );
  });

  test('throws a bad request error for an invalid transition', () => {
    assert.throws(
      () =>
        assertEpisodeTransition(
          RovelleEpisodeStatus.DRAFT,
          RovelleEpisodeStatus.READY_TO_GENERATE,
        ),
      BadRequestException,
    );
  });
});
