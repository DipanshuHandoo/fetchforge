// A complete tour: one client configured with every feature, used against a flaky local API.
import assert from 'node:assert/strict';
import { bearerAuth, createClient, isHttpError } from '@dipanshuhandoo/fetchforge';
import { json, startServer } from './_server.mjs';

const hits = new Map();
const api = await startServer(async (req, res) => {
  const path = req.url?.split('?')[0] ?? '/';
  const n = (hits.get(path) ?? 0) + 1;
  hits.set(path, n);
  if (path === '/flaky' && n < 3) return json(res, 503, { error: 'try later' });
  if (path === '/missing') return json(res, 404, { error: 'nope' });
  await new Promise((r) => setTimeout(r, 10));
  json(res, 200, { path, n, auth: req.headers.authorization ?? null });
});

try {
  const events = [];
  const api_ = createClient({
    baseUrl: api.url,
    headers: { accept: 'application/json' },
    timeout: 2000, // per attempt
    totalTimeout: 10000, // across all attempts
    retry: { retries: 3, delay: 20, backoff: 'linear', jitter: 0 },
    circuitBreaker: { failureThreshold: 5, resetTimeout: 5000 },
    dedupe: true,
    hedging: false,
    messages: { http: ({ status, url }) => `API said ${status} for ${url}` },
    hooks: {
      beforeRequest: (req) => void events.push(`-> ${req.method} ${req.url} (attempt ${req.attempt})`),
      beforeRetry: ({ delay }) => void events.push(`   retry in ${delay}ms`),
      onComplete: ({ attempts, durationMs }) =>
        void events.push(`<- done in ${attempts} attempt(s), ${durationMs}ms`),
    },
    plugins: [bearerAuth(() => 'demo-token')],
    middleware: async (_ctx, next) => next(),
    meta: { service: 'orders' },
  });

  // Single call with retries
  const flaky = await api_.get('/flaky');
  assert.equal(flaky.attempts, 3);

  // Duplicate concurrent calls are collapsed
  await Promise.all([api_.get('/same'), api_.get('/same')]);
  assert.equal(hits.get('/same'), 1);

  // HEAD
  assert.equal((await api_.head('/same')).status, 200);

  // Typed error with a custom message
  const error = await api_.get('/missing').catch((e) => e);
  assert.ok(isHttpError(error));
  console.log(error.message);

  // Bulk
  const bulk = await api_.bulk(['/a', '/b', '/missing', { url: '/c', params: { x: 1 } }], { concurrency: 2 });
  assert.equal(bulk.fulfilled, 3);
  assert.equal(bulk.rejected, 1);

  console.log(events.slice(0, 6).join('\n'));
  console.log('metrics:', JSON.stringify(api_.getMetrics().statusCodes));
  console.log('full-tour example passed');
} finally {
  await api.close();
}
