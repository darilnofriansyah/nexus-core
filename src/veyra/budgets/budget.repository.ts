import { Injectable } from '@nestjs/common';
import { QueryResultRow } from 'pg';
import { DatabaseService } from '../../database/database.service';
import { PocketDto } from './dto/pocket.dto';

interface PocketRow extends QueryResultRow {
  id: string | number;
  category: string;
  amount: string | number | null;
  is_default: boolean;
}

@Injectable()
export class BudgetRepository {
  constructor(private readonly database: DatabaseService) {}

  async ensureDefaultPocket(userId: string): Promise<void> {
    await this.database.withTransaction(async (client) => {
      await client.query(
        `
          INSERT INTO budgets (user_id, category, amount, parent_budget_id, period_type, is_active, is_default)
          SELECT $1::bigint, 'Main Pocket', NULL, NULL, 'monthly', true, true
          WHERE NOT EXISTS (
            SELECT 1 FROM budgets WHERE user_id = $1 AND parent_budget_id IS NULL AND is_active = true
          )
          ON CONFLICT (user_id, lower(category)) WHERE parent_budget_id IS NULL DO NOTHING
        `,
        [userId],
      );
      await client.query(
        `
          UPDATE budgets candidate
          SET is_default = true
          WHERE candidate.id = (
            SELECT min(id)
            FROM budgets
            WHERE user_id = $1 AND parent_budget_id IS NULL AND is_active = true
            HAVING count(*) = 1
          )
          AND NOT EXISTS (
            SELECT 1 FROM budgets
            WHERE user_id = $1 AND parent_budget_id IS NULL AND is_active = true AND is_default = true
          )
        `,
        [userId],
      );
    });
  }

  async findPocket(
    userId: string,
    pocketId: string,
  ): Promise<PocketDto | null> {
    const result = await this.database.query<PocketRow>(
      this.pocketSelect('id = $2'),
      [userId, pocketId],
    );
    return result.rows[0] ? this.toDto(result.rows[0]) : null;
  }

  async findDefaultPocket(userId: string): Promise<PocketDto | null> {
    const result = await this.database.query<PocketRow>(
      this.pocketSelect('is_default = true'),
      [userId],
    );
    return result.rows[0] ? this.toDto(result.rows[0]) : null;
  }

  async listPockets(userId: string): Promise<PocketDto[]> {
    const result = await this.database.query<PocketRow>(
      `
        SELECT id, category, amount, is_default
        FROM budgets
        WHERE user_id = $1::bigint
          AND parent_budget_id IS NULL AND is_active = true
        ORDER BY category
      `,
      [userId],
    );
    return result.rows.map((row) => this.toDto(row));
  }

  async renamePocket(
    userId: string,
    pocketId: string,
    name: string,
  ): Promise<PocketDto | null> {
    const result = await this.database.query<PocketRow>(
      `
        UPDATE budgets
        SET category = $3
        WHERE user_id = $1::bigint AND id::text = $2
          AND parent_budget_id IS NULL AND is_active = true
        RETURNING id, category, amount, is_default
      `,
      [userId, pocketId, name],
    );
    return result.rows[0] ? this.toDto(result.rows[0]) : null;
  }

  async setDefaultPocket(
    userId: string,
    pocketId: string,
  ): Promise<PocketDto | null> {
    return this.database.withTransaction(async (client) => {
      const pockets = await client.query<PocketRow>(
        `
          SELECT id, category, amount, is_default
          FROM budgets
          WHERE user_id = $1::bigint
            AND parent_budget_id IS NULL AND is_active = true
          FOR UPDATE
        `,
        [userId],
      );
      if (!pockets.rows.some((pocket) => String(pocket.id) === pocketId)) {
        return null;
      }
      await client.query(
        `UPDATE budgets SET is_default = false WHERE user_id = $1::bigint AND parent_budget_id IS NULL AND is_active = true AND is_default = true`,
        [userId],
      );
      const result = await client.query<PocketRow>(
        `UPDATE budgets SET is_default = true WHERE user_id = $1::bigint AND id::text = $2 AND parent_budget_id IS NULL AND is_active = true RETURNING id, category, amount, is_default`,
        [userId, pocketId],
      );
      return result.rows[0] ? this.toDto(result.rows[0]) : null;
    });
  }

  private pocketSelect(condition: string): string {
    return `
      SELECT id, category, amount, is_default
      FROM budgets
      WHERE user_id = $1::bigint AND ${condition}
        AND parent_budget_id IS NULL AND is_active = true
      LIMIT 1
    `;
  }

  private toDto(row: PocketRow): PocketDto {
    return {
      id: String(row.id),
      name: row.category,
      amount: row.amount === null ? null : Number(row.amount),
      isDefault: row.is_default,
    };
  }
}
