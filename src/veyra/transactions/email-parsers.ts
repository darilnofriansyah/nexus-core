import {
  EmailTransactionMessageDto,
  ParsedEmailTransactionDto,
} from './dto/email-transaction.dto';

export interface EmailParserInput {
  email: EmailTransactionMessageDto;
  text: string;
  normalizedText: string;
  bodySource: EmailBodySource;
  bodyWarnings: string[];
}

export interface EmailTransactionParser {
  provider: string;
  templateKey: string;
  canParse(input: EmailParserInput): boolean;
  parse(input: EmailParserInput): ParsedEmailTransactionDto;
}

export type EmailBodySource = 'text' | 'html' | 'empty';
export type EmailProvider = 'BCA' | 'Mandiri' | 'Krom' | 'unknown';

export interface NormalizedEmailBody {
  text: string;
  source: EmailBodySource;
  warnings: string[];
}

export interface EmailTemplateDetection {
  provider: EmailProvider;
  templateKey: string | null;
  confidence: number;
  matchedSignals: string[];
}

const COMMON_HTML_ENTITIES: Record<string, string> = {
  amp: '&',
  gt: '>',
  lt: '<',
  nbsp: ' ',
  quot: '"',
  apos: "'",
};

const INDONESIAN_MONTHS: Record<string, string> = {
  jan: '01',
  januari: '01',
  feb: '02',
  februari: '02',
  mar: '03',
  maret: '03',
  apr: '04',
  april: '04',
  mei: '05',
  may: '05',
  jun: '06',
  juni: '06',
  jul: '07',
  juli: '07',
  aug: '08',
  agu: '08',
  agustus: '08',
  sep: '09',
  september: '09',
  oct: '10',
  okt: '10',
  oktober: '10',
  nov: '11',
  november: '11',
  dec: '12',
  des: '12',
  desember: '12',
};

export function cleanAmount(value: string | undefined): number | null {
  if (!value) {
    return null;
  }

  const cleaned = value.replace(/[^\d,.-]/g, '');
  const lastComma = cleaned.lastIndexOf(',');
  const lastDot = cleaned.lastIndexOf('.');
  let normalized = cleaned;

  if (lastComma >= 0 && lastDot >= 0) {
    const decimalSeparator = lastComma > lastDot ? ',' : '.';
    const thousandsSeparator = decimalSeparator === ',' ? '.' : ',';
    normalized = cleaned
      .replace(new RegExp(`\\${thousandsSeparator}`, 'g'), '')
      .replace(decimalSeparator, '.');
  } else if (lastComma >= 0 || lastDot >= 0) {
    const separator = lastComma >= 0 ? ',' : '.';
    const separatorIndex = lastComma >= 0 ? lastComma : lastDot;
    const fractionLength = cleaned.length - separatorIndex - 1;
    normalized =
      fractionLength === 3
        ? cleaned.replace(new RegExp(`\\${separator}`, 'g'), '')
        : cleaned.replace(separator, '.');
  }

  const amount = Number(normalized);

  return Number.isFinite(amount) ? Math.abs(amount) : null;
}

export function decodeCommonHtmlEntities(value: string): string {
  return value.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
    const key = String(entity).toLowerCase();

    if (key.startsWith('#x')) {
      return String.fromCodePoint(Number.parseInt(key.slice(2), 16));
    }

    if (key.startsWith('#')) {
      return String.fromCodePoint(Number.parseInt(key.slice(1), 10));
    }

    return COMMON_HTML_ENTITIES[key] ?? match;
  });
}

