import * as assert from "node:assert/strict";
import { test } from "node:test";
import { AegisAlertFormatterService } from "./aegis-alert-formatter.service";

test("formats a raw n8n error trigger payload for the reliable sender", () => {
  process.env.ADMIN_TELEGRAM_ID = "-1001234567890";
  const service = new AegisAlertFormatterService();

  const alert = service.formatN8nErrorAlert({
    workflow: {
      id: "workflow-123",
      name: "Aegis Watchdog",
    },
    execution: {
      id: "exec-456",
      url: "https://n8n.example.com/execution/exec-456",
      mode: "error",
      stoppedAt: "2026-06-17T10:00:00.000Z",
    },
    error: {
      message: "Request timed out",
      node: {
        name: "HTTP Request",
      },
    },
  });

  const text = [
    "<b>AEGIS INCIDENT</b>",
    "------------------------------",
    "<b>Severity:</b> ERROR",
    "<b>Service:</b> Veyra",
    "<b>Workflow:</b> Aegis Watchdog",
    "<b>Node:</b> HTTP Request",
    "<b>Execution:</b> exec-456",
    "<b>Mode:</b> error",
    "------------------------------",
    "<b>Error:</b> Request timed out",
    "<b>Execution URL:</b> https://n8n.example.com/execution/exec-456",
  ].join("\n");

  assert.deepEqual(alert, {
    chatText: text,
    chat_id: "-1001234567890",
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    bot_token_env: "AEGIS_TOKEN",
    severity: "ERROR",
    workflowId: "workflow-123",
    executionId: "exec-456",
    executionUrl: "https://n8n.example.com/execution/exec-456",
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
  assert.equal(alert.parse_mode, "HTML");
  assert.equal(alert.disable_web_page_preview, true);
  assert.equal(alert.bot_token_env, "AEGIS_TOKEN");
  assert.match(alert.text, /^<b>AEGIS INCIDENT<\/b>/);
  assert.match(alert.text, /<b>Severity:<\/b> CRITICAL/);
  assert.match(alert.text, /<b>Workflow:<\/b> Reliable Telegram Sender/);
  assert.match(alert.text, /<b>Error:<\/b> Bad Request: chat not found/);
  assert.match(alert.text, /<b>Node:<\/b> Telegram/);
  assert.match(alert.text, /<b>Mode:<\/b> integrated/);
});

test("uses stable defaults for sparse or partially clean payloads", () => {
  process.env.ADMIN_TELEGRAM_ID = "-1001234567890";
  const service = new AegisAlertFormatterService();

  const alert = service.formatN8nErrorAlert({
    workflowName: "   ",
    severity: "warning",
    error: {
      description: "Fallback description",
    },
  });

  assert.equal(
    alert.text,
    [
      "<b>AEGIS INCIDENT</b>",
      "------------------------------",
      "<b>Severity:</b> WARNING",
      "<b>Service:</b> Veyra",
      "<b>Workflow:</b> Unknown workflow",
      "<b>Node:</b> Unknown",
      "<b>Execution:</b> Unknown",
      "<b>Mode:</b> Unknown",
      "------------------------------",
      "<b>Error:</b> Fallback description",
    ].join("\n"),
  );
  assert.equal(alert.chatText, alert.text);
  assert.equal(alert.severity, "WARNING");
  assert.equal(alert.workflowId, null);
  assert.equal(alert.executionId, null);
  assert.equal(alert.executionUrl, null);
});

test("escapes interpolated HTML fields", () => {
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
  assert.match(alert.text, /<b>Node:<\/b> HTTP &#39;Request&#39;/);
  assert.match(alert.text, /<b>Execution:<\/b> exec&lt;1&gt;/);
  assert.match(alert.text, /Token &lt;expired&gt; &amp; failed/);
  assert.match(alert.text, /x=&lt;tag&gt;&amp;y=1/);
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
