import * as assert from "node:assert/strict";
import { test } from "node:test";
import { AegisAlertFormatterService } from "./aegis-alert-formatter.service";

test("formats a raw n8n error trigger payload with nested HTTP request failure", () => {
  process.env.ADMIN_TELEGRAM_ID = "-1001234567890";
  const service = new AegisAlertFormatterService();

  const alert = service.formatN8nErrorAlert({
    workflow: {
      id: "z4ZSHXh84SMSt8MR",
      name: "Veyra Message Router - Nexus Core API",
    },
    execution: {
      id: "2212",
      url: "https://n8n.example.com/workflow/z4ZSHXh84SMSt8MR/executions/2212",
      mode: "webhook",
      lastNodeExecuted: "Call Veyra Record Sub-Workflow",
      executionContext: {
        triggerNode: {
          name: "Telegram Trigger",
        },
      },
      error: {
        message: "Bad request - please check your parameters",
        name: "NodeApiError",
        node: {
          name: "POST Core API Transaction Handle",
        },
        errorResponse: {
          httpCode: 400,
          executionId: "nested-conflict",
          messages:
            '400 - "{\\"message\\":\\"llmResult is missing required fields\\",\\"error\\":\\"Bad Request\\",\\"statusCode\\":400}"',
          context: {
            request: {
              method: "POST",
              uri: "http://core-api:3001/api/veyra/transactions/handle",
              body: {
                telegramUserId: "976684739",
                userId: 1,
                source: "manual",
                text: "Bought TUKU 25rb",
                llmResult: {
                  intent: "record_transaction",
                  transaction_type: "expense",
                  amount: 25000,
                  merchant: "TUKU",
                  category: "Others",
                  missing_fields: ["wallet"],
                  confidence: 0.6,
                },
              },
            },
          },
        },
      },
    },
  });

  assert.equal(alert.workflowId, "z4ZSHXh84SMSt8MR");
  assert.equal(alert.executionId, "2212");
  assert.equal(
    alert.executionUrl,
    "https://n8n.example.com/workflow/z4ZSHXh84SMSt8MR/executions/2212",
  );
  assert.equal(alert.parse_mode, "HTML");
  assert.equal(alert.disable_web_page_preview, true);
  assert.equal(alert.bot_token_env, "AEGIS_TOKEN");
  assert.match(alert.text, /^🚨 <b>Aegis Incident<\/b>/);
  assert.match(
    alert.text,
    /<b>Workflow:<\/b> Veyra Message Router - Nexus Core API/,
  );
  assert.match(
    alert.text,
    /<b>Execution:<\/b> <a href="https:\/\/n8n\.example\.com\/workflow\/z4ZSHXh84SMSt8MR\/executions\/2212">2212<\/a>/,
  );
  assert.match(alert.text, /<b>Mode:<\/b> webhook/);
  assert.match(alert.text, /<b>Trigger:<\/b> Telegram Trigger/);
  assert.match(
    alert.text,
    /<b>Failed Node:<\/b> POST Core API Transaction Handle/,
  );
  assert.match(alert.text, /<b>Last Node:<\/b> Call Veyra Record Sub-Workflow/);
  assert.match(
    alert.text,
    /<b>Error:<\/b> Bad request - please check your parameters/,
  );
  assert.match(alert.text, /<b>HTTP FAILURE<\/b>/);
  assert.match(alert.text, /<b>Status:<\/b> 400/);
  assert.match(
    alert.text,
    /<b>Endpoint:<\/b> POST \/api\/veyra\/transactions\/handle/,
  );
  assert.match(
    alert.text,
    /<b>Response:<\/b> llmResult is missing required fields \| Bad Request \| statusCode=400/,
  );
  assert.match(alert.text, /<b>Request Summary<\/b>/);
  assert.match(alert.text, /<b>User:<\/b> 976684739 \/ 1/);
  assert.match(alert.text, /<b>Source:<\/b> manual/);
  assert.match(alert.text, /<b>Text:<\/b> Bought TUKU 25rb/);
  assert.match(
    alert.text,
    /<b>LLM:<\/b> record_transaction, expense, 25000, TUKU, Others/,
  );
  assert.match(alert.text, /<b>Missing:<\/b> wallet/);
  assert.match(alert.text, /<b>Confidence:<\/b> 0\.6/);
  assert.equal(alert.retry.eligible, false);
  assert.equal(alert.retry.mode, "not_retryable");
  assert.equal(alert.retry.reason, "non_retryable_http_status");
  assert.equal(alert.reply_markup, undefined);
});

