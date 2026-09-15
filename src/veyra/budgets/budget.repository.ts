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

interface UserRow extends QueryResultRow {
  id: string | number;
}

interface PocketIdRow extends QueryResultRow {
  id: string | number;
}

interface PocketCategoryBreakdownRow {
  category: string;
  spent_amount: string | number;
}

export interface PocketStatusQuery {
  userId: string;
  pocketId?: string;
  category?: string;
  cycleStart: string;
  cycleEnd: string;
}

export interface PocketStatusRow extends QueryResultRow {
  budget_id: string | number;
  category: string;
  parent_budget_id: string | number | null;
  budget_amount: string | number;
  spent_amount: string | number | null;
  category_breakdown: PocketCategoryBreakdownRow[];
}

export interface PocketOverviewQuery {
  userId: string;
  cycleStart: string;
  cycleEnd: string;
}

export interface PocketOverviewRow extends QueryResultRow {
  budget_id: string | number;
  category: string;
  parent_budget_id: string | number | null;
  parent_category: string | null;
  amount: string | number | null;
  spent_amount: string | number | null;
  child_count: string | number;
}

@Injectable()
export class BudgetRepository {
  constructor(private readonly database: DatabaseService) {}

  async findActiveUserIdByTelegramId(
    telegramUserId: string,
  ): Promise<string | null> {
    const result = await this.database.query<UserRow>(
      `
        SELECT id
        FROM telegram_users
        WHERE telegram_id = $1::bigint AND is_active IS TRUE
        LIMIT 1
      `,
      [telegramUserId],
    );
    return result.rows[0] ? String(result.rows[0].id) : null;
  }

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