export function normalizeEmailWhitespace(value: string): string {
  return decodeCommonHtmlEntities(value)
    .replace(/\u00a0/g, ' ')
    .replace(/[\u200b-\u200f\u202a-\u202e\ufeff]/g, '')
    .replace(/[ \t\r\f\v]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeEmailBody(input: {
  emailText?: string | null;
  emailHtml?: string | null;
  htmlToText?: (html: string) => string;
}): NormalizedEmailBody {
  const text = normalizeEmailWhitespace(input.emailText ?? '');

  if (text.length >= 20 || !input.emailHtml) {
    return {
      text,
      source: text ? 'text' : 'empty',
      warnings: text.length < 20 ? ['email text is short'] : [],
    };
  }

  const htmlText = normalizeEmailWhitespace(
    input.htmlToText ? input.htmlToText(input.emailHtml) : input.emailHtml,
  );

  return {
    text: htmlText,
    source: htmlText ? 'html' : 'empty',
    warnings: text ? ['email text is short; used html fallback'] : [],
  };
}

export function extractIdrAmount(text: string): number | null {
  const match =
    /\b(?:Rp\.?|IDR)\s*([\d.,]+)/i.exec(text) ??
    /(?:^|\s)(\d{1,3}(?:[.,]\d{3})+(?:[.,]\d{2})?|\d{4,})(?:\s|$)/.exec(text);

  return cleanAmount(match?.[1]);
}

export function extractIndonesianDateTime(
  text: string,
  fallbackDate?: string,
): string | null {
  const numeric =
    /\b(\d{1,2})[/-](\d{1,2})[/-](\d{4})\s+(\d{1,2}):(\d{2})(?::\d{2})?\b/.exec(
      text,
    );
  const iso =
    /\b(\d{4})-(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})(?::\d{2})?\b/.exec(text);
  const named =
    /\b(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})\s+(\d{1,2}):(\d{2})(?::\d{2})?\b/.exec(
      text,
    );

  if (numeric) {
    return dateTimeString(
      numeric[3],
      numeric[2],
      numeric[1],
      numeric[4],
      numeric[5],
    );
  }

  if (iso) {
    return dateTimeString(iso[1], iso[2], iso[3], iso[4], iso[5]);
  }

  if (named) {
    const month = INDONESIAN_MONTHS[named[2].toLowerCase()];

    if (month) {
      return dateTimeString(named[3], month, named[1], named[4], named[5]);
    }
  }

  return fallbackDate ?? null;
}

export function extractMerchantAfterLabels(
  text: string,
  labels: string[],
): string | null {
  for (const label of labels) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = new RegExp(`${escaped}\\s*:?\\s*(.+)`, 'i').exec(text);

    if (!match) {
      continue;
    }

    const merchant = match[1]
      .split(
        /\b(?:Jenis Transaksi|Otentikasi|Pada Tanggal|Sejumlah|Jumlah|Nominal|Dari|Ke|Metode transfer)\b/i,
      )[0]
      .replace(/^[:\s-]+/, '')
      .replace(/\s+/g, ' ')
      .trim();

    if (merchant) {
      return merchant;
    }
  }

  return null;
}

export function detectEmailProviderAndTemplate(input: {
  from?: string | null;
  subject?: string | null;
  normalizedText: string;
}): EmailTemplateDetection {
  const combined = `${input.from ?? ''} ${input.subject ?? ''} ${input.normalizedText}`;
  const matchedSignals: string[] = [];
  let provider: EmailProvider = 'unknown';

  if (/\bbca\b|klikbca|bank central asia/i.test(combined)) {
    provider = 'BCA';
    matchedSignals.push('provider:bca');
  } else if (/mandiri/i.test(combined)) {
    provider = 'Mandiri';
    matchedSignals.push('provider:mandiri');
  } else if (/\bkrom\b/i.test(combined)) {
    provider = 'Krom';
    matchedSignals.push('provider:krom');
  }

  const text = input.normalizedText;
  const subject = input.subject ?? '';

  if (
    provider === 'BCA' &&
    (/Notifikasi (?:Pembatalan )?Transaksi/i.test(text) ||
      /Notifikasi Pembatalan Transaksi/i.test(subject) ||
      /Credit Card Transaction Notification/i.test(subject)) &&
    /Merchant\s*\/?\s*ATM/i.test(text) &&
    /Jenis Transaksi/i.test(text) &&
    /Sejumlah/i.test(text)
  ) {
    return detected(provider, 'bca-credit-card-transaction', 98, [
      ...matchedSignals,
      'subject:credit-card-transaction',
      'body:merchant-atm',
      'body:sejumlah',
    ]);
  }

  if (
    provider === 'Mandiri' &&
    /Top-up e-money/i.test(text) &&
    /Nominal Top-up/i.test(text)
  ) {
    return detected(provider, 'mandiri-emoney-topup', 95, [
      ...matchedSignals,
      'body:top-up-e-money',
      'body:nominal-top-up',
    ]);
  }

  if (
    provider === 'Krom' &&
    /dana diterima|kamu telah menerima dana/i.test(text)
  ) {
    return detected(provider, 'krom-incoming-transfer', 99, [
      ...matchedSignals,
      'body:incoming-transfer',
    ]);
  }

  if (
    provider === 'Krom' &&
    /QRIS/i.test(text) &&
    /transaksi/i.test(text) &&
    /berhasil/i.test(text)
  ) {
    return detected(provider, 'krom-qris-payment', 97, [
      ...matchedSignals,
      'body:qris',
      'body:berhasil',
    ]);
  }

  if (
    provider === 'Krom' &&
    (/Transfer Berhasil/i.test(text) ||
      (/transfer/i.test(text) && /berhasil/i.test(text)))
  ) {
    return detected(provider, 'krom-outgoing-transfer', 97, [
      ...matchedSignals,
      'body:outgoing-transfer',
    ]);
  }

  return {
    provider,
    templateKey: null,
    confidence: provider === 'unknown' ? 0 : 50,
    matchedSignals,
  };
}

