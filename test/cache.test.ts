import assert from 'node:assert/strict';
import { type TestContext, test } from 'node:test';
import {
  type CacheEvent,
  type CacheOptions,
  authRefresh,
  bearerAuth,
  cache,
  createClient,
  idempotency,
  isHttpError,
  logger,
  rateLimit,
} from '../src/index.ts';
import type { Store } from '../src/store.ts';
import { memoryStore } from '../src/stores.ts';
import { type MockReply, type MockResponder, mockFetch } from '../src/testing.ts';

const BASE = 'https://api.test';

const timersEnabled = new WeakSet<TestContext>();

function setup(t: TestContext, options: CacheOptions = {}) {
  if (!timersEnabled.has(t)) {
    t.mock.timers.enable({ apis: ['Date'], now: 1000000 });
    timersEnabled.add(t);
  }
  const events: CacheEvent[] = [];
  const plugin = cache({ ...options, onEvent: (event) => events.push(event) });
  const mock = mockFetch({ baseUrl: BASE });
  const client = createClient({ baseUrl: BASE, fetch: mock, plugins: [plugin] });
  const tick = (ms: number) => t.mock.timers.tick(ms);
  return { plugin, mock, client, events, tick };
}

const counter = (headers: Record<string, string> = {}): MockResponder => {
  let n = 0;
  return () => ({ json: { n: ++n }, headers });
};

test('cache: miss, then hits until the TTL expires', async (t) => {
  const { client, mock, plugin, tick } = setup(t, { ttl: 1000 });
  mock.get('/items', counter());

  const first = await client.get('/items');
  assert.equal(first.cache, 'miss');
  assert.deepEqual(first.data, { n: 1 });

  tick(999);
  const second = await client.get('/items');
  assert.equal(second.cache, 'hit');
  assert.deepEqual(second.data, { n: 1 });
  assert.equal(second.status, 200);
  assert.equal(second.attempts, 0);
  assert.equal(second.response.status, 200);
  assert.equal(second.headers['content-type'], 'application/json');
  assert.equal(second.headers.age, '0');

  tick(1);
  const third = await client.get('/items');
  assert.equal(third.cache, 'miss');
  assert.deepEqual(third.data, { n: 2 });
  assert.equal(mock.calls.length, 2);
  assert.deepEqual(plugin.stats(), {
    hits: 1,
    stale: 0,
    revalidated: 0,
    misses: 2,
    stores: 2,
    bypassed: 0,
    storeErrors: 0,
  });
});

test('cache: credential values and auth plugin tokens partition entries without storing secrets in keys', async () => {
  const store = memoryStore();
  const mock = mockFetch({ baseUrl: BASE }).get('/me', ({ headers }) => ({
    json: { owner: headers.get('authorization') },
    headers: { vary: 'Authorization' },
  }));
  const plugin = cache({ store });
  const client = createClient({
    baseUrl: BASE,
    fetch: mock,
    plugins: [plugin],
  });
  const alice = await client.get('/me', { headers: { authorization: 'Bearer alice-secret' } });
  const bob = await client.get('/me', { headers: { authorization: 'Bearer bob-secret' } });
  assert.deepEqual(alice.data, { owner: 'Bearer alice-secret' });
  assert.deepEqual(bob.data, { owner: 'Bearer bob-secret' });
  assert.equal(alice.cache, 'miss');
  assert.equal(bob.cache, 'miss');
  assert.equal((await client.get('/me', { headers: { authorization: 'Bearer alice-secret' } })).cache, 'hit');
  assert.equal(mock.calls.length, 2);
  assert.ok(store.keys().every((key) => !key.includes('alice-secret') && !key.includes('bob-secret')));
  assert.ok(store.keys().every((key) => !key.includes('alice-secret') && !key.includes('bob-secret')));
  assert.ok(
    store.keys().every((key) => {
      const entry = store.get(key) as { vary?: Record<string, string> };
      const values = Object.values(entry.vary ?? {});
      return !values.includes('Bearer alice-secret') && !values.includes('Bearer bob-secret');
    }),
  );
  assert.equal(
    await plugin.invalidate('/me'),
    3,
    'the exact base key and both credential partitions are removed',
  );

  let token = 'alice';
  const authenticatedMock = mockFetch({ baseUrl: BASE }).get('/session', ({ headers }) => ({
    json: { user: headers.get('authorization') },
  }));
  const authenticated = createClient({
    baseUrl: BASE,
    fetch: authenticatedMock,
    plugins: [cache(), authRefresh({ getToken: () => token, refreshToken: () => token })],
  });
  assert.deepEqual((await authenticated.get('/session')).data, { user: 'Bearer alice' });
  token = 'bob';
  const bobSession = await authenticated.get('/session');
  assert.deepEqual(bobSession.data, { user: 'Bearer bob' });
  assert.equal(bobSession.cache, 'miss');
  assert.equal(authenticatedMock.calls.length, 2);

  let bearerToken = 'one';
  const bearerMock = mockFetch({ baseUrl: BASE }).get('/bearer', ({ headers }) => ({
    json: { user: headers.get('authorization') },
  }));
  const bearerClient = createClient({
    baseUrl: BASE,
    fetch: bearerMock,
    plugins: [cache(), bearerAuth(() => bearerToken)],
  });
  await bearerClient.get('/bearer');
  bearerToken = 'two';
  assert.deepEqual((await bearerClient.get('/bearer')).data, { user: 'Bearer two' });
  assert.equal(bearerMock.calls.length, 2);
});

