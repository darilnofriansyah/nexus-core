import { Module } from '@nestjs/common';
import { CategoriesModule } from '../categories/categories.module';
import { BudgetRepository } from './budget.repository';
import { BudgetService } from './budget.service';

@Module({
  imports: [CategoriesModule],
  providers: [BudgetRepository, BudgetService],
  exports: [BudgetService],
})
export class BudgetsModule {}
