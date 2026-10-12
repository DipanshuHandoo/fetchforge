// Testing with mockFetch: unit-test code that uses fetchforge without a server or network. Routes with
// params, sequences of replies (fail then succeed), network errors, delays, call inspection and
// "all expected calls were made" checks. Runs with node:test here; works the same with Vitest or Jest.
// Docs: docs/testing.md
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cache, createClient, isNetworkError } from '@dipanshuhandoo/fetchforge';
import { mockFetch } from '@dipanshuhandoo/fetchforge/testing';

// Code under test: it takes a client, so tests can inject one backed by mockFetch.
async function loadDashboard(client, userId) {
  const [user, orders] = await Promise.all([
    client.get(`/users/${userId}`),
    client.get('/orders', { params: { user: userId } }),
  ]);
  return { name: user.data.name, orderCount: orders.data.length };
}

test('loads the dashboard', async () => {
  const fetch = mockFetch({ baseUrl: 'https://api.test' })
    .get('/users/:id', ({ params }) => ({ json: { id: params.id, name: 'Ada' } }))
    .get('/orders', ({ url }) => ({ json: new URL(url).searchParams.get('user') === '7' ? [{}, {}] : [] }));
  const client = createClient({ baseUrl: 'https://api.test', fetch });

  assert.deepEqual(await loadDashboard(client, '7'), { name: 'Ada', orderCount: 2 });
  assert.deepEqual(
    fetch.calls.map((c) => `${c.method} ${new URL(c.url).pathname}`),
    ['GET /users/7', 'GET /orders'],
  );
});

test('retries a flaky endpoint: replies are served in order', async () => {
  const fetch = mockFetch().post('https://api.test/jobs', [
    { status: 503 },
    { error: 'network' },
    { status: 201, json: { id: 'job_1' } },
  ]);
  const client = createClient({ fetch, retry: { retries: 3, delay: 1, methods: ['POST'] } });
  const result = await client.post('https://api.test/jobs', { kind: 'export' });
  assert.equal(result.status, 201);
  assert.equal(fetch.calls.length, 3);
  assert.deepEqual(JSON.parse(fetch.calls[0].body), { kind: 'export' });
});

test('surfaces network errors', async () => {
  const fetch = mockFetch().get('https://api.test/down', { error: 'network' });
  const client = createClient({ fetch, retry: false });
  assert.ok(isNetworkError(await client.get('https://api.test/down').catch((e) => e)));
});

test('timeouts: a delayed reply is aborted by the client', async () => {
  const fetch = mockFetch().get('https://api.test/slow', { delay: 1000, json: {} });
  const client = createClient({ fetch, retry: false, timeout: 20 });
  await assert.rejects(client.get('https://api.test/slow'), { name: 'TimeoutError' });
});

test('plugins are testable too: the cache answers the second call', async () => {
  const fetch = mockFetch().get('https://api.test/config', { json: { theme: 'dark' } }, { times: 1 });
  const client = createClient({ fetch, plugins: [cache()] });
  await client.get('https://api.test/config');
  assert.equal((await client.get('https://api.test/config')).cache, 'hit');
  assert.deepEqual(fetch.pending(), [], 'every expected call was made');
});

test('unmatched requests fail loudly', async () => {
  const fetch = mockFetch();
  const client = createClient({ fetch, retry: false });
  await assert.rejects(client.get('https://api.test/unknown'), /No mock route|unmatched|GET/i);
});
