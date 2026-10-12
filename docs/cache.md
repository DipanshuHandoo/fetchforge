# Response cache

`cache()` is an HTTP response cache for fetchforge clients: TTLs, **stale-while-revalidate**, **stale-if-error**, cheap ETag/Last-Modified revalidation (304), `Cache-Control` support, tags, automatic invalidation after writes, and a **pluggable store** (memory, Redis, cache-bridge, localStorage, IndexedDB, files, or your own).

It replaces the hand-written "check a Map, else fetch and save" code most applications carry around, and handles the parts that are easy to get wrong: stampedes during refresh, serving one user's data to another, unbounded memory, a slow cache store taking the app down, and stale lists after a POST.

```js
import { cache, createClient } from '@dipanshuhandoo/fetchforge';

const api = createClient({
  baseUrl: 'https://api.example.com',
  plugins: [cache({ ttl: 60000, staleWhileRevalidate: 300000 })],
});

const { data, cache: status } = await api.get('/products'); // status: 'miss', later 'hit' | 'stale' | 'revalidated'
```

Runnable: [`examples/cache.mjs`](../examples/cache.mjs) (behaviour) and [`examples/cache-stores.mjs`](../examples/cache-stores.mjs) (stores).

## Contents

- [How a cached request flows](#how-a-cached-request-flows)
- [Freshness: TTL, Cache-Control and per-request overrides](#freshness)
- [Stale-while-revalidate](#stale-while-revalidate)
- [Revalidation with ETag / Last-Modified](#revalidation-with-etag--last-modified)
- [Stale-if-error](#stale-if-error)
- [What is never cached](#what-is-never-cached)
- [Invalidation: mutations, URLs, patterns and tags](#invalidation)
- [Stores](#stores)
- [Per-request options](#per-request-options)
- [Options reference](#options-reference)
- [Events, stats and observability](#events-stats-and-observability)
- [Recipes](#recipes)
- [Caveats](#caveats)

## How a cached request flows

For a cacheable method (GET by default):

| State of the entry | What happens | `result.cache` |
| --- | --- | --- |
| None | Network request, response stored if cacheable. | `'miss'` |
| Fresh (`age < ttl`) | Served from the store; no network. | `'hit'` |
| Stale, within `staleWhileRevalidate` | Served from the store instantly; one background refresh per key. | `'stale'` |
| Stale, has `ETag`/`Last-Modified` | Conditional request; on `304` the stored body is reused and re-freshened. | `'revalidated'` |
| Stale, origin fails, within `staleIfError` | Served from the store instead of throwing. | `'stale'` |
| Stale beyond all windows | Normal network request. | `'miss'` |

Mutations (POST/PUT/PATCH/DELETE) pass through and, on success, invalidate related entries.

Cache hits return a normal `FetchResult` (`status`, `headers` with a computed `age`, `data`, `attempts: 0`) plus `cache`. `response` is a body-less `Response` for headers and status; read the body from `data`.

Register `cache()` **first** in `plugins` so a hit skips downstream work (rate limits, logging, retries and the auth request middleware). The built-in `authRefresh()` and `bearerAuth()` plugins expose their current token to the cache for a one-way hashed identity partition; changing users or tokens therefore uses a different cache entry without putting the token in the key. `responseType` is part of the key, and stream requests always bypass the cache.

If a custom `beforeRequest` hook adds credentials, the cache cannot know the identity before that hook runs. It safely bypasses caching when such unpartitioned hooks are present. The hooks of the built-in `rateLimit()`, `logger()` and `idempotency()` plugins don't affect identity and never trigger this bypass. To cache those requests, set `key` to a callback that includes both the resource URL and your stable user/tenant identity (never return a raw secret):

```js
cache({ key: (request) => `${currentUser.id}:${request.method}:${request.url}` });
```

## Freshness

The freshness lifetime of a stored response is decided in this order (later wins):

1. The plugin's `ttl` (default 60000 ms).
2. With `respectCacheControl` (default `true`), the response headers: `no-cache` → 0 (always revalidate), `max-age` (or `s-maxage` with `shared: true`) minus `Age`, else `Expires - Date`. `stale-while-revalidate=N` and `stale-if-error=N` directives set those windows; `must-revalidate` disables both.
3. Per request: `meta: { cache: { ttl, staleWhileRevalidate, staleIfError } }`.

```js
cache({ ttl: 30000 });                                // 30 s unless the server says otherwise
cache({ ttl: 30000, respectCacheControl: false });    // 30 s, always
api.get('/exchange-rates', { meta: { cache: { ttl: 5000 } } }); // this call: 5 s
```

Request headers are honoured too: `Cache-Control: no-store` bypasses the cache, `no-cache` or `max-age=0` forces revalidation.

## Stale-while-revalidate

```js
cache({ ttl: 60000, staleWhileRevalidate: 10 * 60000 });
```

For 1 minute responses are fresh. For the next 10 minutes a request gets the stored copy **immediately** and triggers a background refresh; the next request sees the new data. Users never wait on the slow path, and the origin sees at most one refresh per key at a time no matter how many requests arrive.

Background refreshes run through the same pipeline (retries, timeouts, circuit breaker, rate limit). If one fails, a `revalidate-error` event is emitted and the stale copy keeps serving until the window ends. `await plugin.whenIdle()` waits for refreshes in flight (useful in tests and on shutdown).

## Revalidation with ETag / Last-Modified

When a stored response has an `ETag` or `Last-Modified` and needs revalidation, the cache sends `If-None-Match` / `If-Modified-Since`. A `304 Not Modified` costs a few hundred bytes; the stored body is reused, its headers updated and its freshness restarted. The result has `status: 200`, `cache: 'revalidated'`.

Entries with validators are kept for `revalidationWindow` (default 1 hour) after they are stored even if their fresh/stale windows are shorter, so they can still be revalidated cheaply. Set `0` to keep them only as long as their windows.

`Cache-Control: no-cache` from the server means exactly this: store, but revalidate every time.

## Stale-if-error

```js
cache({ ttl: 60000, staleIfError: 24 * 3600000 });
```

When a stale entry can't be refreshed because of a network error, timeout, open circuit, client rate limit, validation failure or a 5xx, the stored copy is served (`cache: 'stale'`, event `stale-if-error`) instead of an error. 4xx responses are **not** masked: they are real answers.

## What is never cached

The plugin emits a `skip` event with the reason:

| Reason | When |
| --- | --- |
| `status` | Status not in `statuses` (default 200, 203, 204), or the request failed. |
| `no-store` | `Cache-Control: no-store` on the response. |
| `private` | `Cache-Control: private` with `shared: true`. |
| `authorization` | `shared: true` disallows an authenticated response, or custom request hooks cannot provide a safe cache partition. |
| `vary` | `Vary: *`. |
| `data` | The parsed response data isn't JSON-serialisable (for example, `blob`, `arrayBuffer` or `formData`). Streams bypass the cache before lookup. |
| `size` | Serialised entry exceeds `maxEntrySize`. |
| `expired` | Lifetime computed as 0 and no validators. |
| `should-cache` | Your `shouldCache` returned false. |

A response `Vary: Accept-Language` stores one entry per value of that request header automatically (with `respectCacheControl`). Use the `vary` option to split entries on headers the server doesn't declare.

Credentials in `Authorization`, `Cookie` and `Proxy-Authorization` are hashed into the cache identity and are not written into cache keys or `Vary` metadata. Built-in auth plugins provide their token identity even though their request hooks run after the cache middleware. For custom auth headers, use a custom `key` callback or the cache will bypass requests whenever an unpartitioned `beforeRequest` hook is configured.

## Invalidation

**After writes, automatically.** With `invalidateOnMutation: true` (default), a successful POST/PUT/PATCH/DELETE invalidates its own URL and its parent collection: `PATCH /todos/5` clears `GET /todos/5` and `GET /todos` (including query variants like `/todos?page=2`). Customise with a function:

```js
cache({
  invalidateOnMutation: (request, result) =>
    request.url.includes('/orders') ? { urls: ['/orders', '/dashboard'], tags: ['stats'] } : undefined,
});
```

Per request: `api.post('/orders', order, { meta: { cache: { invalidateTags: ['stats'] } } })`.

**By hand**, e.g. from a webhook, WebSocket message or admin action:

```js
await responses.invalidate('/products/42');          // one URL and its query variants
await responses.invalidate(/\/products\//);           // pattern (store must implement keys())
await responses.invalidate((url) => url.endsWith('/stats'));
await responses.invalidateTag('catalogue');           // everything stored with this tag
await responses.clear();                              // everything (scoped to `prefix` if set)
```

**Tags** are attached when an entry is stored: `api.get('/products', { meta: { cache: { tags: ['catalogue'] } } })`. Invalidation bumps a version stored under the tag, so it is O(1) and works with any store and across instances that share the store (Redis), without scanning keys. Entries are checked lazily on the next read.

## Stores

A store is anything with `get`, `set(key, value, ttlMs)` and `delete` (sync or async). `keys()` enables pattern invalidation and `clear()` enables `cache.clear()`.

```ts
interface Store<V = unknown> {
  get(key: string): Awaitable<V | undefined | null>;
  set(key: string, value: V, ttlMs?: number): Awaitable<unknown>;
  delete(key: string): Awaitable<unknown>;
  clear?(): Awaitable<unknown>;
  keys?(): Awaitable<Iterable<string>>;
}
```

Built-in adapters live in subpaths, so they cost nothing unless imported. None adds a dependency: you pass in your own client.

| Store | Import | Where | Good for |
| --- | --- | --- | --- |
| `memoryStore({ maxEntries, clone })` | `@dipanshuhandoo/fetchforge/stores` | Anywhere | Default. LRU, bounded, fastest. `clone: true` returns copies so callers can't mutate the cache. |
| `redisStore(client, { prefix, scanCount })` | `.../stores` | Node.js | Shared cache across pods/instances (BFF, API gateway, workers). ioredis (`call`) or node-redis v4+ (`sendCommand`). |
| `cacheBridgeStore(cache)` | `.../stores` | Node.js | [`@dipanshuhandoo/cache-bridge`](https://www.npmjs.com/package/@dipanshuhandoo/cache-bridge): in-process L1 + Redis L2 with cross-instance invalidation and hydration. |
| `webStorageStore(storage, { prefix })` | `.../stores` | Browser | `localStorage` (survives reloads) or `sessionStorage` (per tab). On a quota error, purges expired entries and retries once; a write that still fails is reported to `onStoreError` and the request continues. |
| `indexedDbStore({ dbName })` | `.../stores` | Browser, workers | Larger payloads, asynchronous (doesn't block the main thread like `localStorage`), survives reloads. |
| `fileStore({ dir })` | `@dipanshuhandoo/fetchforge/stores/file` | Node.js | CLIs, build scripts and cron jobs that reuse responses between runs. Atomic writes. |

### Redis (shared cache behind a BFF)

```js
import Redis from 'ioredis';
import { cache, createClient } from '@dipanshuhandoo/fetchforge';
import { redisStore } from '@dipanshuhandoo/fetchforge/stores';

const redis = new Redis(process.env.REDIS_URL);
const upstream = createClient({
  baseUrl: 'https://catalogue.internal',
  dedupe: true, // collapse concurrent misses inside this instance
  plugins: [
    cache({
      store: redisStore(redis, { prefix: 'bff:http:' }),
      shared: true,           // never store per-user responses
      ttl: 30000,
      staleWhileRevalidate: 300000,
      staleIfError: 3600000,
      storeTimeout: 50,       // a slow Redis must not slow requests: treat as a miss
      onStoreError: (error, op) => log.warn({ error, op }, 'cache store failed'),
    }),
  ],
});
```

node-redis works the same way: `redisStore(createClient({ url }))` after `connect()`. Values are JSON with a `PX` expiry; `keys()`/`clear()` use `SCAN` within the prefix (never `KEYS` or `FLUSHDB`).

### cache-bridge

```js
import { createCache, createRedisAdapter } from '@dipanshuhandoo/cache-bridge';
import { cacheBridgeStore } from '@dipanshuhandoo/fetchforge/stores';

const http = createCache({ name: 'http', ttl: 60000, memory: { maxEntries: 5000 }, redis: createRedisAdapter(redisClient) });
const api = createClient({ plugins: [cache({ store: cacheBridgeStore(http) })] });
```

Hot entries are read from process memory (microseconds) while other instances still benefit from Redis. cache-bridge is eventually consistent across instances, which suits HTTP caching. The cache's own TTL is overridden per entry by fetchforge's computed lifetime.

### Browser

```js
import { indexedDbStore, webStorageStore } from '@dipanshuhandoo/fetchforge/stores';

cache({ store: webStorageStore(localStorage, { prefix: 'app:http:' }), ttl: 300000, staleWhileRevalidate: 86400000 });
cache({ store: indexedDbStore({ dbName: 'app-http-cache' }) }); // for large responses
```

A long `staleWhileRevalidate` with a persistent store gives instant pages on reload, then refreshes in the background. Clear the cache on logout: `await responses.clear()`.

### Your own store

Any key-value system works (Memcached, DynamoDB, Cloudflare KV, an LRU library):

```js
import { LRUCache } from 'lru-cache';
const lru = new LRUCache({ max: 10000, ttlAutopurge: false });
const lruStore = {
  get: (key) => lru.get(key),
  set: (key, value, ttlMs) => lru.set(key, value, ttlMs ? { ttl: ttlMs } : undefined),
  delete: (key) => lru.delete(key),
  clear: () => lru.clear(),
  keys: () => lru.keys(),
};
cache({ store: lruStore });
```

Rules: return `undefined`/`null` for missing or expired keys; honour `ttlMs` (or don't, the cache checks lifetimes itself); values are plain JSON-safe objects. Store errors and timeouts are caught, counted in `stats().storeErrors` and reported to `onStoreError`; requests continue as misses.

## Per-request options

```js
api.get('/me', { meta: { cache: false } });                        // bypass completely
api.get('/feed', { meta: { cache: { force: 'reload' } } });        // ignore the stored copy, store the new one
api.get('/feed', { meta: { cache: { force: 'no-cache' } } });      // revalidate before using the stored copy
api.get('/feed', { meta: { cache: { ttl: 5000, tags: ['feed'] } } });
api.get('/search', { meta: { cache: { key: 'search:latest' } } }); // custom key (use tags to invalidate)
api.post('/feed', item, { meta: { cache: { invalidateTags: ['feed'] } } });
```

| Field | Type | Effect |
| --- | --- | --- |
| `ttl`, `staleWhileRevalidate`, `staleIfError` | ms | Override the windows for this response. |
| `tags` | `string[]` | Labels for `invalidateTag()`. |
| `key` | `string` | Replace the computed key. |
| `force` | `'reload' \| 'no-cache'` | Skip the stored copy, or revalidate it first. |
| `invalidateTags` | `string[]` | On a successful mutation, invalidate these tags. |

## Options reference

| Option | Default | Description |
| --- | --- | --- |
| `store` | `memoryStore({ maxEntries: 500 })` | Where entries live. |
| `ttl` | `60000` | Freshness when the response doesn't specify one. |
| `staleWhileRevalidate` | `0` | Serve stale and refresh in background for this long after `ttl`. |
| `staleIfError` | `0` | Serve stale when the origin fails, for this long after `ttl`. |
| `revalidationWindow` | `3600000` | Keep entries with `ETag`/`Last-Modified` this long for 304 revalidation. |
| `respectCacheControl` | `true` | Honour `Cache-Control`, `Expires`, `Vary` and request `Cache-Control`. |
| `shared` | `false` | Shared-cache rules: skip `private` and authenticated responses unless public; prefer `s-maxage`. |
| `methods` | `['GET']` | Cached methods (e.g. add `'POST'` for GraphQL/search queries together with a `key`). |
| `statuses` | `[200, 203, 204]` | Cached statuses. Only 2xx statuses can be stored; other statuses are results with `error` set and are never cached. |
| `vary` | `[]` | Request headers that split entries (e.g. `['accept-language']`). |
| `key` | `METHOD url` | Custom key function `(request) => string`. Disables URL invalidation; use tags. |
| `prefix` | `''` | Namespace in the store; scopes `clear()`. |
| `invalidateOnMutation` | `true` | `true`, `false` or `(request, result) => ({ urls?, tags? })`. |
| `shouldCache` | | `(result, request) => boolean`, the final say. |
| `maxEntrySize` | none | Skip entries whose JSON is longer than this many characters. |
| `storeTimeout` | `1000` | A store call slower than this is treated as a miss / no-op. `0` disables. |
| `onEvent` | | `(event: CacheEvent) => void`. |
| `onStoreError` | | `(error, operation) => void`. |

Plugin methods: `invalidate(url | RegExp | fn): Promise<number>`, `invalidateTag(...tags)`, `clear()`, `stats()`, `whenIdle()`.

## Events, stats and observability

```js
const responses = cache({
  onEvent: (event) => metrics.increment(`http_cache_${event.type}`),
});
responses.stats(); // { hits, stale, revalidated, misses, stores, bypassed, storeErrors }
```

| Event | Fields |
| --- | --- |
| `hit`, `stale`, `revalidated`, `miss` | `key`, `url` |
| `stale-if-error`, `revalidate-error` | `key`, `url`, `error` |
| `store` | `key`, `url`, `ttl` (retention in the store) |
| `skip` | `key`, `url`, `reason` |
| `bypass` | `url` |
| `invalidate` | `keys` |

Hits and stale responses are answered inside the cache, before the hooks run, so `logger`/`monitor` only see requests that reach the network. Use `onEvent` or `stats()` for hit ratios.

## Recipes

**Instant UI with background refresh (SPA).** Persistent store plus a long SWR window:

```js
cache({ store: indexedDbStore(), ttl: 30000, staleWhileRevalidate: 7 * 86400000, staleIfError: 7 * 86400000 });
```

**Per-user cache in a browser.** Not shared, so authenticated responses are stored; clear on logout and namespace by user:

```js
const responses = cache({ store: webStorageStore(sessionStorage), prefix: `u:${userId}:` });
onLogout(() => responses.clear());
```

**Language-dependent content.** `cache({ vary: ['accept-language'] })`.

**Cache POST-based queries (GraphQL, search).** Opt in and key on the body:

```js
cache({
  methods: ['GET', 'POST'],
  invalidateOnMutation: false,
  key: (request) => `${request.method} ${request.url} ${request.body}`,
});
```

**Respect a slow third party with a strict budget.** Combine with [`rateLimit()`](./rate-limiting.md): hits never consume rate-limit tokens because `cache()` is registered first.

## Caveats

- **Auth added by hooks isn't part of the key.** `bearerAuth`/`authRefresh` set `Authorization` after the cache computes its key. In a per-user cache shared by several users (e.g. one Node.js process serving many users without `shared: true`), add `vary: ['authorization']` or a `key`/`prefix` per user. With `shared: true`, authenticated responses are only stored when explicitly public.
- **`vary` values appear in keys in plain text.** Avoid varying on secrets with stores you don't trust; use a `key` function that hashes them instead.
- **Hits are not re-validated against `schema`.** Data was validated when it was stored.
- **The memory store holds objects by reference.** Mutating `result.data` changes the cached copy; use `memoryStore({ clone: true })` or treat results as immutable.
- **A custom `key` disables URL-based invalidation** for those entries; use tags.
- **Concurrent misses** for the same key on one instance each go to the network unless `dedupe: true` is set on the client. Across instances, use a short `ttl` with `staleWhileRevalidate` to keep refreshes rare.
- **Only JSON-safe data is cached.** Streams, blobs and binary responses are skipped (reason `data`).
