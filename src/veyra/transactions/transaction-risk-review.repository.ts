import { Injectable } from '@nestjs/common';
import { QueryResultRow } from 'pg';
import { DatabaseService } from '../../database/database.service';

export const LARGE_TRANSACTION_RISK_TYPE = 'large_transaction';

export type TransactionRiskLevel = 'low' | 'medium' | 'high' | 'critical';
export type TransactionRiskReviewStatus =
  | 'pending'
  | 'resolved'
  | 'cancelled';
export type TransactionRiskUserResponse =
  | 'planned'
  | 'necessary'
  | 'regret'
  | 'ignore';

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
  status?: Extract<TransactionRiskReviewStatus, 'pending' | 'resolved'>;
}

export interface SaveRiskEvaluationResult {
  review: TransactionRiskReview;
  shouldNotify: boolean;
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

  async saveLargeTransactionEvaluation(
    input: CreatePendingRiskReviewInput,
  ): Promise<SaveRiskEvaluationResult> {
    const fingerprint = this.fingerprintFromMetrics(input.riskMetrics);
    const existing = fingerprint
      ? await this.findByFingerprint(input.transactionId, fingerprint)
      : null;

    if (existing) {
      return { review: existing, shouldNotify: false };
    }

    await this.cancelPendingLargeTransactionReview(input.transactionId);

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
        VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8)
        RETURNING *
      `,
      [
        String(input.userId),
        String(input.transactionId),
        LARGE_TRANSACTION_RISK_TYPE,
        input.riskLevel,
        input.riskScore ?? null,
        JSON.stringify(input.riskReasons),
        JSON.stringify(input.riskMetrics ?? {}),
        input.status ?? 'pending',
      ],
    );

    const review = this.mapRow(result.rows[0]);

    return {
      review,
      shouldNotify: review.status === 'pending',
    };
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
          AND risk_type = $3
        LIMIT 1
      `,
      [String(reviewId), String(userId), LARGE_TRANSACTION_RISK_TYPE],
    );

    return result.rows[0] ? this.mapRow(result.rows[0]) : null;
  }

  async resolve(
    reviewId: string | number,
    userId: string | number,
    userResponse: TransactionRiskUserResponse,
    status: Extract<TransactionRiskReviewStatus, 'resolved'>,
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
          AND risk_type = $6
          AND status = 'pending'
        RETURNING *
      `,
      [
        String(reviewId),
        String(userId),
        status,
        userResponse,
        note ?? null,
        LARGE_TRANSACTION_RISK_TYPE,
      ],
    );

    return result.rows[0] ? this.mapRow(result.rows[0]) : null;
  }

  async cancelPendingLargeTransactionReview(
    transactionId: string | number,
  ): Promise<void> {
    await this.database.query(
      `
        UPDATE transaction_risk_reviews
        SET status = 'cancelled',
            resolved_at = COALESCE(resolved_at, now()),
            updated_at = now()
        WHERE transaction_id::text = $1
          AND risk_type = $2
          AND status = 'pending'
      `,
      [String(transactionId), LARGE_TRANSACTION_RISK_TYPE],
    );
  }

  async findPendingById(
    reviewId: string | number,
    userId: string | number,
  ): Promise<TransactionRiskReview | null> {
    const result = await this.database.query<TransactionRiskReviewRow>(
      `
        SELECT *
        FROM transaction_risk_reviews
        WHERE id::text = $1
          AND user_id::text = $2
          AND risk_type = $3
          AND status = 'pending'
        LIMIT 1
      `,
      [String(reviewId), String(userId), LARGE_TRANSACTION_RISK_TYPE],
    );

    return result.rows[0] ? this.mapRow(result.rows[0]) : null;
  }

  private async findByFingerprint(
    transactionId: string | number,
    fingerprint: string,
  ): Promise<TransactionRiskReview | null> {
    const result = await this.database.query<TransactionRiskReviewRow>(
      `
        SELECT *
        FROM transaction_risk_reviews
        WHERE transaction_id::text = $1
          AND risk_type = $2
          AND risk_metrics->>'evaluationFingerprint' = $3
        ORDER BY created_at DESC
        LIMIT 1
      `,
      [String(transactionId), LARGE_TRANSACTION_RISK_TYPE, fingerprint],
    );

    return result.rows[0] ? this.mapRow(result.rows[0]) : null;
  }

  private fingerprintFromMetrics(
    metrics: Record<string, unknown> | undefined,
  ): string | null {
    const value = metrics?.evaluationFingerprint;

    return typeof value === 'string' && value ? value : null;
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
