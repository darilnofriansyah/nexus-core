import { Injectable } from '@nestjs/common';
import { QueryResultRow } from 'pg';
import { DatabaseService } from '../../database/database.service';

export interface VeyraMessageRouteUser {
  id: number;
  telegramUserId: string | null;
}

export interface VeyraMessageRouteState {
  name: string | null;
  data: unknown;
  expiresAt: string | null;
}

interface TelegramUserRow extends QueryResultRow {
  id: string | number;
  telegram_id: string | number | null;
}

interface ConversationStateRow extends QueryResultRow {
  state_name: string | null;
  state_data: unknown;
  expires_at: Date | string | null;
}

@Injectable()
export class VeyraMessageRouteRepository {
  constructor(private readonly database: DatabaseService) {}

  async findUser(
    userId: string | null,
    telegramUserId: string | null,
  ): Promise<VeyraMessageRouteUser | null> {
    const result = await this.database.query<TelegramUserRow>(
      `
        SELECT id, telegram_id
        FROM telegram_users
        WHERE ($1::text IS NOT NULL AND id::text = $1::text)
          OR ($2::text IS NOT NULL AND telegram_id::text = $2::text)
        ORDER BY CASE WHEN id::text = $1::text THEN 0 ELSE 1 END
        LIMIT 1
      `,
      [userId, telegramUserId],
    );

    const row = result.rows[0];

    if (!row) {
      return null;
    }

    return {
      id: Number(row.id),
      telegramUserId:
        row.telegram_id === null || row.telegram_id === undefined
          ? null
          : String(row.telegram_id),
    };
  }

  async findActiveState(
    userId: number,
  ): Promise<VeyraMessageRouteState | null> {
    const result = await this.database.query<ConversationStateRow>(
      `
        SELECT state_name, state_data, expires_at
        FROM conversation_states
        WHERE user_id = $1
          AND state_name IS NOT NULL
          AND state_name <> 'idle'
          AND (expires_at IS NULL OR expires_at > NOW())
        LIMIT 1
      `,
      [String(userId)],
    );

    const row = result.rows[0];

    if (!row) {
      return null;
    }

    return {
      name: row.state_name,
      data: row.state_data ?? {},
      expiresAt: this.formatTimestamp(row.expires_at),
    };
  }

  private formatTimestamp(value: Date | string | null): string | null {
    if (!value) {
      return null;
    }

    if (value instanceof Date) {
      return value.toISOString();
    }

    return value;
  }
}
