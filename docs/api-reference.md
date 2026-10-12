# API reference

Everything is a named export (there is no default export).

## Functions and values

| Export | Description |
| --- | --- |
| `createClient(config?)` | Creates an independent `FetchClient`. |
| `fetchforge` | A ready-made client with default settings. |
| `FetchClient` | The client class (`new FetchClient(config)` equals `createClient`). |
| `bearerAuth(token, options?)` | Plugin that adds an auth header on every attempt. See [plugins](./middleware-and-plugins.md#built-in-plugin-bearerauth). |
| `logger(options?)` | Plugin for structured, redacted request logs. See [logging and monitoring](./logging-and-monitoring.md). |
| `monitor(options?)` | Plugin collecting per-group statistics, with `snapshot()`, `toPrometheus()` and `reset()`. |
| `DEFAULT_MESSAGES` | The frozen default message templates. |
| Error classes | `FetchForgeError`, `HttpError`, `TimeoutError`, `NetworkError`, `AbortError`, `CircuitOpenError`, `ParseError`, `RequestError`. See [errors](./errors-and-messages.md). |
| Type guards | `isFetchForgeError`, `isHttpError`, `isTimeoutError`, `isNetworkError`, `isAbortError`, `isCircuitOpenError`, `isParseError`. |

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
| `MonitorOptions`, `MonitorPlugin`, `MonitorSnapshot`, `GroupStats`, `MonitorEvent` | Monitor plugin. |
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