function detected(
  provider: Exclude<EmailProvider, 'unknown'>,
  templateKey: string,
  confidence: number,
  matchedSignals: string[],
): EmailTemplateDetection {
  return { provider, templateKey, confidence, matchedSignals };
}

function dateTimeString(
  year: string,
  month: string,
  day: string,
  hour: string,
  minute: string,
): string {
  return `${year.padStart(4, '0')}-${month.padStart(2, '0')}-${day.padStart(2, '0')}T${hour.padStart(2, '0')}:${minute}:00+07:00`;
}

function textBetween(
  text: string,
  startPattern: RegExp,
  endPattern: RegExp,
): string | null {
  const startMatch = startPattern.exec(text);

  if (!startMatch?.index && startMatch?.index !== 0) {
    return null;
  }

  const startIndex = startMatch.index + startMatch[0].length;
  const tail = text.slice(startIndex);
  const endMatch = endPattern.exec(tail);
  const rawValue = endMatch ? tail.slice(0, endMatch.index) : tail;
  const cleaned = rawValue
    .replace(/^[:\s-]+/, '')
    .replace(/\s+/g, ' ')
    .trim();

  return cleaned || null;
}

function amountAfter(text: string, labelPattern: RegExp): number | null {
  const match = labelPattern.exec(text);

  return cleanAmount(match?.[1]) ?? extractIdrAmount(text);
}

function firstRpAmount(text: string): number | null {
  return amountAfter(text, /\bRp\.?\s*([\d.,]+)/i);
}

function baseParsed(
  input: EmailParserInput,
  parser: EmailTransactionParser,
  partial: Omit<
    ParsedEmailTransactionDto,
    | 'ok'
    | 'provider'
    | 'templateKey'
    | 'emailId'
    | 'merchantNormalized'
    | 'warnings'
  >,
): ParsedEmailTransactionDto {
  const detection = detectEmailProviderAndTemplate({
    from: input.email.from,
    subject: input.email.subject,
    normalizedText: input.normalizedText,
  });

  return {
    ok: true,
    provider: parser.provider,
    templateKey: parser.templateKey,
    emailId: input.email.messageId,
    merchantNormalized: null,
    warnings: input.bodyWarnings,
    ...partial,
    confidence: detection.confidence || partial.confidence,
  };
}

export class BcaCreditCardTransactionParser implements EmailTransactionParser {
  readonly provider = 'BCA';
  readonly templateKey = 'bca-credit-card-transaction';

  canParse(input: EmailParserInput): boolean {
    return (
      detectEmailProviderAndTemplate({
        from: input.email.from,
        subject: input.email.subject,
        normalizedText: input.normalizedText,
      }).templateKey === this.templateKey
    );
  }

  parse(input: EmailParserInput): ParsedEmailTransactionDto {
    const text = input.normalizedText;
    const merchant =
      extractMerchantAfterLabels(text, ['Merchant / ATM', 'Merchant/ATM']) ??
      textBetween(text, /Merchant\s*\/?\s*ATM/i, /Jenis Transaksi/i);
    const amount = amountAfter(text, /Sejumlah\s*:?\s*(?:Rp\.?\s*)?([\d.,]+)/i);
    const type = /\b(reversal|void|pembatalan|dibatalkan)\b/i.test(text)
      ? 'reversal'
      : 'expense';

    return baseParsed(input, this, {
      merchant,
      amount,
      transactionDate: extractIndonesianDateTime(text, input.email.date),
      bank: 'BCA',
      paymentType: 'Credit Card',
      type,
      confidence: 98,
      isTransaction: true,
      raw: {
        subject: input.email.subject,
        bodySource: input.bodySource,
      },
    });
  }
}

export class MandiriEmoneyTopupParser implements EmailTransactionParser {
  readonly provider = 'Mandiri';
  readonly templateKey = 'mandiri-emoney-topup';

  canParse(input: EmailParserInput): boolean {
    return (
      detectEmailProviderAndTemplate({
        from: input.email.from,
        subject: input.email.subject,
        normalizedText: input.normalizedText,
      }).templateKey === this.templateKey
    );
  }

