import { Injectable } from '@nestjs/common';
import { QueryResultRow } from 'pg';
import { DatabaseService } from '../../database/database.service';

export const REGRET_DETECTOR_RISK_TYPE = 'regret_detector';

export type TransactionRiskLevel = 'low' | 'medium' | 'high' | 'critical';
export type TransactionRiskReviewStatus =
  | 'pending'
  | 'resolved'
  | 'ignored'
  | 'cancelled';
export type TransactionRiskUserResponse =
  | 'planned'
  | 'impulse'
  | 'wrong_category'
  | 'note_added'
  | 'ignored';

export interface TransactionRiskReview {
  id: string;
  userId: string;
  transactionId: string;
  riskType: string;
  riskLevel: TransactionRiskLevel;
  riskScore: number | null;
  riskReasons: unknown[];
  riskMetrics: Record<string, unknown>;
  status: TransactionRiskReviewStatus;
  userResponse: TransactionRiskUserResponse | null;
  note: string | null;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
}

export interface CreatePendingRiskReviewInput {
  userId: string | number;
  transactionId: string | number;
  riskLevel: TransactionRiskLevel;
  riskScore?: number | null;
  riskReasons: unknown[];
  riskMetrics?: Record<string, unknown>;
}

interface TransactionRiskReviewRow extends QueryResultRow {
  id: string | number;
  user_id: string | number;
  transaction_id: string | number;
  risk_type: string;
  risk_level: TransactionRiskLevel;
  risk_score: string | number | null;
  risk_reasons: unknown;
  risk_metrics: unknown;
  status: TransactionRiskReviewStatus;
  user_response: TransactionRiskUserResponse | null;
  note: string | null;
  created_at: string | Date;
  updated_at: string | Date;
  resolved_at: string | Date | null;
}

@Injectable()
export class TransactionRiskReviewRepository {
  constructor(private readonly database: DatabaseService) {}

  async createPendingReview(
    input: CreatePendingRiskReviewInput,
  ): Promise<TransactionRiskReview> {
    const result = await this.database.query<TransactionRiskReviewRow>(
      `
        INSERT INTO transaction_risk_reviews (
          user_id,
          transaction_id,
          risk_type,
          risk_level,
          risk_score,
          risk_reasons,
          risk_metrics,
          status
        )
        VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, 'pending')
        ON CONFLICT (transaction_id, risk_type)
          WHERE status = 'pending'
        DO UPDATE SET
          risk_level = EXCLUDED.risk_level,
          risk_score = EXCLUDED.risk_score,
          risk_reasons = EXCLUDED.risk_reasons,
          risk_metrics = EXCLUDED.risk_metrics,
          updated_at = now()
        RETURNING *
      `,
      [
        String(input.userId),
        String(input.transactionId),
        REGRET_DETECTOR_RISK_TYPE,
        input.riskLevel,
        input.riskScore ?? null,
        JSON.stringify(input.riskReasons),
        JSON.stringify(input.riskMetrics ?? {}),
      ],
    );

    return this.mapRow(result.rows[0]);
  }

  async findById(
    reviewId: string | number,
    userId: string | number,
  ): Promise<TransactionRiskReview | null> {
    const result = await this.database.query<TransactionRiskReviewRow>(
      `
        SELECT *
        FROM transaction_risk_reviews
        WHERE id::text = $1
          AND user_id::text = $2
        LIMIT 1
      `,
      [String(reviewId), String(userId)],
    );

    return result.rows[0] ? this.mapRow(result.rows[0]) : null;
  }

  async resolve(
    reviewId: string | number,
    userId: string | number,
    userResponse: TransactionRiskUserResponse,
    status: Extract<TransactionRiskReviewStatus, 'resolved' | 'ignored'>,
    note?: string | null,
  ): Promise<TransactionRiskReview | null> {
    const result = await this.database.query<TransactionRiskReviewRow>(
      `
        UPDATE transaction_risk_reviews
        SET status = $3,
            user_response = $4,
            note = COALESCE($5, note),
            resolved_at = now(),
            updated_at = now()
        WHERE id::text = $1
          AND user_id::text = $2
        RETURNING *
      `,
      [String(reviewId), String(userId), status, userResponse, note ?? null],
    );

    return result.rows[0] ? this.mapRow(result.rows[0]) : null;
  }

  async markWrongCategory(
    reviewId: string | number,
    userId: string | number,
  ): Promise<TransactionRiskReview | null> {
    const result = await this.database.query<TransactionRiskReviewRow>(
      `
        UPDATE transaction_risk_reviews
        SET user_response = 'wrong_category',
            updated_at = now()
        WHERE id::text = $1
          AND user_id::text = $2
        RETURNING *
      `,
      [String(reviewId), String(userId)],
    );

    return result.rows[0] ? this.mapRow(result.rows[0]) : null;
  }

  private mapRow(row: TransactionRiskReviewRow): TransactionRiskReview {
    return {
      id: String(row.id),
      userId: String(row.user_id),
      transactionId: String(row.transaction_id),
      riskType: row.risk_type,
      riskLevel: row.risk_level,
      riskScore:
        row.risk_score === null || row.risk_score === undefined
          ? null
          : Number(row.risk_score),
      riskReasons: Array.isArray(row.risk_reasons) ? row.risk_reasons : [],
      riskMetrics:
        row.risk_metrics &&
        typeof row.risk_metrics === 'object' &&
        !Array.isArray(row.risk_metrics)
          ? (row.risk_metrics as Record<string, unknown>)
          : {},
      status: row.status,
      userResponse: row.user_response,
      note: row.note,
      createdAt: this.dateString(row.created_at),
      updatedAt: this.dateString(row.updated_at),
      resolvedAt: row.resolved_at ? this.dateString(row.resolved_at) : null,
    };
  }

  private dateString(value: string | Date): string {
    return value instanceof Date ? value.toISOString() : value;
  }
}
