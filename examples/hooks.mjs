// Hooks: every lifecycle hook (before/after request, retry, error, success, complete) and error isolation.
// Docs: docs/hooks.md
import assert from 'node:assert/strict';
import { createClient } from '@dipanshuhandoo/fetchforge';
import { json, startServer } from './_server.mjs';

const api = await startServer((req, res, count) =>
  count === 1 ? json(res, 500, { error: 'first fails' }) : json(res, 200, { trace: req.headers['x-trace'] }),
);

try {
  const log = [];
  const client = createClient({
    retry: { retries: 1, delay: 1, jitter: 0 },
    hooks: {
      // before the fetch call (runs on every attempt)
      beforeRequest: (req) => {
        req.headers.set('x-trace', `attempt-${req.attempt}`);
        log.push('beforeRequest');
      },
      beforeRetry: ({ attempt, delay }) => void log.push(`beforeRetry#${attempt}(${delay}ms)`),
      // after the fetch call; may return a replacement Response
      afterResponse: (response) => void log.push(`afterResponse ${response.status}`),
      // on failure only / success only / always (like finally)
      onSuccess: (result) => void log.push(`onSuccess ${result.status}`),
      onError: () => void log.push('onError'),
      onComplete: ({ attempts }) => void log.push(`onComplete after ${attempts} attempts`),
      // observer hook failures never break the request
      onHookError: (_error, name) => void log.push(`hookError in ${name}`),
    },
  });

  const result = await client.get(`${api.url}/x`, {
    // Hooks passed per request are appended to the client's hooks.
    hooks: { onSuccess: () => void log.push('per-request onSuccess') },
  });
  assert.equal(result.attempts, 2);
  assert.equal(result.data.trace, 'attempt-2');
  assert.ok(log.includes('onComplete after 2 attempts'));
  assert.ok(log.includes('per-request onSuccess'));

  // beforeError can replace the final error (e.g. to add context).
  const wrapped = createClient({
    hooks: { beforeError: (error) => Object.assign(error, { message: `[orders] ${error.message}` }) },
  });
  const failing = await startServer((_q, res) => json(res, 404, {}));
  const error = await wrapped.get(`${failing.url}/x`).catch((e) => e);
  assert.match(error.message, /^\[orders\]/);
  await failing.close();

  console.log(log.join('\n'));
  console.log('hooks example passed');
} finally {
  await api.close();
}
