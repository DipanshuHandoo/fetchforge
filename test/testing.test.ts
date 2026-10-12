import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createClient, isAbortError, isNetworkError, isFetchForgeError } from '../src/index.ts';
import { mockFetch } from '../src/testing.ts';
import { json, startServer } from './helpers.ts';

test('mockFetch matches path params, query, methods and absolute URLs', async () => {
  const mock = mockFetch({ baseUrl: 'https://api.test' })
    .get('/users/:id', ({ params, call }) => ({ json: { id: params.id, call } }))
    .get('/search?q=a', { json: 'a' })
    .post('/users', ({ json: body }) => ({ status: 201, json: body }))
    .get('https://other.test/x', { text: 'other' })
    .any(/\/anything$/, { status: 204 });
  const client = createClient({ baseUrl: 'https://api.test', fetch: mock });

  assert.deepEqual((await client.get('/users/42')).data, { id: '42', call: 1 });
  assert.deepEqual((await client.get('/users/7')).data, { id: '7', call: 2 });
  assert.equal((await client.get('/search', { params: { q: 'a', page: 2 } })).data, 'a');
  const created = await client.post('/users', { name: 'Ada' });
  assert.equal(created.status, 201);
  assert.deepEqual(created.data, { name: 'Ada' });
  assert.equal((await client.get('https://other.test/x')).data, 'other');
  assert.equal((await client.delete('/anything')).status, 204);

  assert.equal(mock.calls.length, 6);
  assert.equal(mock.calls[3]?.body, '{"name":"Ada"}');
  assert.equal(mock.calls[3]?.headers['content-type'], 'application/json');
  assert.equal(mock.calls[0]?.route, 0);
});

test('mockFetch sequences, times, pending, reset and Response replies', async () => {
  const mock = mockFetch()
    .get('/seq', [{ status: 503 }, { json: 'ok' }])
    .get('/once', { json: 1 }, { times: 1 })
    .get('/once', new Response('fallback', { headers: { 'content-type': 'text/plain' } }));
  const client = createClient({ baseUrl: 'https://api.test', fetch: mock, retry: { retries: 1, delay: 1 } });

  assert.deepEqual(mock.pending(), [{ method: 'GET', pattern: '/once' }]);
  assert.equal((await client.get('/seq')).data, 'ok');
  assert.equal((await client.get('/seq')).data, 'ok', 'the last reply repeats');
  assert.equal((await client.get('/once')).data, 1);
  assert.deepEqual(mock.pending(), []);
  assert.equal((await client.get('/once')).data, 'fallback');
  assert.equal((await client.get('/once')).data, 'fallback', 'Response replies are cloned per call');

  mock.reset();
  assert.equal(mock.calls.length, 0);
  await assert.rejects(client.get('/seq'), (error: unknown) => {
    assert.ok(isFetchForgeError(error));
    assert.match(String((error as Error).cause), /no route for GET https:\/\/api.test\/seq/);
    return true;
  });
});

test('mockFetch simulates network errors, custom errors, delays and aborts', async () => {
  const boom = new Error('boom');
  const mock = mockFetch()
    .get('/down', { error: 'network' })
    .get('/boom', { error: boom })
    .get('/slow', { delay: 200, json: 'late' })
    .get('/fn', () => ({ delay: 1, json: 'fn' }));
  const client = createClient({ baseUrl: 'https://api.test', fetch: mock });

  await assert.rejects(client.get('/down'), (error) => isNetworkError(error));
  await assert.rejects(client.get('/boom'), (error: unknown) => (error as Error).cause === boom);
  assert.equal((await client.get('/fn')).data, 'fn');

  const controller = new AbortController();
  const pending = client.get('/slow', { signal: controller.signal });
  setTimeout(() => controller.abort(), 5);
  await assert.rejects(pending, (error) => isAbortError(error));
  await assert.rejects(client.get('/slow', { timeout: 10 }), /timed out/);
});

test('mockFetch passthrough sends unmatched requests to the real fetch; validation errors', async () => {
  const server = await startServer((_req, res) => json(res, 200, { real: true }));
  try {
    const mock = mockFetch({ onUnmatched: 'passthrough' }).get('/mocked', { json: { real: false } });
    const client = createClient({ baseUrl: server.url, fetch: mock });
    assert.deepEqual((await client.get('/mocked')).data, { real: false });
    assert.deepEqual((await client.get('/other')).data, { real: true });
    assert.equal(mock.calls[1]?.route, -1);
  } finally {
    await server.close();
  }
  assert.throws(() => mockFetch().get('/x', []), /at least one reply/);
  assert.throws(() => mockFetch().get('/x', {}, { times: 0 }), /times must be/);
  const predicate = mockFetch().on('*', (url, method) => url.pathname === '/p' && method === 'PUT', {
    status: 202,
  });
  assert.equal((await predicate('https://a.test/p', { method: 'PUT' })).status, 202);
  await assert.rejects(predicate('https://a.test/p'), /no route/);
});