test('cache: built-in rateLimit, logger and idempotency hooks do not disable caching', async () => {
  const mock = mockFetch({ baseUrl: BASE }).get('/items', counter());
  const limiter = rateLimit({ limit: 100, interval: 1000 });
  const client = createClient({
    baseUrl: BASE,
    fetch: mock,
    plugins: [cache(), limiter, logger({ level: 'silent' }), idempotency()],
  });
  try {
    await client.get('/items');
    const second = await client.get('/items');
    assert.equal(second.cache, 'hit');
    assert.equal(mock.calls.length, 1);

    // An unknown hook could add credentials, so it still disables caching.
    const custom = client.extend({ hooks: { beforeRequest: () => {} } });
    assert.equal((await custom.get('/items')).cache, undefined);
    assert.equal(mock.calls.length, 2);
  } finally {
    limiter.stop();
  }
});

test('cache: unpartitioned request hooks bypass caching unless given an explicit cache key', async () => {
  let token = 'alice';
  const mock = mockFetch({ baseUrl: BASE }).get('/custom-auth', ({ headers }) => ({
    json: { user: headers.get('authorization') },
  }));
  const client = createClient({
    baseUrl: BASE,
    fetch: mock,
    plugins: [cache()],
    hooks: { beforeRequest: (request) => request.headers.set('authorization', token) },
  });
  assert.deepEqual((await client.get('/custom-auth')).data, { user: 'alice' });
  token = 'bob';
  const second = await client.get('/custom-auth');
  assert.deepEqual(second.data, { user: 'bob' });
  assert.equal(second.cache, undefined);
  assert.equal(mock.calls.length, 2);

  const partitioned = createClient({
    baseUrl: BASE,
    fetch: mock,
    plugins: [cache({ key: (request) => `${token}:${request.url}` })],
    hooks: { beforeRequest: (request) => request.headers.set('authorization', token) },
  });
  await partitioned.get('/custom-auth');
  token = 'carol';
  assert.deepEqual((await partitioned.get('/custom-auth')).data, { user: 'carol' });
  assert.equal(mock.calls.length, 4);
});

test('cache: response types use separate entries and streams always bypass', async (t) => {
  const { client, mock } = setup(t);
  mock.get('/payload', [
    { json: { value: 7 } },
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('stream body'));
            controller.close();
          },
        }),
        { headers: { 'content-type': 'text/plain' } },
      ),
  ]);
  await client.get('/payload');
  const streamed = await client.get('/payload', { responseType: 'stream' });
  assert.equal(streamed.cache, undefined);
  const body = streamed.data;
  assert.ok(body instanceof ReadableStream);
  assert.equal(await new Response(body).text(), 'stream body');
  mock.get('/text', [{ json: { value: 7 } }, { text: '{"value":7}' }]);
  await client.get('/text');
  const asText = await client.get('/text', { responseType: 'text' });
  assert.equal(asText.cache, 'miss');
  assert.equal(asText.data, '{"value":7}');
  assert.equal(mock.calls.length, 4);
});