test("formats an array-shaped raw n8n error payload", () => {
  process.env.ADMIN_TELEGRAM_ID = "-1001234567890";
  const service = new AegisAlertFormatterService();

  const alert = service.formatN8nErrorAlert([
    {
      workflow: {
        id: "workflow-array",
        name: "Aegis Watchdog",
      },
      execution: {
        id: "exec-array",
        mode: "manual",
        error: {
          message: "Request timed out",
          node: {
            name: "HTTP Request",
          },
        },
      },
    },
  ]);

  assert.equal(alert.workflowId, "workflow-array");
  assert.equal(alert.executionId, "exec-array");
  assert.match(alert.text, /<b>Workflow:<\/b> Aegis Watchdog/);
  assert.match(alert.text, /<b>Failed Node:<\/b> HTTP Request/);
  assert.match(alert.text, /<b>Error:<\/b> Request timed out/);
  assert.deepEqual(alert.retry, {
    eligible: true,
    mode: "retryable",
    reason: "transient_error_message",
    workflowId: "workflow-array",
    executionId: "exec-array",
  });
  assert.deepEqual(alert.reply_markup, {
    inline_keyboard: [
      [
        {
          text: "Retry workflow",
          callback_data: "aegis_retry:workflow-array:exec-array",
        },
      ],
    ],
  });
});

test("formats flattened mapped fields from n8n", () => {
  process.env.ADMIN_TELEGRAM_ID = "-1001234567890";
  const service = new AegisAlertFormatterService();

  const alert = service.formatN8nErrorAlert({
    workflowName: "Reliable Telegram Sender",
    workflowId: "workflow-flat",
    executionId: 321,
    executionUrl: "https://n8n.example.com/execution/321",
    executionMode: "integrated",
    errorNode: "Telegram",
    errorMessage: "Bad Request: chat not found",
    severity: "critical",
    occurredAt: "2026-06-17T11:00:00.000Z",
    source: "n8n",
  });

  assert.equal(alert.severity, "CRITICAL");
  assert.equal(alert.workflowId, "workflow-flat");
  assert.equal(alert.executionId, "321");
  assert.equal(alert.executionUrl, "https://n8n.example.com/execution/321");
  assert.equal(alert.chatText, alert.text);
  assert.match(alert.text, /^🚨 <b>Aegis Incident<\/b>/);
  assert.match(alert.text, /<b>Workflow:<\/b> Reliable Telegram Sender/);
  assert.match(
    alert.text,
    /<b>Execution:<\/b> <a href="https:\/\/n8n\.example\.com\/execution\/321">321<\/a>/,
  );
  assert.match(alert.text, /<b>Error:<\/b> Bad Request: chat not found/);
  assert.match(alert.text, /<b>Failed Node:<\/b> Telegram/);
  assert.match(alert.text, /<b>Mode:<\/b> integrated/);
  assert.equal(alert.retry.eligible, false);
  assert.equal(alert.reply_markup, undefined);
});

test("uses stable defaults for sparse payloads", () => {
  process.env.ADMIN_TELEGRAM_ID = "-1001234567890";
  const service = new AegisAlertFormatterService();

  const alert = service.formatN8nErrorAlert({
    workflowName: "   ",
    severity: "warning",
    error: {
      description: "Fallback description",
    },
  });

  assert.equal(alert.severity, "WARNING");
  assert.equal(alert.workflowId, null);
  assert.equal(alert.executionId, null);
  assert.equal(alert.executionUrl, null);
  assert.deepEqual(alert.retry, {
    eligible: false,
    mode: "not_retryable",
    reason: "missing_retry_target",
    workflowId: null,
    executionId: null,
  });
  assert.equal(alert.reply_markup, undefined);
  assert.match(alert.text, /<b>Workflow:<\/b> Unknown workflow/);
  assert.match(alert.text, /<b>Execution:<\/b> Unknown/);
  assert.match(alert.text, /<b>Trigger:<\/b> Unknown/);
  assert.match(alert.text, /<b>Failed Node:<\/b> Unknown/);
  assert.match(alert.text, /<b>Error:<\/b> Fallback description/);
});

