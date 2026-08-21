import { InternalServerErrorException } from '@nestjs/common';
import {
  WEB_TRANSACTION_MAX_TEXT_LENGTH,
  WebTransactionDto,
  WebTransactionRow,
} from './dto/web-transactions.dto';

const POSTGRES_MAX_BIGINT = BigInt('9223372036854775807');
const MICROSECOND_UTC_TIMESTAMP =
  /^(\d{4})(-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\.\d{6}Z$/;

export function toPublicWebTransaction(
  row: WebTransactionRow,
): WebTransactionDto {
  const type = publicTransactionType(row.transactionType);
  const merchant = publicNullableText(row.merchant);
  const category = publicNullableText(row.category);
  const pocketId = publicNullableIdentifier(row.pocketId);
  const pocketName = publicNullableText(row.pocketName);

  return {
    id: publicIdentifier(row.id),
    amount: toPublicIdrAmount(row.amount),
    merchant,
    category,
    pocketId,
    pocketName,
    type,
    source: publicSource(row.source),
    transactionDate: publicTimestamp(row.transactionDate),
    updatedAt: publicTimestamp(row.updatedAt),
    creditCard: publicBoolean(row.creditCard),
  };
}

export function toPublicWebTransactionCategories(
  categories: readonly unknown[],
): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of categories) {
    const category = publicNullableText(value);
    if (category === null) {
      invalidPublicData();
    }
    if (!seen.has(category)) {
      seen.add(category);
      result.push(category);
    }
  }
  return result;
}

export function isPositivePostgresBigint(value: string): boolean {
  return /^[1-9]\d*$/.test(value) && BigInt(value) <= POSTGRES_MAX_BIGINT;
}

export function isValidMicrosecondUtcTimestamp(value: string): boolean {
  const match = MICROSECOND_UTC_TIMESTAMP.exec(value);
  if (!match) {
    return false;
  }
  const timestampToSeconds = `${match[1]}${match[2]}`;
  if (Number(match[1]) < 1) {
    return false;
  }
  const date = new Date(`${timestampToSeconds}.000Z`);
  return (
    !Number.isNaN(date.valueOf()) &&
    date.toISOString().slice(0, 19) === timestampToSeconds
  );
}

export function toPublicIdrAmount(value: unknown): number {
  if (typeof value === 'string') {
    const match = /^([1-9]\d*)(?:\.0+)?$/.exec(value);
    if (!match || BigInt(match[1]) > BigInt(Number.MAX_SAFE_INTEGER)) {
      return invalidPublicData();
    }
    return Number(match[1]);
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    return invalidPublicData();
  }
  return value;
}

function publicIdentifier(value: unknown): string {
  if (typeof value !== 'string' || !isPositivePostgresBigint(value)) {
    return invalidPublicData();
  }
  return value;
}

function publicNullableIdentifier(value: unknown): string | null {
  if (value === null) {
    return null;
  }
  return publicIdentifier(value);
}

function publicNullableText(value: unknown): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    return invalidPublicData();
  }
  const text = value.trim();
  if (text.length > WEB_TRANSACTION_MAX_TEXT_LENGTH) {
    return invalidPublicData();
  }
  return text || null;
}

function publicTransactionType(value: unknown): WebTransactionDto['type'] {
  if (value !== 'income' && value !== 'expense') {
    return invalidPublicData();
  }
  return value;
}

function publicSource(value: unknown): WebTransactionDto['source'] {
  if (
    value !== 'telegram' &&
    value !== 'email' &&
    value !== 'manual' &&
    value !== 'import'
  ) {
    return invalidPublicData();
  }
  return value;
}

function publicTimestamp(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !isValidMicrosecondUtcTimestamp(value)
  ) {
    return invalidPublicData();
  }
  return value;
}

function publicBoolean(value: unknown): boolean {
  if (typeof value !== 'boolean') {
    return invalidPublicData();
  }
  return value;
}

function invalidPublicData(): never {
  throw new InternalServerErrorException('Transaction data is invalid');
}
