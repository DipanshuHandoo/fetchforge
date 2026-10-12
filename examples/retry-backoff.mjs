// Retry and backoff: fixed, linear, exponential and custom delays, idempotency rules, and shouldRetry.
// Docs: docs/retries.md
import assert from 'node:assert/strict';
import { createClient } from '@dipanshuhandoo/fetchforge';
import { json, startServer } from './_server.mjs';

const api = await startServer((_req, res, count) =>
  count % 4 === 0 ? json(res, 200, { ok: true }) : json(res, 503, { error: 'busy' }, { 'retry-after': '0' }),
);

async function delaysFor(retry) {
  const delays = [];
  const client = createClient({
    retry,
    hooks: { beforeRetry: ({ delay }) => void delays.push(delay) },
  });
  const result = await client.get(`${api.url}/x`);
  assert.equal(result.attempts, 4);
  return delays;
}

try {
  // Real values would be 5000 ms; scaled down 100x so the example runs fast.
  // Fixed: the same wait every time (5s, 5s, 5s).
  assert.deepEqual(
    await delaysFor({ retries: 3, delay: 50, backoff: 'fixed', jitter: 0, respectRetryAfter: false }),
    [50, 50, 50],
  );
  // Linear: 5s, 10s, 15s.
  assert.deepEqual(
    await delaysFor({ retries: 3, delay: 50, backoff: 'linear', jitter: 0, respectRetryAfter: false }),
    [50, 100, 150],
  );
  // Exponential: 1x, 2x, 4x (capped by maxDelay).
  assert.deepEqual(
    await delaysFor({
      retries: 3,
      delay: 50,
      backoff: 'exponential',
      factor: 2,
      jitter: 0,
      respectRetryAfter: false,
    }),
    [50, 100, 200],
  );
  // Custom function: receives the retry number (1-based).
  assert.deepEqual(
    await delaysFor({ retries: 3, backoff: (n) => n * 7, jitter: 0, respectRetryAfter: false }),
    [7, 14, 21],
  );

  // POST is not retried unless you opt in.
  const post = createClient({ retry: { retries: 2, delay: 1 } });
  const before = api.count;
  await post.post(`${api.url}/x`, undefined, { json: {} }).catch(() => undefined);
  assert.equal(api.count - before, 1, 'POST attempted once');

  // shouldRetry gets the final say on method, status and error rules.
  const custom = createClient({ retry: { retries: 1, delay: 1, shouldRetry: ({ retryable }) => retryable } });
  await custom.get(`${api.url}/x`).catch(() => undefined);
  console.log('retry-backoff example passed');
} finally {
  await api.close();
}
