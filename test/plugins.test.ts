import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  authRefresh,
  createClient,
  idempotency,
  isAuthError,
  isHttpError,
  isRateLimitError,
  offlineQueue,
  rateLimit,
} from '../src/index.ts';
import { memoryStore } from '../src/stores.ts';
import { mockFetch } from '../src/testing.ts';
import { wait } from './helpers.ts';

const BASE = 'https://api.test';

function authServer(valid: () => string) {
  return mockFetch({ baseUrl: BASE }).any('/*', ({ headers }) =>
    headers.get('authorization') === `Bearer ${valid()}`
      ? { json: 'ok' }
      : { status: 401, json: { error: 'expired' } },
  );
}

test('authRefresh: concurrent 401s share one refresh and every request is replayed', async () => {
  let token = 'old';
  let serverToken = 'new';
  let refreshes = 0;
  const mock = authServer(() => serverToken);
  const plugin = authRefresh({
    getToken: () => token,
    refreshToken: async () => {
      refreshes++;
      await wait(10);
      token = 'new';
    },
  });
  const client = createClient({ baseUrl: BASE, fetch: mock, plugins: [plugin] });
  const results = await Promise.all([client.get('/a'), client.get('/b'), client.post('/c', {})]);
  assert.deepEqual(
    results.map((r) => r.data),
    ['ok', 'ok', 'ok'],
  );
  assert.equal(refreshes, 1);
  assert.equal(mock.calls.length, 6);
  assert.equal(mock.calls.at(-1)?.headers.authorization, 'Bearer new');

  // A request that was sent with an outdated token after a refresh replays without refreshing again.
  serverToken = 'newer';
  token = 'newer';
  assert.equal((await client.get('/d')).data, 'ok');
  assert.equal(refreshes, 1);
});

test('authRefresh: refreshToken may return the token; custom header, scheme and status', async () => {
  let stored = 'a';
  const mock = mockFetch({ baseUrl: BASE }).get('/x', ({ headers }) =>
    headers.get('x-api-key') === 'b' ? { json: 'ok' } : { status: 419 },
  );
  const plugin = authRefresh({
    getToken: () => stored,
    refreshToken: () => 'b',
    header: 'x-api-key',
    scheme: '',
    shouldRefresh: ({ status }) => status === 419,
  });
  const client = createClient({ baseUrl: BASE, fetch: mock, plugins: [plugin] });
  assert.equal((await client.get('/x')).data, 'ok');
  assert.equal((await client.get('/x')).data, 'ok', 'the returned token is kept until getToken catches up');
  assert.equal(mock.calls.length, 3);
  stored = 'b';
  assert.equal((await client.get('/x')).data, 'ok');
  await plugin.refresh();
});

test('authRefresh: failed refresh raises AuthError and calls onRefreshFailed; opt-outs', async () => {
  const failures: unknown[] = [];
  const mock = mockFetch({ baseUrl: BASE }).any('/*', { status: 401 });
  const plugin = authRefresh({
    getToken: () => undefined,
    refreshToken: () => null,
    onRefreshFailed: (error) => failures.push(error),
  });
  const client = createClient({ baseUrl: BASE, fetch: mock, plugins: [plugin] });
  await assert.rejects(client.get('/x'), (error) => {
    assert.ok(isAuthError(error));
    assert.equal(error.code, 'ERR_AUTH');
    assert.match(error.message, /refreshToken returned null/);
    return true;
  });
  assert.equal(failures.length, 1);
  assert.equal(mock.calls[0]?.headers.authorization, undefined, 'no token, no header');

  await assert.rejects(
    client.get('/x', { meta: { authRefresh: false } }),
    (error) => isHttpError(error) && error.status === 401,
  );

  const throwing = authRefresh({
    getToken: () => 't',
    refreshToken: () => {
      throw new Error('refresh endpoint down');
    },
    onRefreshFailed: () => {
      throw new Error('observer bug');
    },
  });
  const other = createClient({ baseUrl: BASE, fetch: mock, plugins: [throwing], throwHttpErrors: false });
  await assert.rejects(other.get('/x'), /refresh endpoint down/);

  const noRetry = authRefresh({ getToken: () => 't', refreshToken: () => 'u', maxRefreshAttempts: 0 });
  const third = createClient({ baseUrl: BASE, fetch: mock, plugins: [noRetry], throwHttpErrors: false });
  assert.equal((await third.get('/x')).status, 401);
  assert.throws(() => authRefresh({} as never), /requires getToken/);
  assert.throws(
    () => authRefresh({ getToken: () => '', refreshToken: () => '', maxRefreshAttempts: -1 }),
    /integer/,
  );
});