  async resolveLegacyPocketId(
    userId: string,
    category: string,
  ): Promise<string | null> {
    const result = await this.database.query<PocketIdRow>(
      `
        SELECT pocket.id
        FROM budgets pocket
        WHERE pocket.user_id = $1::bigint
          AND pocket.parent_budget_id IS NULL
          AND pocket.is_active = true
          AND (
            lower(pocket.category) = lower($2)
            OR EXISTS (
              SELECT 1
              FROM budgets child
              WHERE child.user_id = pocket.user_id
                AND child.parent_budget_id = pocket.id
                AND child.is_active = true
                AND lower(child.category) = lower($2)
            )
          )
        ORDER BY
          CASE WHEN lower(pocket.category) = lower($2) THEN 0 ELSE 1 END,
          pocket.id
        LIMIT 1
      `,
      [userId, category],
    );
    return result.rows[0] ? String(result.rows[0].id) : null;
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

  async findPocketStatus(
    query: PocketStatusQuery,
  ): Promise<PocketStatusRow | null> {
    const result = await this.database.query<PocketStatusRow>(
      `
        WITH matched_user AS (
          SELECT id, COALESCE(timezone, 'Asia/Jakarta') AS timezone
          FROM telegram_users
          WHERE id::text = $1 OR telegram_id::text = $1
          LIMIT 1
        ),
        pocket AS (
          SELECT
            b.id,
            b.category,
            b.parent_budget_id,
            COALESCE(b.amount, 0) AS budget_amount
          FROM budgets b
          JOIN matched_user u ON u.id = b.user_id
          WHERE CASE
              WHEN $2::text IS NOT NULL THEN b.id::text = $2
              ELSE lower(b.category) = lower($5)
            END
            AND b.parent_budget_id IS NULL
            AND COALESCE(b.is_active, true) = true
          LIMIT 1
        ),
        legacy_pocket_categories AS (
          SELECT category FROM pocket
          UNION
          SELECT child.category
          FROM budgets child
          JOIN pocket ON child.parent_budget_id = pocket.id
          WHERE COALESCE(child.is_active, true) = true
        ),
        matched_transactions AS (
          SELECT
            COALESCE(NULLIF(BTRIM(t.category), ''), 'Uncategorized') AS category,
            t.amount
          FROM transactions t
          JOIN matched_user u ON u.id = t.user_id
          JOIN pocket ON true
          WHERE t.status = 'confirmed'
            AND t.transaction_type = 'expense'
            AND t.transaction_date >= ($3::date::timestamp AT TIME ZONE u.timezone)
            AND t.transaction_date < ($4::date::timestamp AT TIME ZONE u.timezone)
            AND (
              t.pocket_id = pocket.id
              OR (t.pocket_id IS NULL AND lower(t.category) IN (SELECT lower(category) FROM legacy_pocket_categories))
            )
        ),
        totals AS (
          SELECT COALESCE(SUM(amount), 0) AS spent_amount
          FROM matched_transactions
        ),
        category_breakdown AS (
          SELECT COALESCE(
            json_agg(
              json_build_object(
                'category', category,
                'spent_amount', spent_amount
              )
              ORDER BY category
            ),
            '[]'::json
          ) AS category_breakdown
          FROM (
            SELECT category, SUM(amount) AS spent_amount
            FROM matched_transactions
            GROUP BY category
          ) categories
        )
        SELECT
          pocket.id AS budget_id,
          pocket.category,
          pocket.parent_budget_id,
          pocket.budget_amount,
          totals.spent_amount,
          category_breakdown.category_breakdown
        FROM pocket
        CROSS JOIN totals
        CROSS JOIN category_breakdown
      `,
      [
        query.userId,
        query.pocketId ?? null,
        query.cycleStart,
        query.cycleEnd,
        query.category ?? null,
      ],
    );

    return result.rows[0] ?? null;
  }

  async listPocketOverview(
    query: PocketOverviewQuery,
  ): Promise<PocketOverviewRow[]> {
    const result = await this.database.query<PocketOverviewRow>(
      `
        WITH matched_user AS (
          SELECT id, COALESCE(timezone, 'Asia/Jakarta') AS timezone
          FROM telegram_users
          WHERE id::text = $1 OR telegram_id::text = $1
          LIMIT 1
        ),
        active_budgets AS (
          SELECT
            b.id,
            b.category,
            b.parent_budget_id,
            COALESCE(b.amount, 0) AS amount,
            parent.category AS parent_category,
            COUNT(child.id) AS child_count
          FROM budgets b
          JOIN matched_user u ON u.id = b.user_id
          LEFT JOIN budgets parent ON parent.id = b.parent_budget_id
          LEFT JOIN budgets child
            ON child.parent_budget_id = b.id
            AND child.is_active = true
          WHERE b.is_active = true
          GROUP BY b.id, b.category, b.parent_budget_id, b.amount, parent.category
        ),
        spending AS (
          SELECT
            b.id AS budget_id,
            COALESCE(SUM(t.amount), 0) AS spent_amount
          FROM active_budgets b
          CROSS JOIN matched_user u
          LEFT JOIN transactions t ON t.user_id = u.id
            AND t.status = 'confirmed'
            AND t.transaction_type = 'expense'
            AND t.transaction_date >= ($2::date::timestamp AT TIME ZONE u.timezone)
            AND t.transaction_date < ($3::date::timestamp AT TIME ZONE u.timezone)
            AND (
              (b.parent_budget_id IS NULL AND (t.pocket_id = b.id OR (t.pocket_id IS NULL AND lower(t.category) IN (SELECT lower(legacy.category) FROM budgets legacy WHERE legacy.id = b.id OR (legacy.parent_budget_id = b.id AND legacy.is_active = true)))))
              OR (b.parent_budget_id IS NOT NULL AND ((t.pocket_id = b.parent_budget_id AND lower(t.category) = lower(b.category)) OR (t.pocket_id IS NULL AND lower(t.category) = lower(b.category))))
            )
          GROUP BY b.id
        )
        SELECT
          b.id AS budget_id,
          b.category,
          b.parent_budget_id,
          b.parent_category,
          b.amount,
          spending.spent_amount,
          b.child_count
        FROM active_budgets b
        JOIN spending ON spending.budget_id = b.id
        ORDER BY
          CASE WHEN b.parent_budget_id IS NULL THEN 0 ELSE 1 END,
          lower(COALESCE(b.parent_category, b.category)),
          lower(b.category)
      `,
      [query.userId, query.cycleStart, query.cycleEnd],
    );

    return result.rows;
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
