// Dedupe and hedging: share identical in-flight calls, and race a duplicate request to cut tail latency.
// Docs: docs/dedupe-and-hedging.md
import assert from 'node:assert/strict';
import { createClient } from '@dipanshuhandoo/fetchforge';
import { json, startServer } from './_server.mjs';

let slowNext = false;
const api = await startServer(async (_req, res, count) => {
  const slow = slowNext;
  slowNext = false; // only the first request after arming is slow
  await new Promise((r) => setTimeout(r, slow ? 400 : 5));
  json(res, 200, { served: count });
});

try {
  // Deduplication: identical concurrent GETs share one network call.
  const dedupe = createClient({ dedupe: true });
  const [a, b, c] = await Promise.all([1, 2, 3].map(() => dedupe.get(`${api.url}/same`)));
  assert.equal(api.count, 1);
  assert.equal(a.data.served, b.data.served);
  assert.equal(c.data.served, 1);
  assert.equal(dedupe.getMetrics().deduped, 2);

  // Custom key: ignore a volatile query param.
  const keyed = createClient({
    dedupe: { key: (req) => `${req.method} ${new URL(req.url).pathname}` },
  });
  const before = api.count;
  await Promise.all([keyed.get(`${api.url}/k?ts=1`), keyed.get(`${api.url}/k?ts=2`)]);
  assert.equal(api.count - before, 1);

  // Hedging: if no answer after 50 ms, send a duplicate; first success wins.
  const hedged = createClient({ hedging: { delay: 50, maxHedges: 1 } });
  slowNext = true;
  const started = Date.now();
  const result = await hedged.get(`${api.url}/h`);
  const elapsed = Date.now() - started;
  assert.ok(result.ok);
  assert.ok(elapsed < 300, `hedge answered before the slow request (${elapsed}ms)`);
  assert.equal(hedged.getMetrics().hedges, 1);
  console.log(`dedupe-hedging example passed; hedged call took ${elapsed}ms`);
} finally {
  await api.close();
}