test('authRefresh: onRefreshFailed runs once for a shared failed refresh', async () => {
  let callbacks = 0;
  let refreshes = 0;
  const mock = mockFetch({ baseUrl: BASE }).get('/a', { status: 401 }).get('/b', { status: 401 });
  const plugin = authRefresh({
    getToken: () => 'expired',
    refreshToken: async () => {
      refreshes++;
      await wait(10);
      throw new Error('refresh down');
    },
    onRefreshFailed: () => callbacks++,
  });
  const client = createClient({ baseUrl: BASE, fetch: mock, plugins: [plugin] });
  const outcomes = await Promise.allSettled([client.get('/a'), client.get('/b')]);
  assert.equal(outcomes.filter((outcome) => outcome.status === 'rejected').length, 2);
  assert.equal(refreshes, 1);
  assert.equal(callbacks, 1);
});

test('rateLimit: bursts up to the limit, then queues FIFO at the refill rate', async () => {
  const mock = mockFetch({ baseUrl: BASE }).get('/n/:i', ({ params }) => ({ json: Number(params.i) }));
  const delays: number[] = [];
  const plugin = rateLimit({ limit: 2, interval: 100, onDelay: ({ waitMs }) => delays.push(waitMs) });
  const client = createClient({ baseUrl: BASE, fetch: mock, plugins: [plugin] });
  const started = Date.now();
  const results = await Promise.all([1, 2, 3, 4].map((i) => client.get(`/n/${i}`)));
  const elapsed = Date.now() - started;
  assert.deepEqual(
    results.map((r) => r.data),
    [1, 2, 3, 4],
  );
  assert.deepEqual(
    mock.calls.map((c) => c.url.slice(-1)),
    ['1', '2', '3', '4'],
    'FIFO order',
  );
  assert.ok(elapsed >= 90, `two requests had to wait for refill (took ${elapsed}ms)`);
  // Waits are computed from the clock, so a busy machine may shave a few ms off.
  assert.equal(delays.length, 2);
  const [first = 0, second = 0] = delays;
  assert.ok(first >= 0 && first <= 50, `first wait ${first}`);
  assert.ok(second >= 0 && second <= 100, `second wait ${second}`);
  assert.equal(plugin.state()[BASE]?.queued, 0);
});

test('rateLimit: separate buckets per origin or custom key', async () => {
  const mock = mockFetch().any('*', { status: 204 });
  const plugin = rateLimit({ limit: 1, interval: 1000, maxWait: 0 });
  const client = createClient({ fetch: mock, plugins: [plugin] });
  await client.get('https://a.test/x');
  await client.get('https://b.test/x');
  await assert.rejects(client.get('https://a.test/y'), (error) => {
    assert.ok(isRateLimitError(error));
    assert.equal(error.key, 'https://a.test');
    assert.ok(error.retryAfter > 0);
    return true;
  });
  assert.deepEqual(Object.keys(plugin.state()).sort(), ['https://a.test', 'https://b.test']);

  const byUser = rateLimit({
    limit: 1,
    interval: 1000,
    maxWait: 0,
    key: (request) => String(request.meta.user),
  });
  const keyed = createClient({ fetch: mock, plugins: [byUser] });
  await keyed.get('https://a.test/x', { meta: { user: 1 } });
  await keyed.get('https://a.test/x', { meta: { user: 2 } });
  await assert.rejects(keyed.get('https://a.test/x', { meta: { user: 1 } }), /rate limit/i);
});

test('rateLimit: maxQueue, abort while queued, stop() and validation', async () => {
  const mock = mockFetch().any('*', { status: 204 });
  const plugin = rateLimit({ limit: 1, interval: 10000, maxQueue: 1 });
  const client = createClient({ fetch: mock, plugins: [plugin] });
  await client.get('https://a.test/1');
  const controller = new AbortController();
  const queued = client.get('https://a.test/2', { signal: controller.signal });
  await wait(5);
  await assert.rejects(client.get('https://a.test/3'), /queue is full/);
  controller.abort();
  await assert.rejects(queued, (error: Error) => error.name === 'AbortError' || /abort/i.test(error.message));
  assert.equal(plugin.state()['https://a.test']?.queued, 0);
  assert.equal(mock.calls.length, 1);

  const stopped = client.get('https://a.test/4');
  await wait(5);
  plugin.stop();
  await assert.rejects(stopped, /stopped/);

  assert.throws(() => rateLimit({ limit: 0, interval: 1 }), /limit must be/);
  assert.throws(() => rateLimit({ limit: 1, interval: 0 }), /interval must be/);
});

