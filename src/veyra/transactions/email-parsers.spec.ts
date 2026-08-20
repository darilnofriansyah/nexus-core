import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  BcaCreditCardTransactionParser,
  KromIncomingTransferParser,
  KromOutgoingTransferParser,
  KromQrisPaymentParser,
  MandiriEmoneyTopupParser,
  cleanAmount,
  detectEmailProviderAndTemplate,
  extractIndonesianDateTime,
  extractMerchantAfterLabels,
  extractIdrAmount,
  normalizeEmailBody,
  normalizeEmailWhitespace,
} from './email-parsers';
import { EmailTransactionMessageDto } from './dto/email-transaction.dto';

function input(
  emailText: string,
  overrides: Partial<EmailTransactionMessageDto> = {},
) {
  const email = {
    messageId: 'gmail-message-id',
    from: 'sender@email.com',
    subject: 'Email subject',
    date: '2026-06-22T10:00:00+07:00',
    emailText,
    ...overrides,
  };

  return {
    email,
    text: email.emailText,
    normalizedText: normalizeEmailWhitespace(email.emailText),
    bodySource: 'text' as const,
    bodyWarnings: [],
  };
}

function fixture(name: string): string {
  return readFileSync(
    join(process.cwd(), 'src/veyra/transactions/test/fixtures/email', name),
    'utf8',
  );
}

test('cleanAmount handles rupiah and separator variants', () => {
  assert.equal(cleanAmount('Rp50.000'), 50000);
  assert.equal(cleanAmount('IDR 50,000.00'), 50000);
  assert.equal(cleanAmount('Rp243.000,00'), 243000);
  assert.equal(cleanAmount('1.250.500'), 1250500);
  assert.equal(extractIdrAmount('IDR 25,000'), 25000);
  assert.equal(extractIdrAmount('25.000,00'), 25000);
  assert.equal(extractIdrAmount('25,000.00'), 25000);
  assert.equal(extractIdrAmount('25000'), 25000);
  assert.equal(cleanAmount(undefined), null);
});

test('extracts Indonesian date-time variants and merchant labels', () => {
  assert.equal(
    extractIndonesianDateTime('Pada Tanggal 25/06/2026 00:05'),
    '2026-06-25T00:05:00+07:00',
  );
  assert.equal(
    extractIndonesianDateTime('Pada Tanggal 2026-06-25 00:05'),
    '2026-06-25T00:05:00+07:00',
  );
  assert.equal(
    extractIndonesianDateTime('Pada Tanggal 25 Juni 2026 00:05'),
    '2026-06-25T00:05:00+07:00',
  );
  assert.equal(
    extractMerchantAfterLabels('Merchant: Kopi Tuku Jumlah: Rp25.000', [
      'Merchant',
    ]),
    'Kopi Tuku',
  );
});

test('parses BCA credit card notification', () => {
  const parser = new BcaCreditCardTransactionParser();
  const parserInput = input(`
    Notifikasi Transaksi
    Kartu Kredit BCA
    Merchant / ATM
    TOKO BUKU <ABC>
    Jenis Transaksi
    Pembelian
    Sejumlah Rp123.456
  `);

  assert.equal(parser.canParse(parserInput), true);
  assert.deepEqual(parser.parse(parserInput), {
    provider: 'BCA',
    templateKey: 'bca-credit-card-transaction',
    emailId: 'gmail-message-id',
    ok: true,
    merchant: 'TOKO BUKU <ABC>',
    merchantNormalized: null,
    amount: 123456,
    transactionDate: '2026-06-22T10:00:00+07:00',
    bank: 'BCA',
    paymentType: 'Credit Card',
    type: 'expense',
    confidence: 98,
    isTransaction: true,
    raw: {
      subject: 'Email subject',
      bodySource: 'text',
    },
    warnings: [],
  });
});

test('parses BCA credit card notification with colon amount label', () => {
  const parser = new BcaCreditCardTransactionParser();
  const parserInput = input(
    'T - Notifikasi Transaksi Kartu Kredit - Berhasil (Apr 25) Yth. Pemegang Kartu Kredit BCA, Terima kasih telah bertransaksi menggunakan Kartu Kredit BCA: Nomor Customer : 0000000019303946 Nomor Kartu : 455633XXXX1715 Merchant / ATM : SHOPEE.CO.ID Jenis Transaksi : E-COMMERCE Otentikasi : TRANSAKSI DENGAN OTP Pada Tanggal : 25-06-2026 00:05:42 WIB Sejumlah : Rp243.000,00',
    { from: 'card@bca.co.id' },
  );

  assert.equal(parser.canParse(parserInput), true);
  assert.equal(parser.parse(parserInput).merchant, 'SHOPEE.CO.ID');
  assert.equal(parser.parse(parserInput).amount, 243000);
});

