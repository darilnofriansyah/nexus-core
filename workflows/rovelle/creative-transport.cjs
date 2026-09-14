'use strict';

const JOB_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_QUEUED_JOBS = 20;
const MAX_RESULT_BODY_BYTES = 512 * 1024;

function buildCreativeDispatch(response) {
  const envelope = successfulCoreEnvelope(response);
  if (
    !envelope ||
    !isRecord(envelope.data.creativeJob) ||
    !hasExactKeys(envelope.data.creativeJob, ['id', 'action']) ||
    envelope.data.creativeJob.action !== 'DISPATCH' ||
    !isJobId(envelope.data.creativeJob.id)
  ) {
    return null;
  }
  return workerDispatch(envelope.data.creativeJob.id);
}

function buildCreativeClaimForward(body) {
  if (
    !isRecord(body) ||
    !hasExactKeys(body, ['jobId']) ||
    !isJobId(body.jobId)
  ) {
    return null;
  }
  return coreRequest(`/rovelle/creative-jobs/${body.jobId}/claim`, {}, 1024);
}

function buildCreativeResultForward(body) {
  if (
    !isRecord(body) ||
    !hasExactKeys(body, ['jobId', 'completion']) ||
    !isJobId(body.jobId) ||
    !isRecord(body.completion) ||
    !validCompletionShape(body.completion)
  ) {
    return null;
  }
  const completionBytes = Buffer.byteLength(JSON.stringify(body.completion));
  if (completionBytes > MAX_RESULT_BODY_BYTES) return null;
  return coreRequest(
    `/rovelle/creative-jobs/${body.jobId}/result`,
    body.completion,
    MAX_RESULT_BODY_BYTES,
  );
}

function buildCreativeQueuedDispatches(response) {
  const envelope = successfulCoreEnvelope(response);
  if (
    !envelope ||
    !Array.isArray(envelope.data.jobs) ||
    envelope.data.jobs.length > MAX_QUEUED_JOBS ||
    envelope.data.jobs.some(
      (job) => !isRecord(job) || !hasExactKeys(job, ['id']) || !isJobId(job.id),
    )
  ) {
    return [];
  }
  return envelope.data.jobs.map(({ id }) => workerDispatch(id));
}

function successfulCoreEnvelope(response) {
  if (!isRecord(response)) return null;
  if (response.statusCode !== undefined) {
    const status = Number(response.statusCode);
    if (!Number.isInteger(status) || status < 200 || status >= 300) return null;
  }
  const envelope = isRecord(response.body) ? response.body : response;
  return isRecord(envelope) && envelope.ok === true && isRecord(envelope.data)
    ? envelope
    : null;
}

function workerDispatch(jobId) {
  return {
    method: 'POST',
    path: '/jobs',
    body: { jobId },
    credentialRef: 'CODEX_WORKER_DISPATCH_KEY',
    credentialHeader: 'x-codex-dispatch-key',
    timeoutMs: 10_000,
    followRedirects: false,
    maxBodyBytes: 1024,
  };
}

function coreRequest(path, body, maxBodyBytes) {
  return {
    method: 'POST',
    path,
    body,
    credentialRef: 'ROVELLE_CREATIVE_WORKER_KEY',
    credentialHeader: 'x-rovelle-worker-key',
    timeoutMs: 10_000,
    followRedirects: false,
    maxBodyBytes,
  };
}

function validCompletionShape(completion) {
  const keys = completion.status === 'COMPLETED'
    ? ['attemptToken', 'inputHash', 'status', 'metadata', 'result']
    : completion.status === 'FAILED'
      ? ['attemptToken', 'inputHash', 'status', 'metadata', 'errorCode']
      : [];
  return keys.length > 0 &&
    hasExactKeys(completion, keys) &&
    typeof completion.attemptToken === 'string' &&
    /^[A-Za-z0-9_-]{43}$/.test(completion.attemptToken) &&
    typeof completion.inputHash === 'string' &&
    /^[a-f0-9]{64}$/.test(completion.inputHash) &&
    isRecord(completion.metadata) &&
    (completion.status === 'FAILED'
      ? ['AUTH_FAILED', 'INVALID_OUTPUT', 'EXECUTION_FAILED'].includes(completion.errorCode)
      : isRecord(completion.result));
}

function isJobId(value) {
  return typeof value === 'string' && JOB_ID_PATTERN.test(value);
}

function hasExactKeys(value, keys) {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => actual.includes(key));
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

module.exports = {
  buildCreativeDispatch,
  buildCreativeClaimForward,
  buildCreativeResultForward,
  buildCreativeQueuedDispatches,
};
