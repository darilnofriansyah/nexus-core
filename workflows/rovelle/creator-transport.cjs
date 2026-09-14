'use strict';

const ALLOWLISTED_TELEGRAM_ID = 976684739;

const LEGACY_WORKFLOW_IDS = Object.freeze({
  episode: 'qNLzy9LxDMkbNXEk',
  asset: 'lG1QQDlnGmqdcbCj',
  canon: 'iK5vzv54YA1kSF84',
  generation: 'jBrgmLgl1zXUjYSq',
  render: 'MNA2y4eGUnYfcW2H',
  final: 'TKfPLFbNvQHsoHC4',
});

function injectedInput(json) {
  return { first: () => ({ json }) };
}

function firstJson($input) {
  return $input?.first?.()?.json ?? {};
}

function authorizePrivateOperator($input) {
  const update = firstJson($input);
  const message = update.message ?? update;
  const updateId = decimalUpdateId(update.update_id);
  const fromId = message?.from?.id;
  const chatId = message?.chat?.id;
  const chatType = message?.chat?.type;

  if (
    fromId !== ALLOWLISTED_TELEGRAM_ID ||
    chatId !== ALLOWLISTED_TELEGRAM_ID ||
    chatType !== 'private'
  ) {
    return [];
  }

  if (update.update_id !== undefined && updateId === null) return [];

  if (typeof message.text !== 'string') return [];

  return [
    {
      json: {
        text: message.text,
        telegramUserId: fromId,
        chatId,
        chatType,
        ...(updateId === undefined ? {} : { updateId }),
      },
    },
  ];
}

function normalizeCreatorUpdate($input) {
  const update = firstJson($input);
  const updateId = decimalUpdateId(update.update_id);
  if (updateId === null) return null;

  const callback = update.callback_query;
  const message = callback ? callback.message : update.message ?? update;
  const from = callback ? callback.from : message?.from;
  const chat = message?.chat;
  if (
    from?.id !== ALLOWLISTED_TELEGRAM_ID ||
    chat?.id !== ALLOWLISTED_TELEGRAM_ID ||
    chat?.type !== 'private'
  ) {
    return null;
  }

  const request = {
    telegramUserId: String(from.id),
    chatId: String(chat.id),
    ...(updateId === undefined ? {} : { updateId }),
  };
  if (callback) {
    if (
      typeof callback.id !== 'string' ||
      callback.id.length === 0 ||
      typeof callback.data !== 'string' ||
      !callback.data.startsWith('rv:') ||
      !callback.data.slice(3).trim() ||
      /[\r\n]/.test(callback.data.slice(3))
    ) {
      return null;
    }
    return {
      request: { ...request, callbackToken: callback.data },
      callbackAcknowledgement: { callbackQueryId: callback.id },
      order: ['answerCallbackQuery', 'coreRequest'],
    };
  }

  if (typeof message?.text !== 'string') return null;
  return {
    request: { ...request, messageText: message.text },
    callbackAcknowledgement: null,
    order: ['coreRequest'],
  };
}

function decimalUpdateId(value) {
  if (typeof value === 'string') {
    return /^[0-9]{1,32}$/.test(value) ? value : null;
  }
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return String(value);
  }
  return value === undefined ? undefined : null;
}

