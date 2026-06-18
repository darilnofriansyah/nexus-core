import { IntentResult } from '../intent-result.interface';

export interface ClassifyIntentRequestDto {
  userId: string | number;
  message: string;
  conversationState?: Record<string, unknown>;
  timezone?: string;
}

export type ClassifyIntentResponseDto = IntentResult;
