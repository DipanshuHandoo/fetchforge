// Client-side rate limiting: a token bucket per API host keeps you under a provider's quota instead of
// collecting 429s. Bursts are queued and released smoothly; Retry-After / X-RateLimit headers pause the bucket.
// Docs: docs/rate-limiting.md
import assert from 'node:assert/strict';
import { createClient, isRateLimitError, rateLimit } from '@dipanshuhandoo/fetchforge';
import { json, startServer } from './_server.mjs';

const arrivals = [];
let throttleNext = false;
const api = await startServer((req, res) => {
  arrivals.push(Date.now());
  if (throttleNext) {
    throttleNext = false;
    return json(res, 429, { error: 'slow down' }, { 'retry-after': '1' });
  }
  json(res, 200, { path: req.url });
});

const delays = [];
// 5 requests per 200 ms (25/s), e.g. a third-party API with a strict per-second quota.
const limiter = rateLimit({
  limit: 5,
  interval: 200,
  maxPause: 300,
  onDelay: ({ waitMs, queued }) => delays.push({ waitMs, queued }),
});
const client = createClient({ baseUrl: api.url, retry: false, plugins: [limiter] });

try {
  // 1. A burst of 15: 5 go immediately, the rest are spread over the next ~400 ms. Nothing is rejected.
  const started = Date.now();
  const results = await Promise.all(Array.from({ length: 15 }, (_, i) => client.get(`/items/${i}`)));
  const elapsed = Date.now() - started;
  assert.ok(results.every((r) => r.status === 200));
  assert.ok(elapsed >= 350, `the burst was smoothed (${elapsed} ms)`);
  assert.equal(delays.length, 10);
  console.log(`15 requests in ${elapsed} ms, ${delays.length} waited`);

  // 2. The server says 429 + Retry-After: the bucket pauses (capped by maxPause) so the next calls don't pile in.
  throttleNext = true;
  await client.get('/limited', { throwHttpErrors: false });
  const [host] = Object.keys(limiter.state());
  assert.ok(limiter.state()[host].pausedUntil > Date.now());
  const pausedAt = Date.now();
  await client.get('/after-pause');
  assert.ok(Date.now() - pausedAt >= 250, 'waited for the server-requested pause');

  // 3. Fail fast instead of waiting too long (e.g. an interactive request with a tight budget).
  const strict = rateLimit({ limit: 1, interval: 1000, maxWait: 100 });
  const interactive = createClient({ baseUrl: api.url, plugins: [strict] });
  await interactive.get('/first');
  const rejected = await interactive.get('/second').catch((error) => error);
  assert.ok(isRateLimitError(rejected));
  console.log(`rejected with retryAfter=${rejected.retryAfter} ms`);

  console.log('rate limit example passed');
} finally {
  limiter.stop();
  await api.close();
}
