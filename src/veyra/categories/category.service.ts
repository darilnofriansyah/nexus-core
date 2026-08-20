import { BadRequestException, Injectable } from '@nestjs/common';
import {
  CategoryArchiveRequestDto,
  CategoryCreateRequestDto,
  CategoryDto,
} from './dto/category.dto';
import { CategoryRepository } from './category.repository';

export interface ResolvedCategory {
  category: string;
  needsReview: boolean;
}

@Injectable()
export class CategoryService {
  constructor(private readonly repository: CategoryRepository) {}

  async ensureDefaults(userId: string): Promise<void> {
    return this.repository.ensureDefaults(userId);
  }

  async listActive(userId: string): Promise<CategoryDto[]> {
    await this.ensureDefaults(userId);
    return this.repository.listActive(userId);
  }

  async resolveForSave(
    userId: string,
    suggested: string | null | undefined,
  ): Promise<ResolvedCategory> {
    await this.ensureDefaults(userId);
    const name = suggested?.trim();
    if (!name) {
      return { category: 'Uncategorized', needsReview: true };
    }

    const category = await this.repository.findActiveByName(userId, name);

    return category
      ? { category: category.name, needsReview: false }
      : { category: 'Uncategorized', needsReview: true };
  }

  async findActiveById(
    userId: string,
    categoryId: string,
  ): Promise<CategoryDto | null> {
    return this.repository.findActiveById(userId, categoryId);
  }

  async create(request: CategoryCreateRequestDto): Promise<CategoryDto> {
    const name = request.name?.trim();

    if (!name) {
      throw new BadRequestException('name is required');
    }

    const userId = String(request.userId);
    await this.ensureDefaults(userId);
    return this.repository.create(userId, name);
  }

  async archive(request: CategoryArchiveRequestDto): Promise<boolean> {
    const userId = String(request.userId);
    const category = await this.findActiveById(userId, request.categoryId);

    if (category?.name.toLowerCase() === 'uncategorized') {
      throw new BadRequestException('Uncategorized cannot be archived');
    }

    return this.repository.archive(userId, request.categoryId);
  }
}
