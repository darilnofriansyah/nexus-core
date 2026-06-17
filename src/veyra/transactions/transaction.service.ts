import { Injectable } from '@nestjs/common';

@Injectable()
export class TransactionService {
  placeholderStatus() {
    return {
      implemented: false,
      nextStep: 'Move transaction parsing and validation here before Telegram trigger removal.',
    };
  }
}