test('cache: stale-while-revalidate serves stale instantly and refreshes once in the background', async (t) => {
  const { client, mock, plugin, tick, events } = setup(t, { ttl: 1000, staleWhileRevalidate: 5000 });
  mock.get('/feed', counter());
  await client.get('/feed');
  tick(1500);

  const [a, b] = await Promise.all([client.get('/feed'), client.get('/feed')]);
  assert.equal(a.cache, 'stale');
  assert.equal(b.cache, 'stale');
  assert.deepEqual(a.data, { n: 1 });
  await plugin.whenIdle();
  assert.equal(mock.calls.length, 2, 'background refresh is single-flight');

  const fresh = await client.get('/feed');
  assert.equal(fresh.cache, 'hit');
  assert.deepEqual(fresh.data, { n: 2 });

  tick(1000 + 5000);
  assert.equal((await client.get('/feed')).cache, 'miss', 'beyond the SWR window it blocks on the network');
  assert.ok(events.some((e) => e.type === 'stale'));
});

test('cache: a failed background revalidation keeps the stale entry and is reported', async (t) => {
  const { client, mock, plugin, tick, events } = setup(t, { ttl: 1000, staleWhileRevalidate: 5000 });
  mock.get('/feed', { json: 'v1' }, { times: 1 }).get('/feed', { status: 404 });
  await client.get('/feed');
  tick(2000);
  assert.equal((await client.get('/feed')).data, 'v1');
  await plugin.whenIdle();
  assert.ok(events.some((e) => e.type === 'revalidate-error'));
  assert.equal((await client.get('/feed')).cache, 'stale');
});

test('cache: stale-if-error covers network errors and 5xx, but not 4xx or the end of the window', async (t) => {
  const { client, mock, tick, events } = setup(t, { ttl: 1000, staleIfError: 10000 });
  mock
    .get('/cfg', { json: 'good' }, { times: 1 })
    .get('/cfg', [{ error: 'network' }, { status: 503 }, { status: 404 }, { status: 500 }]);
  await client.get('/cfg');
  tick(2000);

  const offline = await client.get('/cfg');
  assert.equal(offline.cache, 'stale');
  assert.equal(offline.data, 'good');
  assert.equal((await client.get('/cfg')).data, 'good', '503 falls back to stale');
  await assert.rejects(client.get('/cfg'), (error) => isHttpError(error) && error.status === 404);
  tick(10000);
  await assert.rejects(client.get('/cfg'), (error) => isHttpError(error) && error.status === 500);
  assert.equal(events.filter((e) => e.type === 'stale-if-error').length, 2);
});

test('cache: stale-if-error with throwHttpErrors false', async (t) => {
  const { client, mock, tick } = setup(t, { ttl: 1000, staleIfError: 10000 });
  mock.get('/cfg', [{ json: 'good' }, { status: 502 }]);
  await client.get('/cfg');
  tick(2000);
  const result = await client.get('/cfg', { throwHttpErrors: false });
  assert.equal(result.cache, 'stale');
  assert.equal(result.data, 'good');
});

test('cache: ETag / Last-Modified revalidation turns a 304 into a cached result', async (t) => {
  const { client, mock, tick, plugin } = setup(t, { ttl: 1000 });
  mock.get(
    '/doc',
    ({ headers }): MockReply =>
      headers.get('if-none-match') === '"v1"' &&
      headers.get('if-modified-since') === 'Mon, 01 Jan 2024 00:00:00 GMT'
        ? { status: 304, headers: { 'cache-control': 'max-age=60' } }
        : {
            json: { title: 'Doc' },
            headers: {
              etag: '"v1"',
              'last-modified': 'Mon, 01 Jan 2024 00:00:00 GMT',
              'cache-control': 'max-age=1',
            },
          },
  );
  await client.get('/doc');
  tick(1500);

  const revalidated = await client.get('/doc');
  assert.equal(revalidated.cache, 'revalidated');
  assert.equal(revalidated.status, 200);
  assert.deepEqual(revalidated.data, { title: 'Doc' });
  assert.equal(revalidated.headers['cache-control'], 'max-age=60', '304 headers are merged');

  tick(30000);
  assert.equal((await client.get('/doc')).cache, 'hit', 'freshness comes from the 304');
  assert.equal(mock.calls.length, 2);
  assert.equal(plugin.stats().revalidated, 1);
});

