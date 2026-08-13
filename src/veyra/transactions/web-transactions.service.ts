import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  WEB_TRANSACTION_MAX_CURSOR_LENGTH,
  WEB_TRANSACTION_MAX_TEXT_LENGTH,
  WebTransactionCursor,
  WebTransactionDirection,
  WebTransactionDto,
  WebTransactionRow,
  WebTransactionsFilter,
  WebTransactionsQueryRequestDto,
  WebTransactionsQueryResponseDto,
} from './dto/web-transactions.dto';
import { WebTransactionsRepository } from './web-transactions.repository';

interface Month {
  year: number;
  month: number;
}

const QUERY_KEYS = new Set([
  'telegramUserId',
  'cursor',
  'direction',
  'limit',
  'type',
  'cycle',
  'category',
  'merchantQuery',
  'asOfDate',
  'timezone',
]);
const POSTGRES_MAX_BIGINT = BigInt('9223372036854775807');

@Injectable()
export class WebTransactionsService {
  constructor(private readonly repository: WebTransactionsRepository) {}

  async queryTransactions(
    request: WebTransactionsQueryRequestDto,
  ): Promise<WebTransactionsQueryResponseDto> {
    this.rejectUnknownKeys(request);
    const telegramUserId = this.identifier(request.telegramUserId);
    const timezone = this.timezone(request.timezone);
    const filter = this.filter(request, timezone);
    const user =
      await this.repository.findActiveUserByTelegramId(telegramUserId);

    if (!user) {
      throw new NotFoundException('Telegram user not found');
    }

    this.addCycleBounds(filter, user.cycleStartDay);
    const categoryFilter = this.categoryFilter(filter);
    const [rows, categories] = await Promise.all([
      this.repository.findTransactions(user.id, filter),
      this.repository.findCategories(user.id, categoryFilter),
    ]);
    const page = this.page(rows, filter);

    return {
      items: page.rows.map((row) => this.publicTransaction(row)),
      previousCursor: page.hasNewer ? this.edgeCursor(page.rows[0]) : null,
      nextCursor: page.hasOlder ? this.edgeCursor(page.rows.at(-1)) : null,
      categories,
    };
  }

  private filter(
    request: WebTransactionsQueryRequestDto,
    timezone: string,
  ): WebTransactionsFilter {
    return {
      cursor: this.cursor(request.cursor),
      direction: this.direction(request.direction),
      limit: this.limit(request.limit),
      type: this.enumValue(request.type, ['income', 'expense'], 'type', null),
      cycle: this.enumValue(
        request.cycle,
        ['current', 'previous'],
        'cycle',
        null,
      ),
      category: this.text(request.category, 'category'),
      merchantQuery: this.text(request.merchantQuery, 'merchantQuery'),
      asOfDate: this.asOfDate(request.asOfDate, timezone),
      startDate: null,
      endDate: null,
      timezone,
    };
  }

  private categoryFilter(
    filter: WebTransactionsFilter,
  ): Omit<
    WebTransactionsFilter,
    'category' | 'cursor' | 'direction' | 'limit'
  > {
    return {
      type: filter.type,
      merchantQuery: filter.merchantQuery,
      cycle: filter.cycle,
      asOfDate: filter.asOfDate,
      startDate: filter.startDate,
      endDate: filter.endDate,
      timezone: filter.timezone,
    };
  }

  private page(
    rows: WebTransactionRow[],
    filter: WebTransactionsFilter,
  ): { rows: WebTransactionRow[]; hasNewer: boolean; hasOlder: boolean } {
    const hasExtra = rows.length > filter.limit;
    const displayedRows =
      filter.direction === 'previous'
        ? rows.slice(Math.max(rows.length - filter.limit, 0))
        : rows.slice(0, filter.limit);
    const hasCursor = filter.cursor !== null && displayedRows.length > 0;

    return {
      rows: displayedRows,
      hasNewer:
        hasCursor && (filter.direction === 'previous' ? hasExtra : true),
      hasOlder:
        displayedRows.length > 0 &&
        (filter.direction === 'previous' ? hasCursor : hasExtra),
    };
  }

