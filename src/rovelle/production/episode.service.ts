import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, RovelleEpisodeStatus } from '../../generated/prisma/client';
import type {
  CreateEpisodeRequestDto,
  ReplaceEpisodeShotsRequestDto,
  UpdateEpisodeBriefRequestDto,
} from './dto/episode.dto';
import { assertEpisodeTransition } from './episode-status';
import { EpisodeRepository } from './episode.repository';
import {
  normalizeBriefRequest,
  normalizeCreateEpisodeRequest,
  normalizeShotsRequest,
} from './episode-validation';

@Injectable()
export class EpisodeService {
  constructor(private readonly repository: EpisodeRepository) {}

  async createEpisode(request: CreateEpisodeRequestDto, tx?: Prisma.TransactionClient) {
    return this.repository.createEpisode(normalizeCreateEpisodeRequest(request), tx);
  }

  async getEpisode(id: string, tx?: Prisma.TransactionClient) {
    const episode = await this.repository.findEpisode(id, tx);

    if (!episode) {
      throw new NotFoundException('Rovelle episode not found');
    }

    return episode;
  }

  async updateBrief(id: string, request: UpdateEpisodeBriefRequestDto, tx?: Prisma.TransactionClient) {
    const brief = normalizeBriefRequest(request);
    const episode = await this.getEpisode(id, tx);

    if (episode.status !== RovelleEpisodeStatus.DRAFT) {
      throw new BadRequestException('Episode brief can only be edited in DRAFT');
    }

    const updated = await this.repository.updateBrief(id, brief.brief, tx);

    if (!updated) {
      throw new BadRequestException('Episode brief can only be edited in DRAFT');
    }

    return updated;
  }

  async approveBrief(id: string, tx?: Prisma.TransactionClient) {
    const episode = await this.getEpisode(id, tx);

    assertEpisodeTransition(
      episode.status,
      RovelleEpisodeStatus.BRIEF_APPROVED,
    );

    if (
      !episode.brief ||
      typeof episode.brief !== 'object' ||
      Array.isArray(episode.brief) ||
      Object.keys(episode.brief).length === 0
    ) {
      throw new BadRequestException('Episode brief is required before approval');
    }

    const updated = await this.repository.transitionStatus(
      id,
      RovelleEpisodeStatus.DRAFT,
      RovelleEpisodeStatus.BRIEF_APPROVED,
      tx,
    );

    if (!updated) {
      throw new BadRequestException('Episode state changed before brief approval');
    }

    return updated;
  }

  async startPreproduction(id: string, tx?: Prisma.TransactionClient) {
    const episode = await this.getEpisode(id, tx);

    assertEpisodeTransition(
      episode.status,
      RovelleEpisodeStatus.PREPRODUCTION,
    );

    const updated = await this.repository.transitionStatus(
      id,
      RovelleEpisodeStatus.BRIEF_APPROVED,
      RovelleEpisodeStatus.PREPRODUCTION,
      tx,
    );

    if (!updated) {
      throw new BadRequestException('Episode state changed before preproduction');
    }

    return updated;
  }

  async replaceShots(id: string, request: ReplaceEpisodeShotsRequestDto, tx?: Prisma.TransactionClient) {
    const episode = await this.getEpisode(id, tx);

    if (episode.status !== RovelleEpisodeStatus.PREPRODUCTION) {
      throw new BadRequestException(
        'Episode shots can only be replaced in PREPRODUCTION',
      );
    }

    const shots = normalizeShotsRequest(request);
    const updated = await this.repository.replaceShots(id, shots.shots, tx);

    if (!updated) {
      throw new BadRequestException(
        'Episode shots can only be replaced in PREPRODUCTION',
      );
    }

    return updated;
  }

  async markReadyToGenerate(id: string) {
    const result = await this.repository.markReady(id);

    if (result.status === 'not_found') {
      throw new NotFoundException('Rovelle episode not found');
    }

    if (result.status === 'invalid_state') {
      throw new BadRequestException('Episode must be in PREPRODUCTION');
    }

    if (result.status === 'no_shots') {
      throw new BadRequestException('At least one shot is required');
    }

    return result.episode;
  }
}
