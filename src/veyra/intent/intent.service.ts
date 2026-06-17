import { Injectable } from '@nestjs/common';

export interface DetectedIntent {
  intent:
    | 'budget_upsert'
    | 'budget_delete'
    | 'budget_status'
    | 'transaction_create'
    | 'unknown';
  confidence: number;
}

@Injectable()
export class IntentService {
  detectIntent(messageText: string): DetectedIntent {
    const text = String(messageText ?? '').trim().toLowerCase();

    if (/\b(set|create|add|update)\b.*\bbudget\b/.test(text)) {
      return { intent: 'budget_upsert', confidence: 0.6 };
    }

    if (/\b(delete|remove)\b.*\bbudget\b/.test(text)) {
      return { intent: 'budget_delete', confidence: 0.6 };
    }

    if (/\b(status|check|show)\b.*\bbudget\b/.test(text)) {
      return { intent: 'budget_status', confidence: 0.6 };
    }

    if (/\b(spent|paid|bought|expense)\b/.test(text)) {
      return { intent: 'transaction_create', confidence: 0.5 };
    }

    return { intent: 'unknown', confidence: 0.2 };
  }
}

