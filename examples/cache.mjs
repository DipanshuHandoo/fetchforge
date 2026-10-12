// Response cache: TTL, stale-while-revalidate, ETag revalidation (304), stale-if-error, Cache-Control,
// per-request overrides, tags, automatic invalidation after mutations, events and stats.
// Docs: docs/cache.md
import assert from 'node:assert/strict';
import { cache, createClient } from '@dipanshuhandoo/fetchforge';
import { json, startServer } from './_server.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const hits = new Map();
let pricesVersion = 1;
let todos = [{ id: 1, title: 'write docs' }];
let healthy = true;

const api = await startServer((req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  hits.set(path, (hits.get(path) ?? 0) + 1);
  if (path === '/products') return json(res, 200, { version: hits.get(path) });
  if (path === '/news') return json(res, 200, { edition: hits.get(path) });
  if (path === '/config') {
    // The server decides freshness: 1 hour, so no TTL option is needed.
    return json(res, 200, { theme: 'dark' }, { 'cache-control': 'max-age=3600' });
  }
  if (path === '/prices') {
    // `no-cache` = "store it, but check with me first". The ETag makes that check a cheap 304.
    const etag = `"v${pricesVersion}"`;
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { etag, 'cache-control': 'no-cache' });
      return res.end();
    }
    return json(res, 200, { version: pricesVersion }, { etag, 'cache-control': 'no-cache' });
  }
  if (path === '/rates') {
    if (!healthy) return json(res, 503, { error: 'maintenance' });
    return json(res, 200, { usd: 1 });
  }
  if (path === '/me') return json(res, 200, { name: 'Ada' }, { 'cache-control': 'private, no-store' });
  if (path === '/todos' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      todos = [...todos, { id: todos.length + 1, ...JSON.parse(body) }];
      json(res, 201, todos.at(-1));
    });
    return;
  }
  if (path === '/todos') return json(res, 200, todos);
  json(res, 404, { error: 'not found' });
});

const events = [];
const responses = cache({
  ttl: 100,
  staleWhileRevalidate: 60000,
  onEvent: (event) => events.push(event.type),
});
const client = createClient({ baseUrl: api.url, retry: false, plugins: [responses] });

try {
  // 1. TTL: the second call is served from memory without touching the network.
  const first = await client.get('/products');
  const second = await client.get('/products');
  assert.equal(first.cache, 'miss');
  assert.equal(second.cache, 'hit');
  assert.equal(hits.get('/products'), 1);

  // 2. Stale-while-revalidate: once the TTL passes, the old copy is returned instantly and refreshed in the
  //    background. The next caller gets the fresh copy. Users never wait for the slow path.
  await client.get('/news');
  await sleep(150);
  const stale = await client.get('/news');
  assert.equal(stale.cache, 'stale');
  assert.equal(stale.data.edition, 1);
  await responses.whenIdle();
  const fresh = await client.get('/news');
  assert.equal(fresh.cache, 'hit');
  assert.equal(fresh.data.edition, 2);

  // 3. Server headers win: max-age=3600 keeps /config for an hour despite `ttl: 100`.
  await client.get('/config');
  await sleep(150);
  assert.equal((await client.get('/config')).cache, 'hit');

  // 4. ETag revalidation: each read asks "still v1?" and gets an empty 304; data comes from the cache.
  await client.get('/prices');
  const revalidated = await client.get('/prices');
  assert.equal(revalidated.cache, 'revalidated');
  assert.equal(revalidated.status, 200);
  assert.deepEqual(revalidated.data, { version: 1 });
  pricesVersion = 2;
  assert.deepEqual((await client.get('/prices')).data, { version: 2 });

  // 5. Stale-if-error: during an outage, a recent copy beats an error page.
  const resilient = cache({ ttl: 50, staleIfError: 60000 });
  const rates = createClient({ baseUrl: api.url, retry: false, plugins: [resilient] });
  await rates.get('/rates');
  await sleep(80);
  healthy = false;
  const fallback = await rates.get('/rates');
  assert.equal(fallback.cache, 'stale');
  assert.deepEqual(fallback.data, { usd: 1 });
  healthy = true;

  // 6. Never cached: `private`/`no-store` responses, and anything you opt out of per request.
  await client.get('/me');
  await client.get('/me');
  assert.equal(hits.get('/me'), 2);
  await client.get('/products', { meta: { cache: false } });
  const reloaded = await client.get('/products', { meta: { cache: { force: 'reload' } } });
  assert.equal(reloaded.cache, 'miss');
  assert.equal(hits.get('/products'), 3);

  // 7. Mutations invalidate: POST /todos clears the cached GET /todos, so the list is never out of date.
  await client.get('/todos', { meta: { cache: { tags: ['todos'], ttl: 60000 } } });
  assert.equal((await client.get('/todos')).cache, 'hit');
  await client.post('/todos', { title: 'ship 1.2.0' });
  const list = await client.get('/todos', { meta: { cache: { tags: ['todos'] } } });
  assert.equal(list.cache, 'miss');
  assert.equal(list.data.length, 2);

  // 8. Manual invalidation by tag, URL or pattern (e.g. from a webhook or a websocket message).
  //    Tags are attached when an entry is stored, so pass them on the request that fills the cache.
  await responses.invalidateTag('todos');
  assert.equal((await client.get('/todos')).cache, 'miss');
  assert.equal(await responses.invalidate(/\/products/), 1);

  console.log('stats', responses.stats());
  console.log('events', [...new Set(events)].join(', '));
  assert.ok(responses.stats().hits >= 3);
  console.log('cache example passed');
} finally {
  await responses.whenIdle();
  await api.close();
}
