import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import {
  Prisma,
  RovelleEpisodeStatus,
  RovelleShotStatus,
} from '../../generated/prisma/client';
import {
  EpisodeRepository,
  EpisodeWithShots,
  MarkReadyResult,
} from './episode.repository';
import { EpisodeService } from './episode.service';

const draftEpisode: EpisodeWithShots = {
  id: 'episode-1',
  code: 'EP-001',
  title: 'Berry Count',
  status: RovelleEpisodeStatus.DRAFT,
  brief: { premise: 'Count berries' },
  targetDurationSeconds: 30,
  generationBudgetUsd: null,
  approvedRenderId: null,
  createdAt: new Date('2026-08-27T00:00:00.000Z'),
  updatedAt: new Date('2026-08-27T00:00:00.000Z'),
  shots: [],
};

class StubEpisodeRepository implements Pick<
  EpisodeRepository,
  | 'createEpisode'
  | 'findEpisode'
  | 'updateBrief'
  | 'transitionStatus'
  | 'replaceShots'
  | 'markReady'
> {
  episode: EpisodeWithShots | null = draftEpisode;
  markReadyResult: MarkReadyResult = { status: 'ready', episode: draftEpisode };
  createRequest?: unknown;
  updateBriefRequest?: unknown;
  transitionRequest?: unknown;
  replaceShotsRequest?: unknown;
  transactions: Array<Prisma.TransactionClient | undefined> = [];

  async createEpisode(request: unknown, tx?: Prisma.TransactionClient) {
    this.createRequest = request;
    this.transactions.push(tx);
    return draftEpisode;
  }

  async findEpisode(_id?: string, tx?: Prisma.TransactionClient) {
    this.transactions.push(tx);
    return this.episode;
  }

  async updateBrief(_id: string, brief: Record<string, unknown>, tx?: Prisma.TransactionClient) {
    this.updateBriefRequest = brief;
    this.transactions.push(tx);
    return this.episode;
  }

  async transitionStatus(
    id: string,
    from: RovelleEpisodeStatus,
    to: RovelleEpisodeStatus,
    tx?: Prisma.TransactionClient,
  ) {
    this.transitionRequest = { id, from, to };
    this.transactions.push(tx);
    if (this.episode) this.episode = { ...this.episode, status: to };
    return this.episode;
  }

  async replaceShots(id: string, shots: unknown[], tx?: Prisma.TransactionClient) {
    this.replaceShotsRequest = { id, shots };
    this.transactions.push(tx);
    return this.episode;
  }

  async markReady() {
    return this.markReadyResult;
  }
}

function createService() {
  const repository = new StubEpisodeRepository();
  return {
    repository,
    service: new EpisodeService(repository as unknown as EpisodeRepository),
  };
}

test('creates an episode with normalized input', async () => {
  const { repository, service } = createService();

  await service.createEpisode({
    code: ' EP-001 ',
    title: ' Berry Count ',
    targetDurationSeconds: 30,
  });

  assert.deepEqual(repository.createRequest, {
    code: 'EP-001',
    title: 'Berry Count',
    targetDurationSeconds: 30,
  });
});

test('passes one supplied transaction through the episode approval methods', async () => {
  const { repository, service } = createService();
  const tx = {} as Prisma.TransactionClient;

  await service.createEpisode({ code: 'EP-001', title: 'Berry Count' }, tx);
  await service.getEpisode('episode-1', tx);
  await service.updateBrief('episode-1', { brief: { premise: 'Count berries' } }, tx);
  await service.approveBrief('episode-1', tx);
  await service.startPreproduction('episode-1', tx);
  await service.replaceShots('episode-1', {
    shots: [{ sequence: 1, direction: 'Open on the basket.', targetDurationSeconds: 4 }],
  }, tx);

  assert.equal(repository.transactions.length, 10);
  assert.ok(repository.transactions.every((transaction) => transaction === tx));
});

