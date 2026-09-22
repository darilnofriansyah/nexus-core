import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  canonicalizeInstallmentTerms,
  calculateInstallmentSchedule,
} from './installment-schedule';
import {
  InstallmentPlan,
  InstallmentPreview,
  InstallmentRequest,
  InstallmentSchedule,
  InstallmentTerms,
} from './dto/installments.dto';
import {
  DueInterestResult,
  InstallmentOriginal,
  InstallmentsRepository,
} from './installments.repository';
import {
  isPositivePostgresBigint,
  isValidMicrosecondUtcTimestamp,
} from './web-transaction-public-contract';

const REQUEST_KEYS = new Set([
  'telegramUserId',
  'expectedUpdatedAt',
  'tenorMonths',
  'monthlyRatePercent',
  'firstDueDate',
]);
const MAX_AMOUNT = 9_999_999_999_999;

interface PreparedRequest {
  telegramUserId: string;
  expectedUpdatedAt: string;
  terms: InstallmentRequest;
}

@Injectable()
export class InstallmentsService {
  constructor(private readonly repository: InstallmentsRepository) {}

  async postDueInterest(): Promise<DueInterestResult> {
    return this.repository.postDueInterest(this.currentTime());
  }

  async preview(
    transactionId: string,
    request: InstallmentRequest,
  ): Promise<InstallmentPreview> {
    const id = this.prepare(transactionId, request);
    const user = await this.repository.findActiveUserByTelegramId(
      id.telegramUserId,
    );
    if (!user) throw new NotFoundException('Transaction not found');
    const original = await this.repository.findOriginal(
      user.id,
      id.transactionId,
      user.timezone,
    );
    return this.buildPreview(original, id, user.timezone, true);
  }

  async create(
    transactionId: string,
    request: InstallmentRequest,
  ): Promise<InstallmentPlan> {
    const id = this.prepare(transactionId, request);
    const user = await this.repository.findActiveUserByTelegramId(
      id.telegramUserId,
    );
    if (!user) throw new NotFoundException('Transaction not found');
    const canonical = canonicalizeInstallmentTerms(id.terms);
    const result = await this.repository.create({
      userId: user.id,
      transactionId: id.transactionId,
      expectedUpdatedAt: id.expectedUpdatedAt,
      timezone: user.timezone,
      terms: canonical.terms,
      rateUnits: canonical.rateUnits,
      buildSchedule: (original) => {
        const preview = this.buildPreview(original, id, user.timezone, false);
        return {
          items: preview.items,
          totalInterest: preview.totalInterest,
          totalPayable: preview.totalPayable,
        };
      },
    });

    switch (result.kind) {
      case 'created':
      case 'existing':
        return result.plan;
      case 'not_found':
        throw new NotFoundException('Transaction not found');
      case 'invalid':
        throw new BadRequestException('Transaction is not eligible for installments');
      case 'conflict':
        throw new ConflictException('Installment plan conflicts with the current transaction');
    }
  }

  private prepare(transactionId: string, request: InstallmentRequest): PreparedRequest & { transactionId: string } {
    this.rejectUnknownKeys(request);
    const id = this.identifier(transactionId, 'transaction id');
    const telegramUserId = this.identifier(request.telegramUserId, 'telegramUserId');
    if (
      typeof request.expectedUpdatedAt !== 'string' ||
      !isValidMicrosecondUtcTimestamp(request.expectedUpdatedAt)
    ) {
      throw new BadRequestException('expectedUpdatedAt must be valid');
    }
    canonicalizeInstallmentTerms(request);
    return { transactionId: id, telegramUserId, expectedUpdatedAt: request.expectedUpdatedAt, terms: request };
  }

  protected currentTime(): Date {
    return new Date();
  }

  private buildPreview(
    original: InstallmentOriginal | null,
    prepared: PreparedRequest,
    timezone: string,
    checkVersion: boolean,
  ): InstallmentPreview {
    if (!original) throw new NotFoundException('Transaction not found');
    const principal = this.principal(original.amount);
    if (
      original.status !== 'confirmed' ||
      original.transactionType !== 'expense' ||
      original.source !== 'email' ||
      !original.creditCard ||
      !this.text(original.merchant) ||
      !this.text(original.category)
    ) {
      throw new BadRequestException('Transaction is not eligible for installments');
    }
    if (checkVersion && original.updatedAt !== prepared.expectedUpdatedAt) {
      throw new ConflictException('Transaction has changed');
    }
    const canonical = canonicalizeInstallmentTerms(prepared.terms);
    if (canonical.terms.firstDueDate < original.localDate) {
      throw new BadRequestException('firstDueDate must not precede the purchase date');
    }
    const schedule = calculateInstallmentSchedule(principal, canonical.terms);
    return this.previewResult(original, principal, timezone, canonical.terms, schedule);
  }

  private previewResult(
    original: InstallmentOriginal,
    principal: number,
    timezone: string,
    terms: InstallmentTerms,
    schedule: InstallmentSchedule,
  ): InstallmentPreview {
    return {
      originalTransactionId: original.id,
      originalUpdatedAt: original.updatedAt,
      principal,
      totalInterest: schedule.totalInterest,
      totalPayable: schedule.totalPayable,
      timezone,
      terms: {
        tenorMonths: terms.tenorMonths,
        monthlyRatePercent: terms.monthlyRatePercent,
        firstDueDate: terms.firstDueDate,
      },
      items: schedule.items,
    };
  }

  private rejectUnknownKeys(request: InstallmentRequest): void {
    if (typeof request !== 'object' || request === null || Array.isArray(request)) {
      throw new BadRequestException('request must be valid');
    }
    if (Object.keys(request).some((key) => !REQUEST_KEYS.has(key))) {
      throw new BadRequestException('request contains unknown fields');
    }
  }

  private identifier(value: unknown, name: string): string {
    if (
      (typeof value !== 'string' && typeof value !== 'number') ||
      (typeof value === 'number' && !Number.isSafeInteger(value))
    ) {
      throw new BadRequestException(`${name} must be valid`);
    }
    const identifier = String(value).trim();
    if (!isPositivePostgresBigint(identifier)) {
      throw new BadRequestException(`${name} must be valid`);
    }
    return identifier;
  }

  private principal(value: string | number): number {
    const match = /^([1-9]\d*)(?:\.0+)?$/.exec(String(value));
    const amount = match ? Number(match[1]) : Number.NaN;
    if (!Number.isSafeInteger(amount) || amount > MAX_AMOUNT) {
      throw new BadRequestException('Transaction amount must be a whole safe IDR amount');
    }
    return amount;
  }

  private text(value: string | null): value is string {
    return typeof value === 'string' && value.trim().length > 0;
  }
}
