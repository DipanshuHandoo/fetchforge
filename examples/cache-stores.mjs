// Cache stores: the same cache() on different storage. Redis shared by several service instances (BFF),
// @dipanshuhandoo/cache-bridge (memory L1 + Redis L2), browser localStorage, and files on disk.
// Every store here is duck-typed, so the example runs offline; the comments show the real wiring.
// Docs: docs/cache.md#stores
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cache, createClient } from '@dipanshuhandoo/fetchforge';
import {
  cacheBridgeStore,
  memoryStore,
  redisStore,
  webStorageStore,
} from '@dipanshuhandoo/fetchforge/stores';
import { fileStore } from '@dipanshuhandoo/fetchforge/stores/file';
import { json, startServer } from './_server.mjs';

/** In-process stand-in for an ioredis client: the subset of commands redisStore uses. */
function fakeRedis() {
  const data = new Map();
  const live = (key) => {
    const item = data.get(key);
    if (item?.expires && item.expires <= Date.now()) data.delete(key);
    return data.get(key);
  };
  return {
    data,
    async call(command, ...args) {
      switch (command.toUpperCase()) {
        case 'GET':
          return live(args[0])?.value ?? null;
        case 'SET': {
          const [key, value, mode, ms] = args;
          data.set(key, { value, expires: mode === 'PX' ? Date.now() + Number(ms) : 0 });
          return 'OK';
        }
        case 'DEL':
          return args.filter((key) => data.delete(key)).length;
        case 'SCAN': {
          const prefix = args[args.indexOf('MATCH') + 1].replace(/\*$/, '');
          return ['0', [...data.keys()].filter((key) => key.startsWith(prefix) && live(key))];
        }
        default:
          throw new Error(`unsupported command ${command}`);
      }
    },
  };
}

/** In-process stand-in for a cache-bridge cache (`createCache({ name, ttl, redis })`). */
function fakeCacheBridge() {
  const data = new Map();
  return {
    getAsync: async (key) => {
      const item = data.get(key);
      if (item?.expires && item.expires <= Date.now()) data.delete(key);
      return data.get(key)?.value;
    },
    setAsync: async (key, value, { ttl = 0 } = {}) => {
      data.set(key, { value, expires: ttl ? Date.now() + ttl : 0 });
    },
    deleteAsync: async (key) => data.delete(key),
    clear: () => data.clear(),
    keys: () => [...data.keys()],
  };
}

/** In-process stand-in for window.localStorage. */
function fakeLocalStorage() {
  const data = new Map();
  return {
    get length() {
      return data.size;
    },
    key: (index) => [...data.keys()][index] ?? null,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
  };
}

let upstreamCalls = 0;
const api = await startServer((req, res) => {
  upstreamCalls++;
  if (req.url.startsWith('/catalogue')) {
    // Same for every user: `public, s-maxage` allows shared caches even though the BFF sends a service token.
    return json(res, 200, { items: ['tea', 'coffee'] }, { 'cache-control': 'public, s-maxage=60' });
  }
  if (req.url.startsWith('/account')) return json(res, 200, { balance: 42 });
  json(res, 200, { path: req.url });
});
const dir = await mkdtemp(join(tmpdir(), 'fetchforge-cache-'));

try {
  // 1. Redis behind a BFF: two pods share one cache, so only the first pod calls the upstream.
  //    Real wiring: import Redis from 'ioredis'; const redis = new Redis(process.env.REDIS_URL);
  //    (node-redis works too: redisStore(createClient(...)) uses its sendCommand.)
  const redis = fakeRedis();
  const pod = () =>
    createClient({
      baseUrl: api.url,
      headers: { authorization: 'Bearer service-token' },
      plugins: [cache({ store: redisStore(redis, { prefix: 'bff:http:' }), shared: true })],
    });
  const [podA, podB] = [pod(), pod()];
  assert.equal((await podA.get('/catalogue')).cache, 'miss');
  assert.equal((await podB.get('/catalogue')).cache, 'hit');
  assert.equal(upstreamCalls, 1);
  assert.ok([...redis.data.keys()].every((key) => key.startsWith('bff:http:')));

  // shared: true never stores a response for an authenticated request unless it is explicitly public,
  // so one user's /account can never be served to another user.
  await podA.get('/account');
  assert.equal((await podB.get('/account')).cache, 'miss');

  // 2. cache-bridge: hot entries in process memory, shared through Redis, with cross-instance invalidation.
  //    Real wiring:
  //      import { createCache, createRedisAdapter } from '@dipanshuhandoo/cache-bridge';
  //      const http = createCache({ name: 'http', ttl: 60000, redis: createRedisAdapter(redisClient) });
  //      cache({ store: cacheBridgeStore(http) })
  const bridge = cacheBridgeStore(fakeCacheBridge());
  const withBridge = createClient({ baseUrl: api.url, plugins: [cache({ store: bridge, ttl: 30000 })] });
  await withBridge.get('/products');
  assert.equal((await withBridge.get('/products')).cache, 'hit');

  // 3. Browser: localStorage survives reloads. Prefixed keys, and the quota is handled (oldest entries go first).
  //    Real wiring: webStorageStore(window.localStorage) or indexedDbStore() for large payloads.
  const storage = fakeLocalStorage();
  const browser = createClient({
    baseUrl: api.url,
    plugins: [cache({ store: webStorageStore(storage, { prefix: 'app-cache:' }), ttl: 30000 })],
  });
  await browser.get('/profile-settings');
  assert.equal((await browser.get('/profile-settings')).cache, 'hit');
  assert.ok(storage.key(0)?.startsWith('app-cache:'));

  // 4. Files: a CLI or build script reuses responses between runs without Redis.
  const run = () =>
    createClient({ baseUrl: api.url, plugins: [cache({ store: fileStore({ dir }), ttl: 30000 })] });
  await run().get('/build-manifest');
  assert.equal((await run().get('/build-manifest')).cache, 'hit', 'a new process-like client reads the file');

  // 5. Memory with isolation: clone: true hands out copies, so callers can mutate results safely.
  const memory = createClient({
    baseUrl: api.url,
    plugins: [cache({ store: memoryStore({ maxEntries: 1000, clone: true }) })],
  });
  const original = await memory.get('/settings');
  original.data.path = 'mutated by caller';
  assert.equal((await memory.get('/settings')).data.path, '/settings');

  console.log('cache stores example passed');
} finally {
  await rm(dir, { recursive: true, force: true });
  await api.close();
}
