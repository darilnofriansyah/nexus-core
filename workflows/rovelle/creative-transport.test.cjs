'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const transport = require('./creative-transport.cjs');

const JOB_ID = '00000000-0000-4000-8000-000000000001';
const COMPLETION = {
  attemptToken: 'A'.repeat(43),
  inputHash: 'a'.repeat(64),
  status: 'COMPLETED',
  metadata: {
    instructionVersion: 'storyboard-v1',
    sdkVersion: '0.154.0',
    model: 'gpt-5.6-luna',
    threadId: null,
    usage: null,
  },
  result: { synopsis: 'A story.', script: 'Once...', shots: [] },
};

test('buildCreativeDispatch emits only a fixed worker route for exact Core dispatch actions', () => {
  assert.equal(typeof transport.buildCreativeDispatch, 'function');
  assert.deepEqual(transport.buildCreativeDispatch({
    ok: true,
    data: { creativeJob: { id: JOB_ID, action: 'DISPATCH' } },
  }), {
    method: 'POST',
    path: '/jobs',
    body: { jobId: JOB_ID },
    credentialRef: 'CODEX_WORKER_DISPATCH_KEY',
    credentialHeader: 'x-codex-dispatch-key',
    timeoutMs: 10_000,
    followRedirects: false,
    maxBodyBytes: 1024,
  });
});

test('dispatch ignores unknown actions, invalid IDs, and model-provided URLs', () => {
  assert.equal(typeof transport.buildCreativeDispatch, 'function');
  assert.equal(transport.buildCreativeDispatch({
    ok: true,
    data: { creativeJob: { id: JOB_ID, action: 'APPROVE' } },
  }), null);
  assert.equal(transport.buildCreativeDispatch({
    ok: true,
    data: { creativeJob: { id: '../jobs', action: 'DISPATCH' } },
  }), null);
  assert.equal(transport.buildCreativeDispatch({
    ok: true,
    data: { creativeJob: { id: JOB_ID, action: 'DISPATCH', url: 'https://evil.test/' } },
  }), null);
  assert.equal(transport.buildCreativeDispatch({
    ok: false,
    data: { creativeJob: { id: JOB_ID, action: 'DISPATCH' } },
  }), null);
  assert.equal(transport.buildCreativeDispatch({
    statusCode: 502,
    body: { ok: true, data: { creativeJob: { id: JOB_ID, action: 'DISPATCH' } } },
  }), null);
  assert.equal(transport.buildCreativeDispatch({
    statusCode: 'bad-status',
    body: { ok: true, data: { creativeJob: { id: JOB_ID, action: 'DISPATCH' } } },
  }), null);
});

test('claim forwarding validates job ID and uses the fixed Core route', () => {
  assert.equal(typeof transport.buildCreativeClaimForward, 'function');
  assert.deepEqual(transport.buildCreativeClaimForward({ jobId: JOB_ID }), {
    method: 'POST',
    path: `/rovelle/creative-jobs/${JOB_ID}/claim`,
    body: {},
    credentialRef: 'ROVELLE_CREATIVE_WORKER_KEY',
    credentialHeader: 'x-rovelle-worker-key',
    timeoutMs: 10_000,
    followRedirects: false,
    maxBodyBytes: 1024,
  });
  assert.equal(transport.buildCreativeClaimForward({ jobId: JOB_ID, url: 'https://evil.test/' }), null);
  assert.equal(transport.buildCreativeClaimForward({ jobId: '../claim' }), null);
});

test('result forwarding strips the routing ID and caps the Core request body', () => {
  assert.equal(typeof transport.buildCreativeResultForward, 'function');
  assert.deepEqual(transport.buildCreativeResultForward({ jobId: JOB_ID, completion: COMPLETION }), {
    method: 'POST',
    path: `/rovelle/creative-jobs/${JOB_ID}/result`,
    body: COMPLETION,
    credentialRef: 'ROVELLE_CREATIVE_WORKER_KEY',
    credentialHeader: 'x-rovelle-worker-key',
    timeoutMs: 10_000,
    followRedirects: false,
    maxBodyBytes: 512 * 1024,
  });
  assert.equal(transport.buildCreativeResultForward({ jobId: JOB_ID, completion: COMPLETION, callbackUrl: 'https://evil.test/' }), null);
  assert.equal(transport.buildCreativeResultForward({ jobId: JOB_ID, completion: { ...COMPLETION, result: { script: 'x'.repeat(512 * 1024) } } }), null);

  const failed = {
    attemptToken: COMPLETION.attemptToken,
    inputHash: COMPLETION.inputHash,
    status: 'FAILED',
    metadata: COMPLETION.metadata,
    errorCode: 'EXECUTION_FAILED',
  };
  assert.deepEqual(transport.buildCreativeResultForward({ jobId: JOB_ID, completion: failed }).body, failed);
});

test('queued recovery dispatches only the at-most-20 IDs returned by Core', () => {
  assert.equal(typeof transport.buildCreativeQueuedDispatches, 'function');
  const jobs = Array.from({ length: 20 }, (_, index) => ({
    id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
  }));
  const requests = transport.buildCreativeQueuedDispatches({ ok: true, data: { jobs } });

  assert.equal(requests.length, 20);
  assert.deepEqual(requests.map(({ body }) => body.jobId), jobs.map(({ id }) => id));
  assert.equal(transport.buildCreativeQueuedDispatches({ ok: true, data: { jobs: [...jobs, jobs[0]] } }).length, 0);
  assert.equal(transport.buildCreativeQueuedDispatches({ ok: true, data: { jobs: [{ id: '../jobs' }] } }).length, 0);
});