  private publicTransaction(row: WebTransactionRow): WebTransactionDto {
    return {
      id: row.id,
      amount: this.safeIdr(row.amount),
      merchant: row.merchant,
      category: row.category,
      type: row.transactionType,
      source: row.source,
      transactionDate: row.transactionDate,
      updatedAt: row.updatedAt,
      creditCard: row.creditCard,
    };
  }

  private edgeCursor(row: WebTransactionRow | undefined): string | null {
    return row
      ? Buffer.from(
          JSON.stringify({
            transactionDate: row.transactionDate,
            id: row.id,
          } satisfies WebTransactionCursor),
        ).toString('base64url')
      : null;
  }

  private cursor(value: unknown): WebTransactionCursor | null {
    if (value === null || value === undefined) {
      return null;
    }
    if (
      typeof value !== 'string' ||
      value.length < 1 ||
      value.length > WEB_TRANSACTION_MAX_CURSOR_LENGTH ||
      !/^[A-Za-z0-9_-]+$/.test(value)
    ) {
      throw new BadRequestException('cursor must be valid');
    }

    try {
      const buffer = Buffer.from(value, 'base64url');
      if (buffer.toString('base64url') !== value) {
        throw new Error('non-canonical cursor');
      }
      const cursor: unknown = JSON.parse(buffer.toString('utf8'));
      if (!this.validCursor(cursor)) {
        throw new Error('invalid cursor payload');
      }
      return cursor;
    } catch {
      throw new BadRequestException('cursor must be valid');
    }
  }

