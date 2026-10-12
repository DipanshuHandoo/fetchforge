import assert from 'node:assert/strict';
import { createClient, isCircuitOpenError } from '@dipanshuhandoo/fetchforge';
import { json, startServer } from './_server.mjs';

// Retries with a growing delay, hooks, and metrics.
const flaky = await startServer((_req, res, count) =>
  count < 3 ? json(res, 503, { error: 'busy' }) : json(res, 200, { ok: true }),
);
// Always failing upstream, protected by a circuit breaker.
const down = await startServer((_req, res) => json(res, 500, { error: 'down' }));

try {
  const delays = [];
  const client = createClient({
    retry: { retries: 3, delay: 10, backoff: 'linear', jitter: 0 },
    hooks: { beforeRetry: ({ delay, attempt }) => void delays.push({ attempt, delay }) },
  });
  const result = await client.get(`${flaky.url}/data`);
  assert.equal(result.data.ok, true);
  assert.equal(result.attempts, 3);
  assert.deepEqual(
    delays.map((d) => d.delay),
    [10, 20],
  );
  assert.equal(client.getMetrics().retries, 2);

  const guarded = createClient({ circuitBreaker: { failureThreshold: 2, resetTimeout: 60_000 } });
  for (let i = 0; i < 2; i++) await guarded.get(`${down.url}/x`).catch(() => undefined);
  const before = down.count;
  const error = await guarded.get(`${down.url}/x`).catch((e) => e);
  assert.ok(isCircuitOpenError(error), 'circuit should be open');
  assert.equal(down.count, before, 'no request reaches the failing service while open');
  console.log('resilience example passed');
} finally {
  await flaky.close();
  await down.close();
}