function parseTelegramCommand($input) {
  const input = firstJson($input);
  const text = String(input.text ?? '').trim();

  if (!text.startsWith('/rv')) {
    return [{ json: { ...input, accepted: false, reason: 'unsupported_command' } }];
  }

  return [{ json: { ...input, accepted: true, text } }];
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

function buildRoutedCommand($input) {
  const input = firstJson($input);
  const text = String(input.text ?? '').trim();
  const parts = text.split(/\s+/);
  const id = parts[2];

  const output = (command, workflowId) => [
    { json: { ...input, dispatch: true, command, workflowId } },
  ];
  const help = (reason) => [{ json: { ...input, dispatch: false, help: reason } }];

  if (parts[0] !== '/rv') return help('Use /rv help.');

  const action = parts[1];
  if (action === 'help') {
    return help(
      'Commands: episode, generations, generation, renders, render, queue, reviews, master, generate, retry-render, final.',
    );
  }
  if (action === 'episode' && isUuid(id)) {
    return output({ operation: 'episode.get', params: { id }, body: {} }, LEGACY_WORKFLOW_IDS.episode);
  }
  if (action === 'generations' && isUuid(id)) {
    return output(
      { operation: 'generation.list', params: { shotId: id }, body: {} },
      LEGACY_WORKFLOW_IDS.generation,
    );
  }
  if (action === 'generation' && isUuid(id)) {
    return output(
      { operation: 'generation.get', params: { generationId: id }, body: {} },
      LEGACY_WORKFLOW_IDS.generation,
    );
  }
  if (action === 'renders' && isUuid(id)) {
    return output(
      { operation: 'render.list', params: { episodeId: id }, body: {} },
      LEGACY_WORKFLOW_IDS.render,
    );
  }
  if (action === 'render' && isUuid(id)) {
    return output(
      { operation: 'render.get', params: { renderId: id }, body: {} },
      LEGACY_WORKFLOW_IDS.render,
    );
  }
  if (action === 'queue' && (!id || isUuid(id))) {
    return output(
      { operation: 'final.queue', params: id ? { episodeId: id } : {}, body: {} },
      LEGACY_WORKFLOW_IDS.final,
    );
  }
  if (action === 'reviews' && isUuid(id)) {
    return output(
      { operation: 'final.history', params: { renderId: id }, body: {} },
      LEGACY_WORKFLOW_IDS.final,
    );
  }
  if (action === 'master' && isUuid(id)) {
    return output(
      { operation: 'final.master', params: { episodeId: id }, body: {} },
      LEGACY_WORKFLOW_IDS.final,
    );
  }
  if (
    action === 'generate' &&
    isUuid(id) &&
    ['DRAFT', 'PRODUCTION'].includes(parts[3]) &&
    isUuid(parts[4])
  ) {
    return output(
      {
        operation: 'generation.submit',
        params: { shotId: id },
        body: { profile: parts[3], requestId: parts[4] },
      },
      LEGACY_WORKFLOW_IDS.generation,
    );
  }
  if (action === 'retry-render' && isUuid(id) && isUuid(parts[3])) {
    return output(
      {
        operation: 'render.retry',
        params: { renderId: id },
        body: { requestId: parts[3] },
      },
      LEGACY_WORKFLOW_IDS.render,
    );
  }
  if (
    action === 'final' &&
    isUuid(id) &&
    ['APPROVE', 'REJECT', 'RERENDER'].includes(parts[3]) &&
    isUuid(parts[4])
  ) {
    const notes = parts.slice(5).join(' ');
    return output(
      {
        operation: 'final.submit',
        params: { renderId: id },
        body: {
          decision: parts[3],
          requestId: parts[4],
          ...(notes ? { notes } : {}),
        },
      },
      LEGACY_WORKFLOW_IDS.final,
    );
  }

  return help('Invalid /rv command. Use /rv help.');
}

function formatTelegramResult($input, route) {
  const input = firstJson($input);
  const status = Number(input.statusCode);
  const data = input.body?.data ?? {};
  const reply = data.reply && typeof data.reply === 'object' ? data.reply : data;
  if (
    status >= 200 &&
    status < 300 &&
    input.body?.ok === true &&
    typeof reply.text === 'string'
  ) {
    const keyboard = telegramKeyboard(reply.inlineKeyboard);
    return [
      {
        json: {
          ...(typeof data.chatId === 'string' ? { chat_id: data.chatId } : {}),
          text: reply.text,
          ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
        },
      },
    ];
  }

  if (!route?.dispatch) return [{ json: { text: route?.help ?? 'Invalid command.' } }];

  const id = data.id ?? data.render?.id ?? data.episode?.id ?? data.generationId ?? null;
  const statusText = data.status ?? data.render?.status ?? null;

  if (status >= 200 && status < 300 && input.body?.ok === true) {
    return [
      {
        json: {
          text: [
            route.command.operation,
            'OK',
            id ? `ID: ${id}` : '',
            statusText ? `Status: ${statusText}` : '',
          ]
            .filter(Boolean)
            .join('\n'),
        },
      },
    ];
  }

  return [
    {
      json: {
        text: `${route.command.operation} failed (${Number.isInteger(status) ? status : 502}).`,
      },
    },
  ];
}

function telegramKeyboard(value) {
  if (!Array.isArray(value)) return null;
  const keyboard = value.map((row) => {
    if (!Array.isArray(row)) return [];
    return row.flatMap((button) => {
      if (!button || typeof button.text !== 'string') return [];
      if (typeof button.callbackData === 'string') {
        return [{ text: button.text, callback_data: button.callbackData }];
      }
      if (typeof button.url === 'string') {
        return [{ text: button.text, url: button.url }];
      }
      return [];
    });
  });
  return keyboard.some((row) => row.length > 0) ? keyboard : null;
}

function runBaselineTransport(update, coreResponse) {
  const authorized = authorizePrivateOperator(injectedInput(update));
  if (!authorized.length) {
    return { authorized, parsed: [], routed: [], coreRequest: null, telegram: [] };
  }

  const parsed = parseTelegramCommand(injectedInput(authorized[0].json));
  const routed = buildRoutedCommand(injectedInput(parsed[0].json));
  const route = routed[0].json;
  const coreRequest = route.dispatch
    ? {
        operation: route.command.operation,
        workflowId: route.workflowId,
      }
    : null;
  const telegram = formatTelegramResult(
    injectedInput(coreResponse ?? {}),
    route,
  );

  return { authorized, parsed, routed, coreRequest, telegram };
}

module.exports = {
  ALLOWLISTED_TELEGRAM_ID,
  LEGACY_WORKFLOW_IDS,
  injectedInput,
  authorizePrivateOperator,
  normalizeCreatorUpdate,
  parseTelegramCommand,
  buildRoutedCommand,
  formatTelegramResult,
  runBaselineTransport,
};