test('parses BCA credit card notification when html-to-text drops the title', () => {
  const parser = new BcaCreditCardTransactionParser();
  const parserInput = input(
    'Yth. Pemegang Kartu Kredit BCA, Terima kasih telah bertransaksi menggunakan Kartu Kredit BCA: Nomor Customer : 0000000019303946 Nomor Kartu : 455633XXXX1715 Merchant / ATM : GoPayID Jenis Transaksi : E-COMMERCE Otentikasi : TRANSAKSI TANPA OTP Pada Tanggal : 05-07-2026 17:52:40 WIB Sejumlah : Rp51.999,00',
    { from: 'card@bca.co.id', subject: 'Credit Card Transaction Notification' },
  );

  assert.equal(parser.canParse(parserInput), true);
  assert.equal(parser.parse(parserInput).merchant, 'GoPayID');
  assert.equal(parser.parse(parserInput).amount, 51999);
});

test('parses BCA credit card reversal notification as reversal', () => {
  const parser = new BcaCreditCardTransactionParser();
  const parserInput = input(
    'Notifikasi Pembatalan Transaksi Kartu Kredit BCA Merchant / ATM : SHOPEE.CO.ID Jenis Transaksi : PEMBATALAN Pada Tanggal : 25-06-2026 00:05:42 WIB Sejumlah : Rp243.000,00',
    {
      from: 'card@bca.co.id',
      subject: 'Notifikasi Pembatalan Transaksi Kartu Kredit',
    },
  );

  assert.equal(parser.canParse(parserInput), true);
  assert.equal(parser.parse(parserInput).type, 'reversal');
});

test('detects BCA credit card reversal from subject when body title is missing', () => {
  const parser = new BcaCreditCardTransactionParser();
  const parserInput = input(
    'Kartu Kredit BCA Merchant / ATM : SHOPEE.CO.ID Jenis Transaksi : PEMBATALAN Pada Tanggal : 25-06-2026 00:05:42 WIB Sejumlah : Rp243.000,00',
    {
      from: 'card@bca.co.id',
      subject: 'Notifikasi Pembatalan Transaksi Kartu Kredit',
    },
  );

  assert.equal(parser.canParse(parserInput), true);
  assert.equal(parser.parse(parserInput).type, 'reversal');
});

test('parses Mandiri e-money top-up only', () => {
  const parser = new MandiriEmoneyTopupParser();
  const parserInput = input(
    'Top-up e-money berhasil. Nominal Top-up Rp50.000',
    {
      from: 'bankmandiri@bankmandiri.co.id',
    },
  );
  const genericInput = input('Mandiri Transaction Rp50.000 berhasil');

  assert.equal(parser.canParse(parserInput), true);
  assert.equal(parser.canParse(genericInput), false);
  assert.equal(parser.parse(parserInput).merchant, 'E-Money Top Up');
  assert.equal(parser.parse(parserInput).amount, 50000);
});

test('parses Krom incoming transfer with fallback merchant', () => {
  const parser = new KromIncomingTransferParser();
  const parserInput = input('Kamu telah menerima dana. Jumlah: Rp1.250.000', {
    from: 'no-reply@krom.id',
  });

  assert.equal(parser.canParse(parserInput), true);
  assert.equal(parser.parse(parserInput).merchant, 'Incoming Transfer');
  assert.equal(parser.parse(parserInput).amount, 1250000);
  assert.equal(parser.parse(parserInput).type, 'income');
});

test('parses Krom QRIS payment', () => {
  const parser = new KromQrisPaymentParser();
  const parserInput = input(
    'Transaksi QRIS berhasil. Merchant: Kopi Tuku Jumlah: Rp25.000',
    { from: 'no-reply@krom.id' },
  );
  const parsed = parser.parse(parserInput);

  assert.equal(parser.canParse(parserInput), true);
  assert.equal(parsed.merchant, 'Kopi Tuku');
  assert.equal(parsed.amount, 25000);
  assert.equal(parsed.paymentType, 'QRIS');
});

test('parses Krom outgoing transfer', () => {
  const parser = new KromOutgoingTransferParser();
  const parserInput = input(
    'Transfer Berhasil. Ke: Budi Santoso Metode transfer BI Fast Jumlah: Rp75.000',
    { from: 'no-reply@krom.id' },
  );
  const parsed = parser.parse(parserInput);

  assert.equal(parser.canParse(parserInput), true);
  assert.equal(parsed.merchant, 'Budi Santoso');
  assert.equal(parsed.amount, 75000);
  assert.equal(parsed.paymentType, 'Transfer');
});

test('detects provider and template without treating unknown templates as supported', () => {
  assert.deepEqual(
    detectEmailProviderAndTemplate({
      from: 'card@bca.co.id',
      subject: 'Promo BCA',
      normalizedText: 'Diskon belanja akhir pekan',
    }),
    {
      provider: 'BCA',
      templateKey: null,
      confidence: 50,
      matchedSignals: ['provider:bca'],
    },
  );

  assert.equal(
    detectEmailProviderAndTemplate({
      from: 'no-reply@krom.id',
      subject: 'Transaksi QRIS berhasil',
      normalizedText:
        'Transaksi QRIS berhasil. Merchant: Kopi Tuku Jumlah: Rp25.000',
    }).templateKey,
    'krom-qris-payment',
  );
});