  private validCursor(value: unknown): value is WebTransactionCursor {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return false;
    }
    const cursor = value as Record<string, unknown>;
    const keys = Object.keys(cursor).sort();
    return (
      keys.length === 2 &&
      keys[0] === 'id' &&
      keys[1] === 'transactionDate' &&
      typeof cursor.id === 'string' &&
      this.positiveBigint(cursor.id) &&
      typeof cursor.transactionDate === 'string' &&
      this.validMicrosecondTimestamp(cursor.transactionDate)
    );
  }

  private validMicrosecondTimestamp(value: string): boolean {
    const match =
      /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{6})Z$/.exec(value);
    if (!match) {
      return false;
    }
    const [, year, month, day, hour, minute, second] = match.map(Number);
    return (
      year >= 1 &&
      this.validCalendarDate(year, month, day) &&
      hour <= 23 &&
      minute <= 59 &&
      second <= 59
    );
  }

  private addCycleBounds(
    filter: WebTransactionsFilter,
    cycleStartDay: number,
  ): void {
    if (filter.cycle === null) {
      return;
    }
    const [year, month] = filter.asOfDate.split('-').map(Number);
    const thisMonth = { year, month };
    const day = Math.min(Math.max(Math.trunc(cycleStartDay), 1), 31);
    const currentMonth =
      filter.asOfDate >= this.monthBoundary(thisMonth, day)
        ? thisMonth
        : this.shiftMonth(thisMonth, -1);
    const startMonth =
      filter.cycle === 'previous'
        ? this.shiftMonth(currentMonth, -1)
        : currentMonth;

    filter.startDate = this.monthBoundary(startMonth, day);
    filter.endDate = this.monthBoundary(this.shiftMonth(startMonth, 1), day);
  }

  private monthBoundary(month: Month, cycleStartDay: number): string {
    const day = Math.min(
      cycleStartDay,
      this.daysInMonth(month.year, month.month),
    );
    return `${String(month.year).padStart(4, '0')}-${String(month.month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }

  private shiftMonth(month: Month, offset: number): Month {
    const index = month.year * 12 + month.month - 1 + offset;
    return {
      year: Math.floor(index / 12),
      month: (((index % 12) + 12) % 12) + 1,
    };
  }

  private rejectUnknownKeys(request: WebTransactionsQueryRequestDto): void {
    if (
      typeof request !== 'object' ||
      request === null ||
      Object.keys(request).some((key) => !QUERY_KEYS.has(key))
    ) {
      throw new BadRequestException('query contains unsupported fields');
    }
  }

  private identifier(value: unknown): string {
    if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) {
      return String(value);
    }
    if (typeof value === 'string') {
      const identifier = value.trim();
      if (this.positiveBigint(identifier)) {
        return identifier;
      }
    }
    throw new BadRequestException('telegramUserId must be a positive integer');
  }

  private timezone(value: unknown): string {
    if (value === null || value === undefined) {
      return 'Asia/Jakarta';
    }
    if (typeof value !== 'string' || !value.trim()) {
      throw new BadRequestException('timezone must be valid');
    }
    const timezone = value.trim();
    try {
      new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format();
      return timezone;
    } catch {
      throw new BadRequestException('timezone must be valid');
    }
  }

  private asOfDate(value: unknown, timezone: string): string {
    if (value === null || value === undefined) {
      return this.localDate(new Date(), timezone);
    }
    if (typeof value !== 'string') {
      throw new BadRequestException('asOfDate must be YYYY-MM-DD');
    }
    const date = value.trim();
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
    if (
      !match ||
      !this.validCalendarDate(
        Number(match[1]),
        Number(match[2]),
        Number(match[3]),
      )
    ) {
      throw new BadRequestException('asOfDate must be a valid date');
    }
    return date;
  }

  private validCalendarDate(year: number, month: number, day: number): boolean {
    return (
      year >= 1 &&
      month >= 1 &&
      month <= 12 &&
      day >= 1 &&
      day <= this.daysInMonth(year, month)
    );
  }

  private daysInMonth(year: number, month: number): number {
    if (month === 2) {
      const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
      return leap ? 29 : 28;
    }
    return [4, 6, 9, 11].includes(month) ? 30 : 31;
  }

  private localDate(date: Date, timezone: string): string {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(date);
    const part = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find((item) => item.type === type)?.value ?? '';
    return `${part('year')}-${part('month')}-${part('day')}`;
  }

  private limit(value: unknown): number {
    if (value === null || value === undefined) {
      return 50;
    }
    if (
      typeof value !== 'number' ||
      !Number.isInteger(value) ||
      value < 1 ||
      value > 50
    ) {
      throw new BadRequestException('limit must be an integer from 1 to 50');
    }
    return value;
  }

  private direction(value: unknown): WebTransactionDirection {
    return (
      this.enumValue(value, ['next', 'previous'], 'direction', 'next') ?? 'next'
    );
  }

  private positiveBigint(value: string): boolean {
    return /^[1-9]\d*$/.test(value) && BigInt(value) <= POSTGRES_MAX_BIGINT;
  }

  private text(value: unknown, name: string): string | null {
    if (value === null || value === undefined) {
      return null;
    }
    if (typeof value !== 'string') {
      throw new BadRequestException(`${name} must be valid`);
    }
    const text = value.trim();
    if (!text || text.length > WEB_TRANSACTION_MAX_TEXT_LENGTH) {
      throw new BadRequestException(`${name} must be valid`);
    }
    return text;
  }

  private enumValue<T extends string>(
    value: unknown,
    allowed: readonly T[],
    name: string,
    defaultValue: T | null,
  ): T | null {
    if (value === null || value === undefined) {
      return defaultValue;
    }
    if (typeof value === 'string' && allowed.includes(value as T)) {
      return value as T;
    }
    throw new BadRequestException(`${name} must be valid`);
  }

  private safeIdr(value: number): number {
    const amount = Math.round(value);
    return Number.isSafeInteger(amount) && amount >= 0 ? amount : 0;
  }
}
