// Timeouts: the per-attempt limit versus the total deadline across retries, and the TimeoutError scope.
// Docs: docs/timeouts.md
import assert from 'node:assert/strict';
import { createClient, isTimeoutError } from '@dipanshuhandoo/fetchforge';
import { json, startServer } from './_server.mjs';

const api = await startServer((_req, res) => setTimeout(() => json(res, 200, { slow: true }), 300));

try {
  // Per-attempt timeout
  const client = createClient({ baseUrl: api.url, timeout: 50 });
  const error = await client.get('/slow').catch((e) => e);
  assert.ok(isTimeoutError(error));
  assert.equal(error.scope, 'attempt');

  // Per-request override
  const ok = await client.get('/slow', { timeout: 2000 });
  assert.equal(ok.data.slow, true);

  // Total timeout spans every attempt and the waits between them
  const total = await client
    .get('/slow', { retry: { retries: 5, delay: 20, jitter: 0 }, totalTimeout: 150 })
    .catch((e) => e);
  assert.ok(isTimeoutError(total));
  assert.equal(total.scope, 'total');
  console.log('timeouts example passed');
} finally {
  await api.close();
}