test('cache: Cache-Control on responses (no-store, max-age, Age, Expires, must-revalidate, Vary)', async (t) => {
  const { client, mock, tick, events } = setup(t, { ttl: 60000, staleWhileRevalidate: 60000 });
  mock
    .get('/nostore', counter({ 'cache-control': 'no-store' }))
    .get('/short', counter({ 'cache-control': 'max-age=10', age: '5' }))
    .get(
      '/expires',
      counter({ date: new Date(1000000).toUTCString(), expires: new Date(1000000 + 20000).toUTCString() }),
    )
    .get('/strict', counter({ 'cache-control': 'max-age=1, must-revalidate' }))
    .get('/swr', counter({ 'cache-control': 'max-age=1, stale-while-revalidate=0' }))
    .get('/star', counter({ vary: '*' }))
    .get('/lang', ({ headers }) => ({
      json: headers.get('accept-language'),
      headers: { vary: 'Accept-Language' },
    }));

  await client.get('/nostore');
  assert.equal((await client.get('/nostore')).cache, 'miss');
  assert.ok(events.some((e) => e.type === 'skip' && e.reason === 'no-store'));

  await client.get('/short');
  tick(4000);
  assert.equal((await client.get('/short')).cache, 'hit');
  tick(2000);
  assert.equal((await client.get('/short')).cache, 'stale', 'max-age minus Age, then plugin SWR applies');

  await client.get('/expires');
  tick(19000);
  assert.equal((await client.get('/expires')).cache, 'hit');

  await client.get('/strict');
  tick(2000);
  assert.equal((await client.get('/strict')).cache, 'miss', 'must-revalidate disables stale serving');

  await client.get('/swr');
  tick(2000);
  assert.equal((await client.get('/swr')).cache, 'miss', 'the header SWR overrides the plugin option');

  await client.get('/star');
  assert.equal((await client.get('/star')).cache, 'miss');

  await client.get('/lang', { headers: { 'accept-language': 'en' } });
  assert.equal((await client.get('/lang', { headers: { 'accept-language': 'en' } })).cache, 'hit');
  const fr = await client.get('/lang', { headers: { 'accept-language': 'fr' } });
  assert.equal(fr.cache, 'miss');
  assert.equal(fr.data, 'fr');
});

test('cache: respectCacheControl false ignores headers', async (t) => {
  const { client, mock } = setup(t, { respectCacheControl: false });
  mock.get('/x', counter({ 'cache-control': 'no-store' }));
  await client.get('/x');
  assert.equal((await client.get('/x', { headers: { 'cache-control': 'no-store' } })).cache, 'hit');
});

test('cache: request Cache-Control and per-request meta options', async (t) => {
  const { client, mock, tick, plugin } = setup(t, { ttl: 1000 });
  mock.get('/r', counter({ etag: '"e"' }));
  await client.get('/r');

  assert.equal((await client.get('/r', { headers: { 'cache-control': 'no-store' } })).cache, undefined);
  const forced = await client.get('/r', { headers: { 'cache-control': 'no-cache' } });
  assert.equal(forced.cache, 'miss', 'no-cache revalidates (server ignored the ETag)');
  assert.equal(mock.calls[2]?.headers['if-none-match'], '"e"');

  assert.equal((await client.get('/r', { meta: { cache: false } })).cache, undefined);
  assert.equal((await client.get('/r', { meta: { cache: { force: 'reload' } } })).cache, 'miss');
  assert.equal(mock.calls.at(-1)?.headers['if-none-match'], undefined, 'reload is unconditional');
  assert.equal((await client.get('/r', { meta: { cache: { force: 'no-cache' } } })).cache, 'miss');

  mock.get('/long', counter());
  await client.get('/long', { meta: { cache: { ttl: 50000 } } });
  tick(40000);
  assert.equal((await client.get('/long')).cache, 'hit');

  mock.get('/k1', counter()).get('/k2', counter());
  await client.get('/k1', { meta: { cache: { key: 'shared' } } });
  const viaKey = await client.get('/k2', { meta: { cache: { key: 'shared' } } });
  assert.equal(viaKey.cache, 'hit');
  assert.equal(plugin.stats().bypassed, 2);
  assert.throws(() => cache({ ttl: -1 }), /ttl must be/);
  await assert.rejects(client.get('/r', { meta: { cache: 'yes' } }), /meta.cache must be/);
});

