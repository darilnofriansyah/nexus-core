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
