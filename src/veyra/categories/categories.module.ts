import { Module } from '@nestjs/common';
import { CategoryRepository } from './category.repository';
import { CategoryService } from './category.service';

@Module({
  providers: [CategoryRepository, CategoryService],
  exports: [CategoryRepository, CategoryService],
})
export class CategoriesModule {}
