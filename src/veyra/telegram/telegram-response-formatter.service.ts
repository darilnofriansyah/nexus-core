import { Injectable } from '@nestjs/common';
import { DetectedIntent } from '../intent/intent.service';

@Injectable()
export class TelegramResponseFormatterService {
  formatPlaceholderReply(intent: DetectedIntent['intent']): string {
    return [
      'Veyra Core API received the message.',
      `Detected intent: ${intent}.`,
      'n8n should still own Telegram delivery while this endpoint is in pilot mode.',
    ].join('\n');
  }
}