test('rateLimit: pauses on Retry-After and X-RateLimit headers (capped by maxPause)', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1700000000000 });
  const mock = mockFetch()
    .get('https://a.test/429', { status: 429, headers: { 'retry-after': '2' } })
    .get('https://b.test/x', {
      status: 200,
      headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1700000003' },
    })
    .get('https://c.test/x', {
      status: 200,
      headers: { 'ratelimit-remaining': '0', 'ratelimit-reset': '500' },
    });
  const plugin = rateLimit({ limit: 10, interval: 1000, maxPause: 60000 });
  const client = createClient({
    fetch: mock,
    plugins: [plugin],
    throwHttpErrors: false,
    retry: { retries: 0 },
  });
  await client.get('https://a.test/429');
  await client.get('https://b.test/x');
  await client.get('https://c.test/x');
  const state = plugin.state();
  assert.equal(state['https://a.test']?.pausedUntil, 1700000002000);
  assert.equal(state['https://b.test']?.pausedUntil, 1700000003000, 'epoch-seconds reset');
  assert.equal(state['https://c.test']?.pausedUntil, 1700000060000, 'capped at maxPause');

  const ignoring = rateLimit({ limit: 10, interval: 1000, respectHeaders: false });
  const other = createClient({
    fetch: mock,
    plugins: [ignoring],
    throwHttpErrors: false,
    retry: { retries: 0 },
  });
  await other.get('https://a.test/429');
  assert.equal(ignoring.state()['https://a.test']?.pausedUntil, 0);
});

test('idempotency: one key per call, reused by retries; POST becomes retryable', async () => {
  const mock = mockFetch({ baseUrl: BASE })
    .post('/orders', [{ status: 503 }, { error: 'network' }, { status: 201, json: { id: 1 } }])
    .put('/x', { status: 204 })
    .patch('/x', { status: 204 });
  let n = 0;
  const client = createClient({
    baseUrl: BASE,
    fetch: mock,
    retry: { retries: 2, delay: 1 },
    plugins: [idempotency({ generate: () => `key-${++n}` })],
  });
  const result = await client.post('/orders', { sku: 'A' });
  assert.equal(result.status, 201);
  assert.equal(result.attempts, 3);
  assert.deepEqual(
    mock.calls.map((c) => c.headers['idempotency-key']),
    ['key-1', 'key-1', 'key-1'],
  );

  await client.put('/x');
  assert.equal(mock.calls.at(-1)?.headers['idempotency-key'], undefined, 'PUT is idempotent already');
  await client.patch('/x', null, { meta: { idempotencyKey: 'order-42' } });
  assert.equal(mock.calls.at(-1)?.headers['idempotency-key'], 'order-42');
  await client.patch('/x', null, { meta: { idempotencyKey: false } });
  assert.equal(mock.calls.at(-1)?.headers['idempotency-key'], undefined);
  await client.patch('/x', null, { headers: { 'Idempotency-Key': 'mine' } });
  assert.equal(mock.calls.at(-1)?.headers['idempotency-key'], 'mine');

  const defaults = createClient({ baseUrl: BASE, fetch: mock, plugins: [idempotency()] });
  await defaults.patch('/x');
  assert.match(mock.calls.at(-1)?.headers['idempotency-key'] ?? '', /^[0-9a-f-]{36}$/);
  const bad = createClient({ baseUrl: BASE, fetch: mock, plugins: [idempotency({ generate: () => '' })] });
  await assert.rejects(bad.patch('/x'), /generate must return a string/);
});

test('without idempotency, POST is not retried', async () => {
  const mock = mockFetch({ baseUrl: BASE }).post('/orders', [{ status: 503 }, { status: 201 }]);
  const client = createClient({
    baseUrl: BASE,
    fetch: mock,
    retry: { retries: 2, delay: 1 },
    throwHttpErrors: false,
  });
  assert.equal((await client.post('/orders', {})).status, 503);
  assert.equal(mock.calls.length, 1);
});

test('idempotency: requests queued before sending keep one key across replays', async () => {
  const mock = mockFetch({ baseUrl: BASE }).post('/notes', [{ status: 503 }, { status: 201 }]);
  let online = false;
  const queue = offlineQueue({
    store: memoryStore(),
    isOnline: () => online,
    replayInterval: 0,
    mode: 'resolve',
  });
  const client = createClient({
    baseUrl: BASE,
    fetch: mock,
    retry: false,
    plugins: [idempotency({ generate: () => 'key-1' }), queue],
  });
  await client.post('/notes', { text: 'a' });
  const [item] = await queue.pending();
  assert.equal(item?.headers['idempotency-key'], 'key-1', 'the key is persisted with the queued request');
  online = true;
  assert.deepEqual(await queue.flush(), { sent: 0, dropped: 0, remaining: 1 });
  assert.deepEqual(await queue.flush(), { sent: 1, dropped: 0, remaining: 0 });
  assert.deepEqual(
    mock.calls.map((c) => c.headers['idempotency-key']),
    ['key-1', 'key-1'],
  );
  queue.stop();
});