test('parses supported and unsupported email fixtures', () => {
  const cases = [
    {
      parser: new BcaCreditCardTransactionParser(),
      fixtureName: 'bca-credit-card-success.txt',
      from: 'card@bca.co.id',
      subject: 'Notifikasi Transaksi',
      provider: 'BCA',
      templateKey: 'bca-credit-card-transaction',
      type: 'expense',
      amount: 123456,
      merchant: 'TOKO BUKU',
      transactionDate: '2026-06-25T00:05:00+07:00',
      paymentType: 'Credit Card',
      status: 'needs_review',
    },
    {
      parser: new MandiriEmoneyTopupParser(),
      fixtureName: 'mandiri-emoney-topup.txt',
      from: 'bankmandiri@bankmandiri.co.id',
      subject: 'Top-up e-money',
      provider: 'Mandiri',
      templateKey: 'mandiri-emoney-topup',
      type: 'expense',
      amount: 50000,
      merchant: 'E-Money Top Up',
      transactionDate: '2026-06-25T08:15:00+07:00',
      paymentType: 'Transfer',
      status: 'needs_review',
    },
    {
      parser: new KromQrisPaymentParser(),
      fixtureName: 'krom-qris-payment.txt',
      from: 'no-reply@krom.id',
      subject: 'Transaksi QRIS berhasil',
      provider: 'Krom',
      templateKey: 'krom-qris-payment',
      type: 'expense',
      amount: 25000,
      merchant: 'Kopi Tuku',
      transactionDate: '2026-06-25T09:30:00+07:00',
      paymentType: 'QRIS',
      status: 'needs_review',
    },
    {
      parser: new KromIncomingTransferParser(),
      fixtureName: 'krom-incoming-transfer.txt',
      from: 'no-reply@krom.id',
      subject: 'Dana diterima',
      provider: 'Krom',
      templateKey: 'krom-incoming-transfer',
      type: 'income',
      amount: 1250000,
      merchant: 'Budi Santoso',
      transactionDate: '2026-06-25T10:30:00+07:00',
      paymentType: 'Transfer',
      status: 'needs_review',
    },
    {
      parser: new KromOutgoingTransferParser(),
      fixtureName: 'krom-outgoing-transfer.txt',
      from: 'no-reply@krom.id',
      subject: 'Transfer Berhasil',
      provider: 'Krom',
      templateKey: 'krom-outgoing-transfer',
      type: 'expense',
      amount: 75000,
      merchant: 'Siti Aminah',
      transactionDate: '2026-06-25T11:45:00+07:00',
      paymentType: 'Transfer',
      status: 'needs_review',
    },
  ] as const;

  for (const item of cases) {
    const parserInput = input(fixture(item.fixtureName), {
      from: item.from,
      subject: item.subject,
    });
    const parsed = item.parser.parse(parserInput);

    assert.equal(item.parser.canParse(parserInput), true);
    assert.equal(parsed.provider, item.provider);
    assert.equal(parsed.templateKey, item.templateKey);
    assert.equal(parsed.isTransaction, true);
    assert.equal(parsed.type, item.type);
    assert.equal(parsed.amount, item.amount);
    assert.equal(parsed.merchant, item.merchant);
    assert.equal(parsed.transactionDate, item.transactionDate);
    assert.equal(parsed.paymentType, item.paymentType);
    assert.equal(item.status, 'needs_review');
  }

  const unsupported = detectEmailProviderAndTemplate({
    from: 'card@bca.co.id',
    subject: 'Promo BCA',
    normalizedText: normalizeEmailWhitespace(
      fixture('bca-credit-card-unsupported.txt'),
    ),
  });
  const marketing = detectEmailProviderAndTemplate({
    from: 'newsletter@example.com',
    subject: 'Weekly Deals',
    normalizedText: normalizeEmailWhitespace(fixture('marketing-email.txt')),
  });

  assert.equal(unsupported.provider, 'BCA');
  assert.equal(unsupported.templateKey, null);
  assert.equal(marketing.provider, 'unknown');
  assert.equal(marketing.templateKey, null);
});

test('normalizes html-only Krom QRIS fixture', () => {
  const body = normalizeEmailBody({
    emailText: '-',
    emailHtml: fixture('html-only-krom-qris.html'),
    htmlToText: (html) => html.replace(/<[^>]+>/g, ' '),
  });
  const parserInput = input(body.text, {
    from: 'no-reply@krom.id',
    subject: 'Transaksi QRIS berhasil',
  });
  const parser = new KromQrisPaymentParser();
  const parsed = parser.parse({
    ...parserInput,
    bodySource: body.source,
    bodyWarnings: body.warnings,
  });

  assert.equal(body.source, 'html');
  assert.equal(parser.canParse(parserInput), true);
  assert.equal(parsed.provider, 'Krom');
  assert.equal(parsed.templateKey, 'krom-qris-payment');
  assert.equal(parsed.amount, 25000);
  assert.equal(parsed.merchant, 'Kopi Tuku Cabang A');
  assert.equal(parsed.transactionDate, '2026-06-25T09:30:00+07:00');
  assert.equal(parsed.paymentType, 'QRIS');
});
