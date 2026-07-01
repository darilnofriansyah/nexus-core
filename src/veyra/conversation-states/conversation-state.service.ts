import { BadRequestException, Injectable } from '@nestjs/common';
import { QueryResultRow } from 'pg';
import { DatabaseService } from '../../database/database.service';
import {
  ConversationStateInput,
  ConversationStateName,
  ConversationStateResponseDto,
  ResetConversationStateRequestDto,
  UpsertConversationStateRequestDto,
} from './dto/conversation-state.dto';

interface ConversationStateRow extends QueryResultRow {
  user_id: string | number;
  state_name: ConversationStateName;
  state_data: unknown;
  expires_at: Date | string | null;
  updated_at: Date | string | null;
}

const STATE_ALIASES: Record<ConversationStateInput, ConversationStateName> = {
  idle: 'idle',
  record_transaction_state: 'record_transaction_state',
  budget_conversation_state: 'budget_conversation_state',
  select_transaction: 'select_transaction',
  confirm_action: 'confirm_action',
  '/record': 'record_transaction_state',
  '/budget': 'budget_conversation_state',
};

@Injectable()
export class ConversationStateService {
  constructor(private readonly database: DatabaseService) {}

  async getState(
    userIdInput: string | number,
  ): Promise<ConversationStateResponseDto> {
    const userId = this.normalizeUserId(userIdInput);
    const result = await this.database.query<ConversationStateRow>(
      `
        SELECT
          user_id,
          state_name,
          state_data,
          expires_at,
          updated_at
        FROM conversation_states
        WHERE user_id = $1
        LIMIT 1
      `,
      [userId],
    );

    const row = result.rows[0];

    if (!row) {
      return {
        userId,
        stateName: 'idle',
        stateData: {},
        expiresAt: null,
        updatedAt: null,
      };
    }

    return this.mapRow(row);
  }

  async upsertState(
    request: UpsertConversationStateRequestDto,
  ): Promise<ConversationStateResponseDto> {
    const userId = this.normalizeUserId(request.userId);
    const stateName = this.normalizeStateName(request.stateName);
    const stateData = request.stateData ?? {};

    const result = await this.database.query<ConversationStateRow>(
      `
        INSERT INTO conversation_states (
          user_id,
          state_name,
          state_data,
          expires_at,
          updated_at
        )
        VALUES ($1, $2, $3::jsonb, $4::timestamptz, NOW())
        ON CONFLICT (user_id) DO UPDATE
        SET
          state_name = EXCLUDED.state_name,
          state_data = EXCLUDED.state_data,
          expires_at = EXCLUDED.expires_at,
          updated_at = NOW()
        RETURNING
          user_id,
          state_name,
          state_data,
          expires_at,
          updated_at
      `,
      [userId, stateName, JSON.stringify(stateData), request.expiresAt ?? null],
    );

    return this.mapRequiredRow(result.rows[0]);
  }

  async resetState(
    request: ResetConversationStateRequestDto,
  ): Promise<ConversationStateResponseDto> {
    const userId = this.normalizeUserId(request.userId);

    const result = await this.database.query<ConversationStateRow>(
      `
        INSERT INTO conversation_states (
          user_id,
          state_name,
          state_data,
          expires_at,
          updated_at
        )
        VALUES ($1, 'idle', '{}'::jsonb, NULL, NOW())
        ON CONFLICT (user_id) DO UPDATE
        SET
          state_name = 'idle',
          state_data = '{}'::jsonb,
          expires_at = NULL,
          updated_at = NOW()
        RETURNING
          user_id,
          state_name,
          state_data,
          expires_at,
          updated_at
      `,
      [userId],
    );

    return this.mapRequiredRow(result.rows[0]);
  }

  normalizeStateName(stateName: ConversationStateInput): ConversationStateName {
    const normalized = STATE_ALIASES[stateName];

    if (!normalized) {
      throw new BadRequestException('unsupported conversation state');
    }

    return normalized;
  }

  private normalizeUserId(userIdInput: string | number): string {
    const userId = String(userIdInput).trim();

    if (!userId) {
      throw new BadRequestException('userId is required');
    }

    if (!/^\d+$/.test(userId)) {
      throw new BadRequestException(
        'userId must be a numeric telegram_users.id',
      );
    }

    return userId;
  }

  private mapRequiredRow(
    row: ConversationStateRow | undefined,
  ): ConversationStateResponseDto {
    if (!row) {
      throw new Error('conversation state query did not return a row');
    }

    return this.mapRow(row);
  }

  private mapRow(row: ConversationStateRow): ConversationStateResponseDto {
    return {
      userId: String(row.user_id),
      stateName: this.normalizeStateName(row.state_name),
      stateData: row.state_data ?? {},
      expiresAt: this.formatTimestamp(row.expires_at),
      updatedAt: this.formatTimestamp(row.updated_at),
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
