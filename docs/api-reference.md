# API reference

Everything is a named export (there is no default export). The package has four entry points:

| Entry | Contents | Runtimes |
| --- | --- | --- |
| `@dipanshuhandoo/fetchforge` | Client, plugins, errors, stream helpers, types | Node.js, browsers, workers |
| `@dipanshuhandoo/fetchforge/stores` | `memoryStore`, `redisStore`, `webStorageStore`, `indexedDbStore`, `cacheBridgeStore` | Node.js, browsers, workers |
| `@dipanshuhandoo/fetchforge/stores/file` | `fileStore` | Node.js |
| `@dipanshuhandoo/fetchforge/testing` | `mockFetch` | Node.js, browsers |

## Functions and values (root entry)


| Export | Description |
| --- | --- |
| `createClient(config?)` | Creates an independent `FetchClient`. |
| `fetchforge` | A ready-made client with default settings. |
| `FetchClient` | The client class (`new FetchClient(config)` equals `createClient`). |
| `bearerAuth(token, options?)` | Plugin that adds an auth header on every attempt. See [plugins](./plugins.md). |
| `logger(options?)` | Plugin for structured, redacted request logs. See [logging and monitoring](./logging-and-monitoring.md). |
| `monitor(options?)` | Plugin collecting per-group statistics, with `snapshot({ windowMs }?)`, `toPrometheus()`, `flush()`, `stop()` and `reset()`; options include `onFlush`/`flushIntervalMs` and an OpenTelemetry `meter`. |
| `authRefresh(options)` | Plugin that refreshes the token once on 401 (single-flight) and replays; `refresh()`. See [auth refresh](./auth-refresh.md). |
| `cache(options?)` | Response cache plugin; `invalidate(url \| RegExp \| fn)`, `invalidateTag(...tags)`, `clear()`, `stats()`, `whenIdle()`. See [response cache](./cache.md). |
| `rateLimit(options)` | Client-side token-bucket plugin; `state()`, `stop()`. See [rate limiting](./rate-limiting.md). |
| `idempotency(options?)` | Plugin adding `Idempotency-Key` to mutations. See [idempotency](./idempotency.md). |
| `offlineQueue(options?)` | Plugin queueing mutations while offline; `flush()`, `pending()`, `clear()`, `stop()`. See [offline queue](./offline.md). |
| `iterateLines(source)`, `iterateNdjson(source)`, `iterateSse(source)` | Async generators over a `'stream'` result, `Response` or `ReadableStream`. See [progress and streaming](./progress-and-streaming.md). |
| `DEFAULT_MESSAGES` | The frozen default message templates. |
| Error classes | `FetchForgeError`, `HttpError`, `TimeoutError`, `NetworkError`, `AbortError`, `CircuitOpenError`, `ParseError`, `RequestError`, `ValidationError`, `RateLimitError`, `AuthError`, `QueuedError`. See [errors](./errors-and-messages.md). |
| Type guards | `isFetchForgeError`, `isHttpError`, `isTimeoutError`, `isNetworkError`, `isAbortError`, `isCircuitOpenError`, `isParseError`, `isValidationError`, `isRateLimitError`, `isAuthError`, `isQueuedError`. |

## `@dipanshuhandoo/fetchforge/stores`

| Export | Description |
| --- | --- |
| `memoryStore(options?)` | In-process LRU (`maxEntries`, default 1000; `clone`). |
| `redisStore(client, options?)` | Redis via an ioredis-style `call()` or node-redis `sendCommand()`; `prefix` (default `'fetchforge:'`), `scanCount`. |
| `webStorageStore(storage, options?)` | `localStorage` / `sessionStorage` (or any `StorageLike`); `prefix`. |
| `indexedDbStore(options?)` | IndexedDB; `dbName` (default `'fetchforge'`), `indexedDB`. |
| `cacheBridgeStore(cache)` | Adapter for `@dipanshuhandoo/cache-bridge`. |