test('cache: tags and invalidateTag, including from a mutation', async (t) => {
  const { client, mock } = setup(t);
  mock.get('/users/1', counter()).get('/teams/9', counter()).post('/sync', { status: 204 });
  await client.get('/users/1', { meta: { cache: { tags: ['users'] } } });
  await client.get('/teams/9', { meta: { cache: { tags: ['teams', 'users'] } } });
  assert.equal((await client.get('/users/1', { meta: { cache: { tags: ['users'] } } })).cache, 'hit');

  await client.post('/sync', null, { meta: { cache: { invalidateTags: ['teams'] } } });
  assert.equal((await client.get('/users/1')).cache, 'hit');
  assert.equal((await client.get('/teams/9')).cache, 'miss');
});

test('cache: plugin.invalidateTag and a fresh tag survive store eviction safely', async (t) => {
  const { client, mock, plugin } = setup(t);
  mock.get('/a', counter());
  await client.get('/a', { meta: { cache: { tags: ['t'] } } });
  await plugin.invalidateTag('t');
  assert.equal((await client.get('/a')).cache, 'miss');
});

test('cache: mutations invalidate the URL, its query variants and its parent collection', async (t) => {
  const { client, mock } = setup(t);
  mock
    .get('/todos', counter())
    .get('/todos/5', counter())
    .get('/other', counter())
    .patch('/todos/5', { json: 'ok' })
    .post('/todos', { status: 400 });
  await client.get('/todos');
  await client.get('/todos', { params: { page: 2 } });
  await client.get('/todos/5');
  await client.get('/other');

  await assert.rejects(client.post('/todos', {}));
  assert.equal((await client.get('/todos')).cache, 'hit', 'failed mutations invalidate nothing');

  await client.patch('/todos/5', { done: true });
  assert.equal((await client.get('/todos/5')).cache, 'miss');
  assert.equal((await client.get('/todos')).cache, 'miss');
  assert.equal((await client.get('/todos', { params: { page: 2 } })).cache, 'miss');
  assert.equal((await client.get('/other')).cache, 'hit');
});

test('cache: custom invalidateOnMutation and disabled invalidation', async (t) => {
  const { client, mock } = setup(t, {
    invalidateOnMutation: (request) =>
      request.url.endsWith('/orders') ? { urls: ['/dashboard'], tags: ['x'] } : undefined,
  });
  mock
    .get('/dashboard', counter())
    .get('/orders', counter())
    .post('/orders', { status: 201 })
    .post('/noop', { status: 201 });
  await client.get('/dashboard');
  await client.get('/orders');
  await client.post('/noop');
  await client.post('/orders', {});
  assert.equal((await client.get('/dashboard')).cache, 'miss');
  assert.equal((await client.get('/orders')).cache, 'hit');

  const off = setup(t, { invalidateOnMutation: false });
  off.mock.get('/a', counter()).post('/a', { status: 201 });
  await off.client.get('/a');
  await off.client.post('/a');
  assert.equal((await off.client.get('/a')).cache, 'hit');
});

test('cache: invalidate by URL (relative to baseUrl), RegExp and predicate; clear()', async (t) => {
  const { client, mock, plugin } = setup(t, { vary: ['x-tenant'] });
  mock.get('/p/:id', ({ params }) => ({ json: params.id }));
  await client.get('/p/1', { headers: { 'x-tenant': 'a' } });
  await client.get('/p/1', { headers: { 'x-tenant': 'b' } });
  await client.get('/p/2');
  await client.get('/p/3');

  assert.equal(await plugin.invalidate('/p/1'), 3, 'exact key plus both vary variants');
  assert.equal((await client.get('/p/1', { headers: { 'x-tenant': 'a' } })).cache, 'miss');
  assert.equal(await plugin.invalidate(/\/p\/2$/), 1);
  assert.equal(await plugin.invalidate((url) => url.endsWith('/3')), 1);
  assert.equal((await client.get('/p/2')).cache, 'miss');
  assert.throws(() => plugin.invalidate(42 as never), /expects a URL/);

  await plugin.clear();
  assert.equal((await client.get('/p/2')).cache, 'miss');

  const keyless: Store = { get: () => undefined, set: () => {}, delete: () => {} };
  const bare = cache({ store: keyless });
  assert.throws(() => bare.invalidate(/x/), /needs a store that implements keys/);
  await assert.rejects(bare.clear(), /needs a store that implements clear/);
  assert.throws(() => cache({ store: {} as Store }), /store must implement/);
});

