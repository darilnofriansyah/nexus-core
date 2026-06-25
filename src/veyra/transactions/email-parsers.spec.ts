import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BcaCreditCardTransactionParser,
  KromIncomingTransferParser,
  KromOutgoingTransferParser,
  KromQrisPaymentParser,
  MandiriEmoneyTopupParser,
  cleanAmount,
  normalizeEmailWhitespace,
} from './email-parsers';
import { EmailTransactionMessageDto } from './dto/email-transaction.dto';

function input(emailText: string, overrides: Partial<EmailTransactionMessageDto> = {}) {
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
  };
}

test('cleanAmount handles rupiah and separator variants', () => {
  assert.equal(cleanAmount('Rp50.000'), 50000);
  assert.equal(cleanAmount('IDR 50,000.00'), 50000);
  assert.equal(cleanAmount('Rp243.000,00'), 243000);
  assert.equal(cleanAmount('1.250.500'), 1250500);
  assert.equal(cleanAmount(undefined), null);
});

test('parses BCA credit card notification', () => {
  const parser = new BcaCreditCardTransactionParser();
  const parserInput = input(`
    Notifikasi Transaksi
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
    merchant: 'TOKO BUKU <ABC>',
    amount: 123456,
    transactionDate: '2026-06-22T10:00:00+07:00',
    bank: 'BCA',
    paymentType: 'Credit Card',
    type: 'expense',
    confidence: 98,
    isTransaction: true,
    raw: {
      subject: 'Email subject',
      matchedText:
        'Notifikasi Transaksi Merchant / ATM TOKO BUKU <ABC> Jenis Transaksi Pembelian Sejumlah Rp123.456',
    },
  });
});

test('parses BCA credit card notification with colon amount label', () => {
  const parser = new BcaCreditCardTransactionParser();
  const parserInput = input(
    'T - Notifikasi Transaksi Kartu Kredit - Berhasil (Apr 25) Yth. Pemegang Kartu Kredit BCA, Terima kasih telah bertransaksi menggunakan Kartu Kredit BCA: Nomor Customer : 0000000019303946 Nomor Kartu : 455633XXXX1715 Merchant / ATM : SHOPEE.CO.ID Jenis Transaksi : E-COMMERCE Otentikasi : TRANSAKSI DENGAN OTP Pada Tanggal : 25-06-2026 00:05:42 WIB Sejumlah : Rp243.000,00',
  );

  assert.equal(parser.canParse(parserInput), true);
  assert.equal(parser.parse(parserInput).merchant, 'SHOPEE.CO.ID');
  assert.equal(parser.parse(parserInput).amount, 243000);
});

test('parses Mandiri e-money top-up only', () => {
  const parser = new MandiriEmoneyTopupParser();
  const parserInput = input('Top-up e-money berhasil. Nominal Top-up Rp50.000');
  const genericInput = input('Mandiri Transaction Rp50.000 berhasil');

  assert.equal(parser.canParse(parserInput), true);
  assert.equal(parser.canParse(genericInput), false);
  assert.equal(parser.parse(parserInput).merchant, 'E-Money Top Up');
  assert.equal(parser.parse(parserInput).amount, 50000);
});

test('parses Krom incoming transfer with fallback merchant', () => {
  const parser = new KromIncomingTransferParser();
  const parserInput = input('Kamu telah menerima dana. Jumlah: Rp1.250.000');

  assert.equal(parser.canParse(parserInput), true);
  assert.equal(parser.parse(parserInput).merchant, 'Incoming Transfer');
  assert.equal(parser.parse(parserInput).amount, 1250000);
  assert.equal(parser.parse(parserInput).type, 'income');
});

test('parses Krom QRIS payment', () => {
  const parser = new KromQrisPaymentParser();
  const parserInput = input(
    'Transaksi QRIS berhasil. Merchant: Kopi Tuku Jumlah: Rp25.000',
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
  );
  const parsed = parser.parse(parserInput);

  assert.equal(parser.canParse(parserInput), true);
  assert.equal(parsed.merchant, 'Budi Santoso');
  assert.equal(parsed.amount, 75000);
  assert.equal(parsed.paymentType, 'Transfer');
});