  parse(input: EmailParserInput): ParsedEmailTransactionDto {
    const text = input.normalizedText;

    return baseParsed(input, this, {
      merchant: 'E-Money Top Up',
      amount: amountAfter(text, /Nominal Top-up\s*(?:Rp\.?\s*)?([\d.,]+)/i),
      transactionDate: extractIndonesianDateTime(text, input.email.date),
      bank: 'Mandiri',
      paymentType: 'Transfer',
      type: 'expense',
      confidence: 95,
      isTransaction: true,
      raw: {
        subject: input.email.subject,
        bodySource: input.bodySource,
      },
    });
  }
}

abstract class KromParser implements EmailTransactionParser {
  abstract readonly templateKey: string;
  readonly provider = 'Krom';

  abstract canParse(input: EmailParserInput): boolean;
  abstract parse(input: EmailParserInput): ParsedEmailTransactionDto;

  protected amount(text: string): number | null {
    return (
      amountAfter(text, /Jumlah:\s*Rp\.?\s*([\d.,]+)/i) ?? firstRpAmount(text)
    );
  }

  protected build(
    input: EmailParserInput,
    partial: Omit<
      ParsedEmailTransactionDto,
      | 'ok'
      | 'provider'
      | 'templateKey'
      | 'emailId'
      | 'bank'
      | 'merchantNormalized'
      | 'warnings'
    >,
  ): ParsedEmailTransactionDto {
    return baseParsed(input, this, {
      bank: 'Krom',
      ...partial,
    });
  }
}

export class KromIncomingTransferParser extends KromParser {
  readonly templateKey = 'krom-incoming-transfer';

  canParse(input: EmailParserInput): boolean {
    return (
      detectEmailProviderAndTemplate({
        from: input.email.from,
        subject: input.email.subject,
        normalizedText: input.normalizedText,
      }).templateKey === this.templateKey
    );
  }

  parse(input: EmailParserInput): ParsedEmailTransactionDto {
    const text = input.normalizedText;

    return this.build(input, {
      merchant:
        textBetween(text, /Dari:/i, /Ke:/i) ??
        extractMerchantAfterLabels(text, ['Dari']) ??
        'Incoming Transfer',
      amount: this.amount(text),
      transactionDate: extractIndonesianDateTime(text, input.email.date),
      paymentType: 'Transfer',
      type: 'income',
      confidence: 99,
      isTransaction: true,
      raw: { subject: input.email.subject, bodySource: input.bodySource },
    });
  }
}

export class KromQrisPaymentParser extends KromParser {
  readonly templateKey = 'krom-qris-payment';

  canParse(input: EmailParserInput): boolean {
    return (
      detectEmailProviderAndTemplate({
        from: input.email.from,
        subject: input.email.subject,
        normalizedText: input.normalizedText,
      }).templateKey === this.templateKey
    );
  }

  parse(input: EmailParserInput): ParsedEmailTransactionDto {
    const text = input.normalizedText;

    return this.build(input, {
      merchant: extractMerchantAfterLabels(text, ['Merchant']),
      amount: this.amount(text),
      transactionDate: extractIndonesianDateTime(text, input.email.date),
      paymentType: 'QRIS',
      type: 'expense',
      confidence: 97,
      isTransaction: true,
      raw: { subject: input.email.subject, bodySource: input.bodySource },
    });
  }
}

export class KromOutgoingTransferParser extends KromParser {
  readonly templateKey = 'krom-outgoing-transfer';

  canParse(input: EmailParserInput): boolean {
    return (
      detectEmailProviderAndTemplate({
        from: input.email.from,
        subject: input.email.subject,
        normalizedText: input.normalizedText,
      }).templateKey === this.templateKey
    );
  }

  parse(input: EmailParserInput): ParsedEmailTransactionDto {
    const text = input.normalizedText;

    return this.build(input, {
      merchant:
        textBetween(text, /Ke:/i, /Metode transfer/i) ??
        extractMerchantAfterLabels(text, ['Ke']) ??
        'Transfer',
      amount: this.amount(text),
      transactionDate: extractIndonesianDateTime(text, input.email.date),
      paymentType: 'Transfer',
      type: 'expense',
      confidence: 97,
      isTransaction: true,
      raw: { subject: input.email.subject, bodySource: input.bodySource },
    });
  }
}

export function buildEmailParserRegistry(): EmailTransactionParser[] {
  return [
    new BcaCreditCardTransactionParser(),
    new MandiriEmoneyTopupParser(),
    new KromIncomingTransferParser(),
    new KromQrisPaymentParser(),
    new KromOutgoingTransferParser(),
  ];
}