test("escapes interpolated Telegram HTML fields", () => {
  process.env.ADMIN_TELEGRAM_ID = "-1001234567890";
  const service = new AegisAlertFormatterService();

  const alert = service.formatN8nErrorAlert({
    workflowName: 'Aegis <Watchdog> & "Ops"',
    executionId: "exec<1>",
    executionUrl: "https://n8n.example.com/execution/exec-1?x=<tag>&y=1",
    executionMode: "manual",
    errorNode: "HTTP 'Request'",
    errorMessage: "Token <expired> & failed",
  });

  assert.match(
    alert.text,
    /<b>Workflow:<\/b> Aegis &lt;Watchdog&gt; &amp; &quot;Ops&quot;/,
  );
  assert.match(alert.text, /<b>Failed Node:<\/b> HTTP &#39;Request&#39;/);
  assert.match(
    alert.text,
    /<a href="https:\/\/n8n\.example\.com\/execution\/exec-1\?x=&lt;tag&gt;&amp;y=1">exec&lt;1&gt;<\/a>/,
  );
  assert.match(alert.text, /Token &lt;expired&gt; &amp; failed/);
});

test("redacts sensitive request body fields from Telegram text", () => {
  process.env.ADMIN_TELEGRAM_ID = "-1001234567890";
  const service = new AegisAlertFormatterService();

  const alert = service.formatN8nErrorAlert({
    workflowName: "Aegis Watchdog",
    execution: {
      id: "exec-secret",
      error: {
        message: "Core API rejected request",
        errorResponse: {
          httpCode: 400,
          context: {
            request: {
              method: "POST",
              uri: "/api/veyra/transactions/handle",
              body: {
                telegramUserId: "976684739",
                userId: 1,
                source: "manual",
                text: "safe text",
                authorization: "Bearer secret-token",
                api_key: "secret-api-key",
                llmResult: {
                  intent: "record_transaction",
                  token: "secret-llm-token",
                  missing_fields: ["wallet"],
                },
              },
            },
          },
        },
      },
    },
  });

  assert.doesNotMatch(alert.text, /secret-token/);
  assert.doesNotMatch(alert.text, /secret-api-key/);
  assert.doesNotMatch(alert.text, /secret-llm-token/);
  assert.match(alert.text, /<b>Text:<\/b> safe text/);
  assert.match(alert.text, /<b>LLM:<\/b> record_transaction/);
});

test("truncates generated text to the production-safe Telegram limit", () => {
  process.env.ADMIN_TELEGRAM_ID = "-1001234567890";
  const service = new AegisAlertFormatterService();

  const alert = service.formatN8nErrorAlert({
    workflowName: "Aegis Watchdog",
    executionId: "exec-456",
    executionMode: "error",
    errorMessage: "x".repeat(5000),
  });

  assert.equal(alert.text.length, 3900);
  assert.equal(alert.text.endsWith("..."), true);
});

test("adds retry workflow button for transient HTTP statuses and network errors", () => {
  process.env.ADMIN_TELEGRAM_ID = "-1001234567890";
  const service = new AegisAlertFormatterService();
  const cases = [
    {
      httpCode: 500,
      message: "Internal Server Error",
      reason: "transient_http_failure",
    },
    {
      httpCode: 429,
      message: "Too Many Requests",
      reason: "transient_http_failure",
    },
    {
      httpCode: undefined,
      message: "ECONNRESET connection reset",
      reason: "transient_error_message",
    },
  ];

  for (const item of cases) {
    const alert = service.formatN8nErrorAlert({
      workflow: { id: "workflow-retry", name: "Retryable Workflow" },
      execution: {
        id: "exec-retry",
        error: {
          message: item.message,
          errorResponse: item.httpCode
            ? { httpCode: item.httpCode, messages: item.message }
            : undefined,
        },
      },
    });

    assert.deepEqual(alert.retry, {
      eligible: true,
      mode: "retryable",
      reason: item.reason,
      workflowId: "workflow-retry",
      executionId: "exec-retry",
    });
    assert.equal(
      alert.reply_markup?.inline_keyboard[0]?.[0]?.callback_data,
      "aegis_retry:workflow-retry:exec-retry",
    );
  }
});

test("adds retry anyway button when HTTP details are missing", () => {
  process.env.ADMIN_TELEGRAM_ID = "-1001234567890";
  const service = new AegisAlertFormatterService();

  const alert = service.formatN8nErrorAlert({
    workflow: { id: "workflow-unknown", name: "Unknown Failure Workflow" },
    execution: {
      id: "exec-unknown",
      error: {
        message: "Workflow failed",
      },
    },
  });

  assert.deepEqual(alert.retry, {
    eligible: true,
    mode: "retry_anyway",
    reason: "missing_http_details",
    workflowId: "workflow-unknown",
    executionId: "exec-unknown",
  });
  assert.deepEqual(alert.reply_markup, {
    inline_keyboard: [
      [
        {
          text: "Retry anyway",
          callback_data: "aegis_retry_anyway:workflow-unknown:exec-unknown",
        },
      ],
    ],
  });
});

test("does not add retry button for non-retryable HTTP statuses and validation errors", () => {
  process.env.ADMIN_TELEGRAM_ID = "-1001234567890";
  const service = new AegisAlertFormatterService();
  const cases = [
    { httpCode: 401, message: "Unauthorized" },
    { httpCode: 403, message: "Forbidden" },
    { httpCode: 404, message: "Not found" },
    { httpCode: 422, message: "Validation failed" },
    { httpCode: undefined, message: "missing required fields" },
  ];

  for (const item of cases) {
    const alert = service.formatN8nErrorAlert({
      workflow: { id: "workflow-no-retry", name: "No Retry Workflow" },
      execution: {
        id: "exec-no-retry",
        error: {
          message: item.message,
          errorResponse: item.httpCode
            ? { httpCode: item.httpCode, messages: item.message }
            : undefined,
        },
      },
    });

    assert.equal(alert.retry.eligible, false);
    assert.equal(alert.retry.mode, "not_retryable");
    assert.equal(alert.reply_markup, undefined);
  }
});

test("returns retry instruction for Aegis retry callbacks", () => {
  process.env.ADMIN_TELEGRAM_ID = "-1001234567890";
  const service = new AegisAlertFormatterService();

  const retry = service.handleRetryCallback({
    callbackData: "aegis_retry:workflow-1:exec-1",
    chatId: "-1001234567890",
    messageId: 77,
  });
  const retryAnyway = service.handleRetryCallback({
    callbackData: "aegis_retry_anyway:workflow-2:exec-2",
    chatId: "-1001234567890",
    messageId: "78",
  });

  assert.equal(retry.status, "ready");
  assert.equal(retry.action, "retry_execution");
  assert.equal(retry.workflowId, "workflow-1");
  assert.equal(retry.executionId, "exec-1");
  assert.equal(retry.telegram.editMessageText.reply_markup, null);
  assert.equal(retry.telegram.editMessageText.chat_id, "-1001234567890");
  assert.equal(retry.telegram.editMessageText.message_id, "77");
  assert.equal(retryAnyway.status, "ready");
  assert.equal(retryAnyway.action, "retry_execution");
  assert.equal(retryAnyway.workflowId, "workflow-2");
  assert.equal(retryAnyway.executionId, "exec-2");
});

test("rejects malformed and non-admin Aegis retry callbacks safely", () => {
  process.env.ADMIN_TELEGRAM_ID = "-1001234567890";
  const service = new AegisAlertFormatterService();

  const invalid = service.handleRetryCallback({
    callbackData: "veyra_tx_manage:confirm",
    chatId: "-1001234567890",
    messageId: 77,
  });
  const unauthorized = service.handleRetryCallback({
    callbackData: "aegis_retry:workflow-1:exec-1",
    chatId: "-100999",
    messageId: 78,
  });

  assert.equal(invalid.status, "invalid");
  assert.equal(invalid.action, "none");
  assert.equal(invalid.telegram.editMessageText.reply_markup, null);
  assert.equal(unauthorized.status, "unauthorized");
  assert.equal(unauthorized.action, "none");
  assert.equal(unauthorized.workflowId, null);
  assert.equal(unauthorized.executionId, null);
});
