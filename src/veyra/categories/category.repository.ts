import { Injectable } from '@nestjs/common';
import { QueryResultRow } from 'pg';
import { DatabaseService } from '../../database/database.service';
import { CategoryDto } from './dto/category.dto';

interface CategoryRow extends QueryResultRow {
  id: string | number;
  name: string;
}

@Injectable()
export class CategoryRepository {
  constructor(private readonly database: DatabaseService) {}

  async ensureDefaults(userId: string): Promise<void> {
    await this.database.query(
      `
        INSERT INTO categories (user_id, name, is_active)
        SELECT $1::bigint, template.name, true
        FROM categories template
        WHERE template.user_id IS NULL
          AND template.is_active = true
        ON CONFLICT (user_id, lower(name)) WHERE user_id IS NOT NULL DO NOTHING
      `,
      [userId],
    );
  }

  async listActive(userId: string): Promise<CategoryDto[]> {
    const result = await this.database.query<CategoryRow>(
      `
        SELECT id, name
        FROM categories
        WHERE user_id = $1::bigint
          AND is_active = true
        ORDER BY name
      `,
      [userId],
    );

    return result.rows.map((row) => this.toDto(row));
  }

  async findActiveById(
    userId: string,
    categoryId: string,
  ): Promise<CategoryDto | null> {
    const result = await this.database.query<CategoryRow>(
      `
        SELECT id, name
        FROM categories
        WHERE user_id = $1::bigint
          AND id::text = $2
          AND is_active = true
        LIMIT 1
      `,
      [userId, categoryId],
    );

    return result.rows[0] ? this.toDto(result.rows[0]) : null;
  }

  async findActiveByName(
    userId: string,
    name: string,
  ): Promise<CategoryDto | null> {
    const result = await this.database.query<CategoryRow>(
      `
        SELECT id, name
        FROM categories
        WHERE user_id = $1::bigint
          AND lower(name) = lower($2)
          AND is_active = true
        LIMIT 1
      `,
      [userId, name],
    );

    return result.rows[0] ? this.toDto(result.rows[0]) : null;
  }

  async create(userId: string, name: string): Promise<CategoryDto> {
    const result = await this.database.query<CategoryRow>(
      `
        INSERT INTO categories (user_id, name, is_active)
        VALUES ($1::bigint, $2, true)
        RETURNING id, name
      `,
      [userId, name],
    );

    return this.toDto(result.rows[0]);
  }

  async archive(userId: string, categoryId: string): Promise<boolean> {
    const result = await this.database.query(
      `
        UPDATE categories
        SET is_active = false
        WHERE user_id = $1::bigint
          AND id::text = $2
          AND is_active = true
      `,
      [userId, categoryId],
    );

    return (result.rowCount ?? 0) > 0;
  }

  private toDto(row: CategoryRow): CategoryDto {
    return { id: String(row.id), name: row.name };
  }
}
