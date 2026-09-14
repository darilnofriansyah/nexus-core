'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  authorizePrivateOperator,
  buildRoutedCommand,
  formatTelegramResult,
  injectedInput,
  normalizeCreatorUpdate,
  parseTelegramCommand,
  runBaselineTransport,
} = require('./creator-transport.cjs');

const operator = {
  id: 976684739,
  from: { id: 976684739 },
  chat: { id: 976684739, type: 'private' },
};

test('baseline accepts the existing private text update shape', () => {
  assert.deepEqual(
    authorizePrivateOperator(
      injectedInput({ message: { ...operator, text: '/rv help' } }),
    ),
    [
      {
        json: {
          text: '/rv help',
          telegramUserId: 976684739,
          chatId: 976684739,
          chatType: 'private',
        },
      },
    ],
  );
});

test('preserves Telegram update_id as a decimal string for creative messages', () => {
  const authorized = authorizePrivateOperator(
    injectedInput({
      update_id: 987654321,
      message: { ...operator, text: '/new' },
    }),
  );

  assert.equal(authorized[0].json.updateId, '987654321');
});

test('normalizes private callbacks and orders acknowledgement before Core', () => {
  assert.equal(typeof normalizeCreatorUpdate, 'function');
  const normalized = normalizeCreatorUpdate(
    injectedInput({
      update_id: 987654322,
      callback_query: {
        id: 'callback-1',
        from: { id: 976684739 },
        data: 'rv:opaque-token',
        message: { chat: { id: 976684739, type: 'private' } },
      },
    }),
  );

  assert.deepEqual(normalized, {
    request: {
      telegramUserId: '976684739',
      chatId: '976684739',
      updateId: '987654322',
      callbackToken: 'rv:opaque-token',
    },
    callbackAcknowledgement: { callbackQueryId: 'callback-1' },
    order: ['answerCallbackQuery', 'coreRequest'],
  });

  assert.equal(normalizeCreatorUpdate(injectedInput({
    update_id: 987654323,
    callback_query: {
      id: 'callback-2',
      from: { id: 123 },
      data: 'rv:opaque-token',
      message: { chat: { id: 976684739, type: 'private' } },
    },
  })), null);
});

test('baseline drops a plain draft answer before any creator request', () => {
  const result = runBaselineTransport(
    { message: { ...operator, text: 'A fox learns to share.' } },
    undefined,
  );

  assert.equal(result.authorized.length, 1);
  assert.equal(result.parsed[0].json.accepted, false);
  assert.equal(result.parsed[0].json.reason, 'unsupported_command');
  assert.equal(result.routed[0].json.dispatch, false);
  assert.equal(result.coreRequest, null);
  assert.deepEqual(result.telegram, [{ json: { text: 'Use /rv help.' } }]);
});

test('baseline rejects callback_query updates before routing', () => {
  const result = runBaselineTransport(
    {
      callback_query: {
        id: 'callback-1',
        from: { id: 976684739 },
        data: 'rv:new',
        message: { chat: { id: 976684739, type: 'private' } },
      },
    },
    undefined,
  );

  assert.deepEqual(result.authorized, []);
  assert.equal(result.coreRequest, null);
  assert.deepEqual(result.telegram, []);
});

test('formats Core creator text and preserves URL and callback keyboards', () => {
  const route = buildRoutedCommand(
    injectedInput({
      text: '/rv episode 00000000-0000-4000-8000-000000000000',
      telegramUserId: 976684739,
      chatId: 976684739,
      chatType: 'private',
    }),
  )[0].json;
  const result = formatTelegramResult(
    injectedInput({
      statusCode: 200,
      body: {
        ok: true,
        data: {
          text: 'Draft queued.',
          inlineKeyboard: [[
            { text: 'Review', callbackData: 'rv:opaque-token' },
            { text: 'Guide', url: 'https://example.test/guide' },
          ]],
        },
      },
    }),
    route,
  );

  assert.deepEqual(result, [{ json: {
    text: 'Draft queued.',
    reply_markup: { inline_keyboard: [[
      { text: 'Review', callback_data: 'rv:opaque-token' },
      { text: 'Guide', url: 'https://example.test/guide' },
    ]] },
  } }]);
});

test('uses Core-owned destination for replayable creative result replies', () => {
  const result = formatTelegramResult(
    injectedInput({
      statusCode: 200,
      body: {
        ok: true,
        data: {
          chatId: '976684739',
          reply: { text: 'Creative draft saved.' },
        },
      },
    }),
    { dispatch: false },
  );

  assert.deepEqual(result, [{
    json: { chat_id: '976684739', text: 'Creative draft saved.' },
  }]);
});

test('preserves legacy HTTP error formatting', () => {
  const route = buildRoutedCommand(
    injectedInput({
      text: '/rv episode 00000000-0000-4000-8000-000000000000',
      telegramUserId: 976684739,
      chatId: 976684739,
      chatType: 'private',
    }),
  )[0].json;
  const result = formatTelegramResult(
    injectedInput({ statusCode: 503, body: { ok: false, error: 'unavailable' } }),
    route,
  );

  assert.deepEqual(result, [{ json: { text: 'episode.get failed (503).' } }]);
});

test('baseline legacy parser and adapter routing remain available', () => {
  const parsed = parseTelegramCommand(
    injectedInput({
      text: '/rv help',
      telegramUserId: 976684739,
      chatId: 976684739,
      chatType: 'private',
    }),
  );
  const routed = buildRoutedCommand(injectedInput(parsed[0].json));

  assert.equal(parsed[0].json.accepted, true);
  assert.equal(routed[0].json.dispatch, false);
  assert.equal(routed[0].json.help.startsWith('Commands:'), true);
});