test('cache: prefix scopes clear() to its own keys', async (t) => {
  const store = memoryStore();
  store.set('foreign', 1);
  const { client, mock, plugin } = setup(t, { store, prefix: 'http:' });
  mock.get('/a', counter());
  await client.get('/a');
  assert.ok(store.keys().includes(`http:GET ${BASE}/a`));
  await plugin.clear();
  assert.deepEqual(store.keys(), ['foreign']);
});

test('cache: store failures and timeouts never fail requests', async (t) => {
  const errors: string[] = [];
  const broken: Store = {
    get: () => {
      throw new Error('get down');
    },
    set: () => Promise.reject(new Error('set down')),
    delete: () => {},
    keys: () => new Promise(() => {}),
  };
  const { client, mock, plugin } = setup(t, {
    store: broken,
    storeTimeout: 20,
    onStoreError: (_error, operation) => errors.push(operation),
  });
  mock.get('/a', counter()).post('/a', { status: 201 });
  assert.deepEqual((await client.get('/a')).data, { n: 1 });
  assert.deepEqual((await client.get('/a')).data, { n: 2 });
  await client.post('/a');
  assert.deepEqual(errors, ['get', 'set', 'get', 'set', 'keys']);
  assert.equal(plugin.stats().storeErrors, 5);
});

test('cache: what is not stored (status, data type, size, shouldCache, shared rules)', async (t) => {
  const { client, mock, events } = setup(t, {
    maxEntrySize: 200,
    shouldCache: (result) => result.headers['x-skip'] !== '1',
  });
  mock
    .get('/404', { status: 404 })
    .get('/blob', { body: 'bytes', headers: { 'content-type': 'application/octet-stream' } })
    .get('/big', { json: 'x'.repeat(500) })
    .get('/skip', { json: 1, headers: { 'x-skip': '1' } })
    .get('/empty', { status: 204 });
  await client.get('/404', { throwHttpErrors: false });
  await client.get('/blob', { responseType: 'blob' });
  await client.get('/big');
  await client.get('/skip');
  await client.get('/empty');
  const reasons = events.flatMap((e) => (e.type === 'skip' ? [e.reason] : []));
  assert.deepEqual(reasons, ['status', 'data', 'size', 'should-cache']);
  const empty = await client.get('/empty');
  assert.equal(empty.cache, 'hit');
  assert.equal(empty.status, 204);
  assert.equal(empty.data, undefined);

  const shared = setup(t, { shared: true });
  shared.mock
    .get('/private', counter({ 'cache-control': 'private, max-age=60' }))
    .get('/me', counter())
    .get('/public', counter({ 'cache-control': 'public, max-age=60' }))
    .get('/s', counter({ 'cache-control': 'max-age=1, s-maxage=100' }));
  await shared.client.get('/private');
  await shared.client.get('/me', { headers: { authorization: 'Bearer x' } });
  await shared.client.get('/public', { headers: { authorization: 'Bearer x' } });
  await shared.client.get('/s');
  shared.tick(50000);
  const sharedReasons = shared.events.flatMap((e) => (e.type === 'skip' ? [e.reason] : []));
  assert.deepEqual(sharedReasons, ['private', 'authorization']);
  assert.equal((await shared.client.get('/s')).cache, 'hit', 's-maxage wins in a shared cache');
});

test('cache: only configured methods are cached; HEAD can opt in', async (t) => {
  const { client, mock } = setup(t, { methods: ['GET', 'HEAD'], statuses: [200] });
  mock.head('/h', { status: 200, headers: { 'x-v': '1' } });
  await client.head('/h');
  assert.equal((await client.head('/h')).cache, 'hit');
});

test('cache: schema output is cached and hits skip re-validation', async (t) => {
  const { client, mock } = setup(t);
  mock.get('/n', { json: '41' });
  let runs = 0;
  const schema = (value: unknown) => {
    runs++;
    return Number(value) + 1;
  };
  assert.equal((await client.get('/n', { schema })).data, 42);
  const hit = await client.get('/n', { schema });
  assert.equal(hit.data, 42);
  assert.equal(hit.cache, 'hit');
  assert.equal(runs, 1);
});
