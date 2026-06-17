import assert from 'node:assert/strict';
import test from 'node:test';
import { AegisAlertFormatterService } from './aegis-alert-formatter.service';

test('formats a raw n8n error trigger payload for Telegram', () => {
  const service = new AegisAlertFormatterService();

  const alert = service.formatN8nErrorAlert({
    workflow: {
      id: 'workflow-123',
      name: 'Aegis Watchdog',
    },
    execution: {
      id: 'exec-456',
      url: 'https://n8n.example.com/execution/exec-456',
      stoppedAt: '2026-06-17T10:00:00.000Z',
    },
    error: {
      message: 'Request timed out',
      node: {
        name: 'HTTP Request',
      },
    },
  });

  assert.deepEqual(alert, {
    chatText: [
      'Aegis ERROR alert',
      'Workflow: Aegis Watchdog (workflow-123)',
      'Error: Request timed out',
      'Node: HTTP Request',
      'Execution: exec-456',
      'URL: https://n8n.example.com/execution/exec-456',
      'When: 2026-06-17T10:00:00.000Z',
    ].join('\n'),
    severity: 'ERROR',
    workflowId: 'workflow-123',
    executionId: 'exec-456',
    executionUrl: 'https://n8n.example.com/execution/exec-456',
  });
});

test('preserves the existing flattened alert fields during migration', () => {
  const service = new AegisAlertFormatterService();

  const alert = service.formatN8nErrorAlert({
    workflowName: 'Reliable Telegram Sender',
    workflowId: 'workflow-flat',
    executionId: 321,
    executionUrl: 'https://n8n.example.com/execution/321',
    errorNode: 'Telegram',
    errorMessage: 'Bad Request: chat not found',
    severity: 'critical',
    occurredAt: '2026-06-17T11:00:00.000Z',
    source: 'n8n',
  });

  assert.equal(alert.severity, 'CRITICAL');
  assert.equal(alert.workflowId, 'workflow-flat');
  assert.equal(alert.executionId, '321');
  assert.equal(alert.executionUrl, 'https://n8n.example.com/execution/321');
  assert.match(alert.chatText, /^Aegis CRITICAL alert/);
  assert.match(
    alert.chatText,
    /Workflow: Reliable Telegram Sender \(workflow-flat\)/,
  );
  assert.match(alert.chatText, /Error: Bad Request: chat not found/);
  assert.match(alert.chatText, /Node: Telegram/);
});

test('uses stable defaults for sparse or partially clean payloads', () => {
  const service = new AegisAlertFormatterService();

  const alert = service.formatN8nErrorAlert({
    workflowName: '   ',
    severity: 'warning',
    error: {
      description: 'Fallback description',
    },
  });

  assert.equal(
    alert.chatText,
    [
      'Aegis WARNING alert',
      'Workflow: Unknown workflow',
      'Error: Fallback description',
    ].join('\n'),
  );
  assert.equal(alert.severity, 'WARNING');
  assert.equal(alert.workflowId, null);
  assert.equal(alert.executionId, null);
  assert.equal(alert.executionUrl, null);
});