`@dipanshuhandoo/fetchforge/stores/file` exports `fileStore({ dir })` (Node.js, atomic writes). Every store implements `Store`: `get`, `set(key, value, ttlMs?)`, `delete`, and optionally `clear` and `keys`. See [stores](./cache.md#stores).

## `@dipanshuhandoo/fetchforge/testing`

`mockFetch(options?)` returns a `fetch` replacement with `on`/`get`/`post`/`put`/`patch`/`delete`/`head`/`any` routes, `calls`, `pending()` and `reset()`. See [testing](./testing.md).

## `FetchClient` methods

| Method | Returns | Description |
| --- | --- | --- |
| `get(url, options?)` | `Promise<FetchResult<T>>` | GET request. |
| `head(url, options?)` | `Promise<FetchResult<undefined>>` | HEAD request: headers and status only, no body. |
| `options(url, options?)` | `Promise<FetchResult<T>>` | OPTIONS request. |
| `delete(url, options?)` | `Promise<FetchResult<T>>` | DELETE request. |
| `post(url, body?, options?)` | `Promise<FetchResult<T>>` | POST; `body` as in [requests](./requests-and-responses.md#request-bodies). |
| `put(url, body?, options?)` | `Promise<FetchResult<T>>` | PUT. |
| `patch(url, body?, options?)` | `Promise<FetchResult<T>>` | PATCH. |
| `request(url, options)` | `Promise<FetchResult<T>>` | Any method via `options.method`. |
| `bulk(requests, options?)` | `Promise<BulkResult<T>>` | Many requests with a concurrency limit. See [bulk](./bulk.md). |
| `use(plugin)` | `this` | Registers a plugin (unique `name`). |
| `extend(config?)` | `FetchClient` | New independent client (own circuits, dedupe table, metrics) inheriting settings and plugins, with `config` layered on top. |
| `getConfig()` | `Readonly<Settings>` | Snapshot of the effective client defaults (headers as a plain object). |
| `getMetrics()` | `Metrics` | Counter snapshot. See [metrics](./metrics.md). |
| `resetMetrics()` | `void` | Zero the counters. |
| `getCircuitState(keyOrUrl)` | `'closed' \| 'open' \| 'half-open'` | State of a circuit; `'closed'` if none exists yet. |
| `resetCircuit(keyOrUrl?)` | `void` | Force one circuit (or all) closed. |
| `abortAll()` | `void` | Cancel every in-flight request on this client. |

## Types

All are exported with `import type`.

| Type | Purpose |
| --- | --- |
| `ClientConfig`, `Settings`, `RequestOptions` | Options for `createClient`, shared settings, and per-request options. See [configuration](./configuration.md). |
| `FetchResult<T>` | Resolved value of a request. |
| `HookRequest` | Request as seen by hooks and middleware. |
| `Hooks`, `HookName`, `RetryInfo`, `CompleteInfo` | Hook map and its argument types. See [hooks](./hooks.md). |
| `Middleware`, `MiddlewareContext`, `Plugin`, `BearerAuthOptions` | Extension points. |
| `LoggerOptions`, `LoggerLike`, `LogLevel` | Logger plugin. |
| `MonitorOptions`, `MonitorPlugin`, `MonitorSnapshot`, `GroupStats`, `MonitorEvent`, `FlushReport`, `MeterLike` | Monitor plugin. |
| `CacheOptions`, `CachePlugin`, `RequestCacheOptions`, `CacheEvent`, `CacheSkipReason`, `CacheStats`, `CacheStatus` | Cache plugin and the `result.cache` field. |
| `Store` | Store interface (root and `/stores`); `/stores` also exports each store's options and return types, `RedisLike`, `StorageLike`, `CacheBridgeLike`. |
| `AuthRefreshOptions`, `AuthRefreshPlugin`, `AuthRefreshContext` | Auth refresh plugin. |
| `RateLimitOptions`, `RateLimitPlugin`, `RateLimitBucketState` | Rate limit plugin. |
| `IdempotencyOptions` | Idempotency plugin. |
| `OfflineQueueOptions`, `OfflineQueuePlugin`, `QueuedRequest`, `OfflineFlushResult`, `OfflineDropReason` | Offline queue plugin. |
| `SchemaLike`, `StandardSchemaLike`, `SchemaOutput`, `SchemaIssue`, `ValidationIssue` | Response validation. |
| `TransferProgress`, `ServerSentEvent`, `StreamSource` | Progress and streaming. |
| `MockFetch`, `MockFetchOptions`, `MockReply`, `MockResponder`, `MockRequestInfo`, `MockPattern`, `MockRouteOptions`, `MockCall` | Testing (from `/testing`). |
| `RetryOptions`, `BackoffStrategy`, `BackoffFunction`, `ShouldRetryInfo` | Retry configuration. |
| `CircuitBreakerOptions`, `CircuitState` | Circuit breaker. |
| `DedupeOptions`, `HedgingOptions` | Dedupe and hedging. |
| `ResponseType`, `HttpMethod`, `HeadersInput`, `QueryParams`, `QueryValue` | Input and output helpers. |
| `Metrics` | Metrics snapshot. |
| `BulkRequest`, `BulkOptions`, `BulkResult`, `BulkItem` | Bulk API. |
| `Messages`, `MessageTemplate`, `MessageContext` | Message customisation. |
| `ErrorCode`, `TimeoutScope` | Error code union and `'attempt' \| 'total'`. |

## Compatibility and versioning

Follows semantic versioning: everything listed on this page is the public API; anything else (including `dist` internals) may change in any release. See [CHANGELOG](../CHANGELOG.md) and [RELEASING](../RELEASING.md).