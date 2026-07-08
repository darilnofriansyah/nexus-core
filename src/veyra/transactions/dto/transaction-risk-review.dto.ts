import {
  TransactionRiskLevel,
  TransactionRiskReview,
} from '../transaction-risk-review.repository';
import { TransactionCallbackTelegramPayloadDto } from './transaction-callback-handle.dto';

export interface CreateRegretReviewRequestDto {
  userId: string | number;
  transactionId: string | number;
  riskLevel: TransactionRiskLevel;
  riskScore?: number | null;
  riskReasons: unknown[];
  riskMetrics?: Record<string, unknown>;
}

export interface CreateRegretReviewResponseDto {
  status: 'ok';
  review: TransactionRiskReview;
  telegram: Omit<TransactionCallbackTelegramPayloadDto, 'method'>;
}