test('throws when reading a missing episode', async () => {
  const { repository, service } = createService();
  repository.episode = null;

  await assert.rejects(() => service.getEpisode('missing'), NotFoundException);
});

test('allows brief edits only in draft and maps a lost race to bad request', async () => {
  const { repository, service } = createService();
  repository.episode = { ...draftEpisode, status: RovelleEpisodeStatus.BRIEF_APPROVED };

  await assert.rejects(
    () => service.updateBrief('episode-1', { brief: { premise: 'New' } }),
    BadRequestException,
  );

  repository.episode = draftEpisode;
  const originalUpdateBrief = repository.updateBrief.bind(repository);
  repository.updateBrief = async () => null;
  await assert.rejects(
    () => service.updateBrief('episode-1', { brief: { premise: 'New' } }),
    BadRequestException,
  );
  repository.updateBrief = originalUpdateBrief;
});

test('approves only a draft episode with a non-empty brief', async () => {
  const { repository, service } = createService();
  repository.episode = { ...draftEpisode, brief: null };

  await assert.rejects(() => service.approveBrief('episode-1'), BadRequestException);

  repository.episode = draftEpisode;
  await service.approveBrief('episode-1');
  assert.deepEqual(repository.transitionRequest, {
    id: 'episode-1',
    from: RovelleEpisodeStatus.DRAFT,
    to: RovelleEpisodeStatus.BRIEF_APPROVED,
  });
});

test('starts preproduction from an approved brief', async () => {
  const { repository, service } = createService();
  repository.episode = {
    ...draftEpisode,
    status: RovelleEpisodeStatus.BRIEF_APPROVED,
  };

  await service.startPreproduction('episode-1');

  assert.deepEqual(repository.transitionRequest, {
    id: 'episode-1',
    from: RovelleEpisodeStatus.BRIEF_APPROVED,
    to: RovelleEpisodeStatus.PREPRODUCTION,
  });
});

test('replaces normalized shots only in preproduction', async () => {
  const { repository, service } = createService();
  repository.episode = draftEpisode;

  await assert.rejects(
    () =>
      service.replaceShots('episode-1', {
        shots: [{ sequence: 1, direction: 'Opening' }],
      }),
    BadRequestException,
  );

  repository.episode = {
    ...draftEpisode,
    status: RovelleEpisodeStatus.PREPRODUCTION,
  };
  await service.replaceShots('episode-1', {
    shots: [{ sequence: 1, direction: ' Opening ' }],
  });
  assert.deepEqual(repository.replaceShotsRequest, {
    id: 'episode-1',
    shots: [
      {
        sequence: 1,
        name: undefined,
        direction: 'Opening',
        targetDurationSeconds: undefined,
      },
    ],
  });
});

test('maps mark-ready repository results to domain errors or the ready aggregate', async () => {
  const { repository, service } = createService();

  repository.markReadyResult = { status: 'not_found' };
  await assert.rejects(
    () => service.markReadyToGenerate('episode-1'),
    NotFoundException,
  );

  repository.markReadyResult = { status: 'invalid_state' };
  await assert.rejects(
    () => service.markReadyToGenerate('episode-1'),
    BadRequestException,
  );

  repository.markReadyResult = { status: 'no_shots' };
  await assert.rejects(
    () => service.markReadyToGenerate('episode-1'),
    /At least one shot is required/,
  );

  const ready = {
    ...draftEpisode,
    status: RovelleEpisodeStatus.READY_TO_GENERATE,
    shots: [
      {
        id: 'shot-1',
        episodeId: 'episode-1',
        sequence: 1,
        name: null,
        direction: 'Opening',
        targetDurationSeconds: null,
        status: RovelleShotStatus.READY_TO_GENERATE,
        approvedGenerationId: null,
        createdAt: draftEpisode.createdAt,
        updatedAt: draftEpisode.updatedAt,
      },
    ],
  };
  repository.markReadyResult = { status: 'ready', episode: ready };
  assert.equal(await service.markReadyToGenerate('episode-1'), ready);
});
