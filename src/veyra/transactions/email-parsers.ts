import {
  EmailTransactionMessageDto,
  ParsedEmailTransactionDto,
} from './dto/email-transaction.dto';

export interface EmailParserInput {
  email: EmailTransactionMessageDto;
  text: string;
  normalizedText: string;
}

export interface EmailTransactionParser {
  provider: string;
  templateKey: string;
  canParse(input: EmailParserInput): boolean;
  parse(input: EmailParserInput): ParsedEmailTransactionDto;
}

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

export function normalizeEmailWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
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
  const cleaned = rawValue.replace(/^[:\s-]+/, '').replace(/\s+/g, ' ').trim();

  return cleaned || null;
}

function amountAfter(text: string, labelPattern: RegExp): number | null {
  const match = labelPattern.exec(text);

  return cleanAmount(match?.[1]);
}

function firstRpAmount(text: string): number | null {
  return amountAfter(text, /\bRp\.?\s*([\d.,]+)/i);
}

function baseParsed(
  input: EmailParserInput,
  parser: EmailTransactionParser,
  partial: Omit<ParsedEmailTransactionDto, 'provider' | 'templateKey' | 'emailId'>,
): ParsedEmailTransactionDto {
  return {
    provider: parser.provider,
    templateKey: parser.templateKey,
    emailId: input.email.messageId,
    ...partial,
  };
}

export class BcaCreditCardTransactionParser implements EmailTransactionParser {
  readonly provider = 'BCA';
  readonly templateKey = 'bca-credit-card-transaction';

  canParse(input: EmailParserInput): boolean {
    const text = input.normalizedText;

    return (
      /Notifikasi Transaksi/i.test(text) &&
      /Merchant\s*\/?\s*ATM/i.test(text) &&
      /Jenis Transaksi/i.test(text) &&
      /Sejumlah/i.test(text)
    );
  }

  parse(input: EmailParserInput): ParsedEmailTransactionDto {
    const text = input.normalizedText;
    const merchant = textBetween(
      text,
      /Merchant\s*\/?\s*ATM/i,
      /Jenis Transaksi/i,
    );
    const amount = amountAfter(text, /Sejumlah\s*(?:Rp\.?\s*)?([\d.,]+)/i);
    const type = /\b(reversal|void)\b/i.test(text) ? 'reversal' : 'expense';

    return baseParsed(input, this, {
      merchant,
      amount,
      transactionDate: input.email.date ?? null,
      bank: 'BCA',
      paymentType: 'Credit Card',
      type,
      confidence: 98,
      isTransaction: true,
      raw: {
        subject: input.email.subject,
        matchedText: text,
      },
    });
  }
}

export class MandiriEmoneyTopupParser implements EmailTransactionParser {
  readonly provider = 'Mandiri';
  readonly templateKey = 'mandiri-emoney-topup';

  canParse(input: EmailParserInput): boolean {
    const text = input.normalizedText;

    return /Top-up e-money/i.test(text) && /Nominal Top-up/i.test(text);
  }

  parse(input: EmailParserInput): ParsedEmailTransactionDto {
    const text = input.normalizedText;

    return baseParsed(input, this, {
      merchant: 'E-Money Top Up',
      amount: amountAfter(text, /Nominal Top-up\s*(?:Rp\.?\s*)?([\d.,]+)/i),
      transactionDate: input.email.date ?? null,
      bank: 'Mandiri',
      paymentType: 'Transfer',
      type: 'expense',
      confidence: 95,
      isTransaction: true,
      raw: {
        subject: input.email.subject,
        matchedText: text,
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
    return amountAfter(text, /Jumlah:\s*Rp\.?\s*([\d.,]+)/i) ?? firstRpAmount(text);
  }

  protected build(
    input: EmailParserInput,
    partial: Omit<ParsedEmailTransactionDto, 'provider' | 'templateKey' | 'emailId' | 'bank'>,
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
    return /dana diterima|kamu telah menerima dana/i.test(input.normalizedText);
  }

  parse(input: EmailParserInput): ParsedEmailTransactionDto {
    const text = input.normalizedText;

    return this.build(input, {
      merchant: textBetween(text, /Dari:/i, /Ke:/i) ?? 'Incoming Transfer',
      amount: this.amount(text),
      transactionDate: input.email.date ?? null,
      paymentType: 'Transfer',
      type: 'income',
      confidence: 99,
      isTransaction: true,
      raw: { subject: input.email.subject, matchedText: text },
    });
  }
}

export class KromQrisPaymentParser extends KromParser {
  readonly templateKey = 'krom-qris-payment';

  canParse(input: EmailParserInput): boolean {
    const text = input.normalizedText;

    return /QRIS/i.test(text) && /transaksi/i.test(text) && /berhasil/i.test(text);
  }

  parse(input: EmailParserInput): ParsedEmailTransactionDto {
    const text = input.normalizedText;

    return this.build(input, {
      merchant: textBetween(text, /Merchant:/i, /Jumlah/i),
      amount: this.amount(text),
      transactionDate: input.email.date ?? null,
      paymentType: 'QRIS',
      type: 'expense',
      confidence: 97,
      isTransaction: true,
      raw: { subject: input.email.subject, matchedText: text },
    });
  }
}

export class KromOutgoingTransferParser extends KromParser {
  readonly templateKey = 'krom-outgoing-transfer';

  canParse(input: EmailParserInput): boolean {
    const text = input.normalizedText;

    return /Transfer Berhasil/i.test(text) || (/transfer/i.test(text) && /berhasil/i.test(text));
  }

  parse(input: EmailParserInput): ParsedEmailTransactionDto {
    const text = input.normalizedText;

    return this.build(input, {
      merchant: textBetween(text, /Ke:/i, /Metode transfer/i) ?? 'Transfer',
      amount: this.amount(text),
      transactionDate: input.email.date ?? null,
      paymentType: 'Transfer',
      type: 'expense',
      confidence: 97,
      isTransaction: true,
      raw: { subject: input.email.subject, matchedText: text },
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
