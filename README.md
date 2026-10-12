# @dipanshuhandoo/fetchforge

A resilient, dependency-light `fetch` client for Node.js and browsers. It keeps the standard `fetch` semantics and adds the features most applications end up re-implementing:

- Timeouts (per attempt and total)
- Retries with fixed, linear, exponential or custom backoff, jitter and `Retry-After` support
- Circuit breaker
- Request deduplication and hedging
- Hooks, middleware and plugins, with built-in `bearerAuth`, `logger` and `monitor` plugins
- Bulk requests with a concurrency limit (via [`@dipanshuhandoo/async-slot-pool`](https://www.npmjs.com/package/@dipanshuhandoo/async-slot-pool))
- Typed errors with overridable messages
- Built-in metrics, plus optional structured logging and per-route monitoring (rolling windows, periodic flush, OpenTelemetry, Prometheus)

Retry, circuit breaker, dedupe and hedging are **opt-in**. A client with no options behaves like `fetch` plus JSON handling, a default timeout and typed errors.

## Install

```sh
npm install @dipanshuhandoo/fetchforge
```

Requires Node.js 22 or later (global `fetch`, `AbortSignal.any`). Modern browsers are supported through the ESM build, or the `FetchForge` global from `@dipanshuhandoo/fetchforge/browser`.

## Quick start

```ts
import { createClient, isHttpError } from '@dipanshuhandoo/fetchforge';

const api = createClient({
  baseUrl: 'https://api.example.com',
  timeout: 5000,
  retry: { retries: 3, delay: 5000, backoff: 'linear' }, // waits 5s, 10s, 15s
  circuitBreaker: { failureThreshold: 5, resetTimeout: 30000 },
});

try {
  const { data, status } = await api.get<{ id: number }>('/users/1');
} catch (error) {
  if (isHttpError(error)) console.error(error.status, error.message);
}
```

CommonJS: `const { createClient } = require('@dipanshuhandoo/fetchforge');`. A minified build is available at `@dipanshuhandoo/fetchforge/min`.

Runnable examples live in [`examples/`](./examples): start with `full-tour.mjs`, then see one file per feature (retry/backoff, circuit breaker, dedupe/hedging, hooks, middleware/plugins, custom plugins and webhooks, logging and monitoring, errors/messages, bulk, timeouts). Run `npm run build`, then `node examples/full-tour.mjs`.

**Full documentation:** every option, hook, error and method is defined in the [`docs/`](./docs/README.md) guides: [getting started](./docs/getting-started.md), [configuration](./docs/configuration.md), [requests and responses](./docs/requests-and-responses.md), [timeouts](./docs/timeouts.md), [retries](./docs/retries.md), [circuit breaker](./docs/circuit-breaker.md), [dedupe and hedging](./docs/dedupe-and-hedging.md), [hooks](./docs/hooks.md), [middleware](./docs/middleware-and-plugins.md), [plugins](./docs/plugins.md), [errors and messages](./docs/errors-and-messages.md), [bulk](./docs/bulk.md), [metrics](./docs/metrics.md), [logging and monitoring](./docs/logging-and-monitoring.md), [API reference](./docs/api-reference.md) and [troubleshooting](./docs/troubleshooting.md).

## API

### Creating clients

| Export | Description |
| --- | --- |
| `createClient(config?)` | Independent client (own circuits, dedupe table, metrics). |
| `fetchforge` | Ready-made default client. |
| `new FetchClient(config?)` | Same as `createClient`. |
| `client.extend(config)` | Child client that layers config on top of the parent. |
| `client.use(plugin)` | Registers a plugin (a name can be registered once). |

### Requests

`get`, `head`, `options`, `delete` take `(url, options?)`. `post`, `put`, `patch` take `(url, body?, options?)`. `request(url, options)` is the general form. `options.json` serialises an object and sets `Content-Type`; `options.body` accepts any `fetch` body.

Every call resolves to a `FetchResult<T>`:

```ts
{ url, method, data, ok, status, statusText, headers, redirected, redirectInfo,
  response, error, attempts, durationMs }
```

`HEAD` requests resolve with `data: undefined`. Choose how the body is parsed with `responseType`: `'auto' | 'json' | 'text' | 'blob' | 'arrayBuffer' | 'formData' | 'stream' | 'none'`.

### Options

All options can be set on the client and overridden per request. Hooks and middleware **append**, headers merge (a `null` value removes a header), feature objects merge field by field.

| Option | Default | Notes |
| --- | --- | --- |
| `baseUrl`, `params`, `headers` | | Query params accept arrays, `Date`s and `URLSearchParams`. |
| `timeout` | `60000` | Per attempt, in ms. Must be a positive number. |
| `totalTimeout` | none | Across all attempts and retry waits. |
| `throwHttpErrors` | `true` | `false`, or `(status) => boolean`. When it does not throw, `result.error` holds the `HttpError`. |
| `retry` | off | `true`, a number of retries, or `RetryOptions`. |
| `circuitBreaker` | off | `true` or `CircuitBreakerOptions`. |
| `dedupe` | off | `true` or `{ methods, key }`. |
| `hedging` | off | `true`, a delay in ms, or `{ delay, maxHedges, methods }`. |
| `hooks`, `middleware` | | See below. |
| `messages` | built-in | Override any error message. |
| `fetch` | global | Inject a custom `fetch` (tests, proxies, polyfills). |
| `meta` | | Arbitrary data passed to hooks. |

Standard `RequestInit` fields (`credentials`, `cache`, `mode`, …) are passed through. Invalid option values throw a `TypeError` before any request is made.

### Retry

```ts
retry: {
  retries: 3,
  delay: 1000,
  backoff: 'exponential',   // 'fixed' | 'linear' | 'exponential' | (n, info) => ms
  factor: 2, maxDelay: 30000, jitter: 0.2,
  methods: ['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE'],  // idempotent by default
  statusCodes: [408, 425, 429, 500, 502, 503, 504],
  respectRetryAfter: true, maxRetryAfter: 60000,
  shouldRetry: ({ error, retryable }) => retryable,
}
```

`fixed` with `delay: 5000` waits 5 s each time; `linear` waits 5 s, 10 s, 15 s. `POST` and `PATCH` are not retried unless you list them in `methods`. Requests with stream bodies are never retried. Aborts, an open circuit and the total timeout always stop retrying.

### Circuit breaker

Circuits are tracked per URL **origin** by default (override with `key`). Network errors, timeouts, 5xx and 429 count as failures; 4xx responses count as success; aborts are neutral. After `failureThreshold` consecutive failures the circuit opens and calls fail immediately with `CircuitOpenError` (no network call). After `resetTimeout` ms a limited number of probe requests (`halfOpenMaxRequests`) are let through; `successThreshold` successes close it. Inspect with `client.getCircuitState(urlOrKey)` and reset with `client.resetCircuit()`.

### Deduplication and hedging

- `dedupe`: concurrent identical requests (default: `GET`/`HEAD`, keyed on method + URL + headers) share one network call. Callers receive the same result object; only the first caller's hooks run. The shared call is aborted only when every caller has aborted.
- `hedging`: if the first attempt has not answered after `delay` ms, up to `maxHedges` duplicate requests are started and the first success wins; the rest are cancelled. Idempotent methods only by default. Use sparingly: it multiplies load.

### Hooks

```ts
createClient({
  hooks: {
    beforeRequest: (req) => { req.headers.set('x-trace', crypto.randomUUID()); },
    beforeRetry: ({ attempt, delay, error }) => { /* return false to stop */ },
    afterResponse: (response, req) => { /* may return a replacement Response */ },
    beforeError: (error, req) => { /* may return a replacement Error */ },
    onSuccess, onError, onComplete,   // onComplete runs like `finally`
    onCircuitStateChange,
    onHookError: (error, hookName) => {},
  },
});
```

Hooks may be a function or an array. Errors thrown inside `onSuccess`, `onError`, `onComplete` and `onCircuitStateChange` are isolated and reported to `onHookError`; they never change the request outcome.

### Middleware and plugins

```ts
const timing: Middleware = async ({ request }, next) => {
  const start = performance.now();
  try { return await next(); } finally { console.log(request.url, performance.now() - start); }
};

const plugin: Plugin = { name: 'timing', middleware: timing, hooks: { /* ... */ } };
createClient({ plugins: [plugin, bearerAuth(() => getToken())] });
```

Three plugins are bundled. All are optional and dependency-free:

| Plugin | Purpose |
| --- | --- |
| `bearerAuth(token, { header, scheme })` | Adds an auth header on every attempt. `token` may be async and is re-evaluated each time, so refreshed tokens apply to retries. |
| `logger({ sink, level, slowThreshold, ... })` | Structured request logs with a correlation ID (`x-request-id`), retry/failure/slow-request/circuit lines, and redaction of secrets in headers, query strings and URL credentials. `sink` is `console` by default, or pino/winston/any object with `debug/info/warn/error`. |
| `monitor({ groupBy, retainMs, flushIntervalMs, onFlush, meter, ... })` | Per-origin or per-route statistics: counts, error codes, latency percentiles, rolling windows, periodic flush to your store, OpenTelemetry meter, Prometheus text. |

```ts
import { bearerAuth, createClient, logger, monitor } from '@dipanshuhandoo/fetchforge';

const stats = monitor({ groupBy: 'route' });
const api = createClient({
  plugins: [bearerAuth(() => getToken()), logger({ sink: pino() }), stats],
});

stats.snapshot({ windowMs: 60000 }); // the last minute: requests, errors, p95 per route
stats.toPrometheus('myapp');        // text for a /metrics endpoint
```

Writing your own plugin (for example a webhook notifier or a cache) is covered in [plugins](./docs/plugins.md); logger and monitor options are in [logging and monitoring](./docs/logging-and-monitoring.md).

### Bulk requests

```ts
const summary = await api.bulk(['/a', '/b', { url: '/c', method: 'POST', json: { x: 1 } }], {
  concurrency: 5,
  stopOnError: false,
  signal,
  onProgress: ({ done, total }) => {},
});
// summary.results[i]: { status: 'fulfilled', result } | { status: 'rejected', error } | { status: 'skipped' }
```

Results keep input order. Each request goes through the full pipeline (retry, circuit breaker, hooks).

### Errors and messages

All errors extend `FetchForgeError` and carry `code`, `method`, `url`, `attempts` and `cause`.

| Class | Code | Guard |
| --- | --- | --- |
| `HttpError` (`status`, `data`, `response`) | `ERR_HTTP` | `isHttpError` |
| `TimeoutError` (`scope: 'attempt' \| 'total'`) | `ERR_TIMEOUT` | `isTimeoutError` |
| `NetworkError` | `ERR_NETWORK` | `isNetworkError` |
| `AbortError` | `ERR_ABORTED` | `isAbortError` |
| `CircuitOpenError` (`retryAfter`) | `ERR_CIRCUIT_OPEN` | `isCircuitOpenError` |
| `ParseError` | `ERR_PARSE` | `isParseError` |
| `RequestError` | `ERR_INVALID_URL`, `ERR_REQUEST` | `isFetchForgeError` |

Override messages with strings (`{placeholders}`) or functions; defaults are exported as `DEFAULT_MESSAGES`.

```ts
createClient({
  messages: {
    timeout: 'The server took longer than {timeout}ms to answer.',
    http: ({ status }) => (status === 404 ? 'Not found' : `Server said ${status}`),
  },
});
```

### Metrics

`client.getMetrics()` returns counters (`requests`, `succeeded`, `failed`, `aborted`, `timeouts`, `attempts`, `retries`, `circuitRejections`, `deduped`, `hedges`, `inFlight`), `statusCodes` and `latency` (`count`, `min`, `max`, `avg`, `last`). `resetMetrics()` clears them. `abortAll()` cancels every in-flight request of a client.

### Types

The package ships its own declarations for ESM and CommonJS consumers. All option, hook and result types are exported.

## Limitations

- Retries cannot replay stream bodies; such requests are never retried or hedged.
- Dedupe and the circuit breaker are per client instance and per process; there is no shared state across processes.
- Hedging and retries on non-idempotent methods can duplicate side effects; you must opt in explicitly.
- Browsers: the circuit breaker origin key and CORS behaviour follow what `fetch` exposes.

## Migrating from the pre-release `fetch.service.js`

| Old | New |
| --- | --- |
| Default singleton export | `createClient()` / named `fetchforge` instance |
| `updateConfig`, `setDefaultHeaders` | `client.extend({...})` |
| `authenticatedGet/Post` | `bearerAuth()` plugin |
| Failed responses resolved | Non-2xx now throws `HttpError` (set `throwHttpErrors: false` to restore) |
| Forced `Content-Type` | Set only when you pass `json` |

## Versioning and support

[Semantic Versioning](https://semver.org). Breaking changes only in major releases, documented in the [CHANGELOG](./CHANGELOG.md) with migration notes. The latest major line and active Node.js LTS releases (≥ 22) are supported. See [CONTRIBUTING](./CONTRIBUTING.md), [SECURITY](./SECURITY.md) and [RELEASING](./RELEASING.md).

## License

MIT © Dipanshu Handoo
