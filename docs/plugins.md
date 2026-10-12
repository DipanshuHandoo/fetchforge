# Plugins

A plugin is a named bundle of [hooks](./hooks.md), [middleware](./middleware-and-plugins.md#middleware) and one-time setup. Use one whenever the same behaviour (auth, logging, alerts, caching) should be shared across clients or projects.

```ts
interface Plugin {
  name: string;                           // required; unique per client
  hooks?: Hooks;                          // merged after the client's own hooks
  middleware?: Middleware | Middleware[]; // added after existing middleware
  setup?: (client: FetchClient) => void;  // runs once, on registration
}
```

Register with `createClient({ plugins: [a, b] })` or `client.use(plugin)` (returns the client for chaining).

## Built-in plugins

All built-in plugins are dependency-free, opt-in and exported from the package root.

| Plugin | Purpose | Main options | Extra methods | Guide |
| --- | --- | --- | --- | --- |
| `bearerAuth(token, options?)` | Adds an `Authorization` header on every attempt. The token may be a string or a (possibly async) function, so refreshed tokens apply to retries. | `header`, `scheme` | | [middleware and plugins](./middleware-and-plugins.md#built-in-plugin-bearerauth) |
| `authRefresh(options)` | On 401, refreshes the token once (single-flight across concurrent calls) and replays the request. | `getToken`, `refreshToken`, `shouldRefresh`, `maxRefreshAttempts`, `onRefreshFailed`, `header`, `scheme` | `refresh()` | [auth refresh](./auth-refresh.md) |
| `cache(options?)` | Response cache: TTL, stale-while-revalidate, stale-if-error, Cache-Control, ETag/Last-Modified revalidation, invalidation on mutations, tags. Pluggable stores. | `store`, `ttl`, `staleWhileRevalidate`, `staleIfError`, `respectCacheControl`, `shared`, `vary`, `key`, `invalidateOnMutation`, `shouldCache`, `onEvent` | `invalidate()`, `invalidateTag()`, `clear()`, `stats()`, `whenIdle()` | [response cache](./cache.md) |
| `rateLimit(options)` | Client-side token bucket per origin (or custom key); requests wait for a token instead of hitting 429s. Honours `Retry-After`. | `limit`, `interval`, `key`, `maxQueue`, `maxWait`, `respectHeaders`, `maxPause`, `onDelay` | `state()`, `stop()` | [rate limiting](./rate-limiting.md) |
| `idempotency(options?)` | Adds an `Idempotency-Key` to POST/PATCH, reused across retries, so mutations retry safely. | `methods`, `header`, `generate` | | [idempotency](./idempotency.md) |
| `offlineQueue(options?)` | Queues mutations made offline (or failing with network errors) and replays them in order. | `store`, `methods`, `isOnline`, `queueOn`, `preserveOrder`, `maxItems`, `maxAge`, `maxAttempts`, `replayInterval`, `mode` | `flush()`, `pending()`, `clear()`, `stop()` | [offline queue](./offline.md) |
| `logger(options?)` | Structured, redacted request logs with correlation IDs, retry, failure, slow-request and circuit lines. Works with console, pino or winston. | `sink`, `level`, `slowThreshold`, `requestIdHeader`, `redactHeaders`, `redactParams`, `logHeaders` | | [logging and monitoring](./logging-and-monitoring.md#loggeroptions) |
| `monitor(options?)` | Per-group statistics: counts, error codes, latency percentiles, rolling windows, periodic flush, OpenTelemetry meter, Prometheus text. | `groupBy`, `buckets`, `maxGroups`, `retainMs`, `sliceMs`, `flushIntervalMs`, `onFlush`, `meter`, `onEvent` | `snapshot()`, `reset()`, `flush()`, `stop()`, `toPrometheus()` | [logging and monitoring](./logging-and-monitoring.md#monitoroptions) |

Related features that are options rather than plugins: [`schema`](./validation.md) for response validation, [`onDownloadProgress` / `onUploadProgress` and stream helpers](./progress-and-streaming.md), and [`mockFetch`](./testing.md) from `@dipanshuhandoo/fetchforge/testing` for tests.

### Combining them

A typical production client:

```js
import {
  authRefresh, cache, createClient, idempotency, logger, monitor, offlineQueue, rateLimit,
} from '@dipanshuhandoo/fetchforge';
import { redisStore } from '@dipanshuhandoo/fetchforge/stores';

const stats = monitor({ groupBy: 'route' });
const api = createClient({
  baseUrl: 'https://api.example.com',
  retry: { retries: 2 },
  plugins: [
    logger({ sink: pino() }),
    stats,
    cache({ store: redisStore(redis), ttl: 60000, staleWhileRevalidate: 300000 }),
    idempotency(),
    offlineQueue(), // browser apps
    authRefresh({ getToken, refreshToken }),
    rateLimit({ limit: 20, interval: 1000 }),
  ],
});
```

Order matters only for middleware (first registered is outermost); hooks-only plugins (`logger`, `monitor`, `rateLimit`, `bearerAuth`) can go anywhere. The order above is a good default:

- `cache` early, so hits return before the queue, rate limiter, logger and monitor do work (hits use no rate-limit token). Built-in auth plugins still provide a token identity for safe cache partitioning; their request hooks do not run on a hit.
- `idempotency` before `offlineQueue`, though the key is assigned once per call either way.
- `authRefresh` wraps the network call, so a refreshed request goes through retries, rate limiting and hooks again.
## How a plugin is applied

1. `name` is checked: registering the same name twice on a client throws `TypeError`. `extend()` copies the registered names, so a child client cannot re-register an inherited plugin.
2. Hooks are appended after the client's existing hooks, in registration order. Middleware is appended likewise (first registered is outermost).
3. `setup(client)` runs once. Use it to read `client.getConfig()` or to call `client.use()` for dependent plugins.
4. A plugin may return extra methods on the same object (as `monitor` does with `snapshot()` and `cache` with `invalidate()`); fetchforge ignores unknown properties.

Observer hooks (`onSuccess`, `onError`, `onComplete`, `onCircuitStateChange`) can never break a request: their errors go to `onHookError`. Prefer them for anything that is not meant to change the result.

## Writing your own plugin

Write a factory function that returns a plugin, keep state in the closure, and validate options up front.

```js
const requestId = (header = 'x-request-id') => ({
  name: 'requestId',
  hooks: {
    beforeRequest: (request) => {
      if (!request.headers.has(header)) request.headers.set(header, crypto.randomUUID());
    },
  },
});
```

Guidelines:

- **Per attempt or per call?** `beforeRequest` runs on every attempt (retries included); middleware runs once per call.
- **Do not mutate shared state unsafely.** `request` objects are shared between hooks; with dedupe, only the first caller's per-request hooks run, so plugin hooks (client level) are the reliable place for cross-cutting behaviour.
- **Never block the request on slow side effects.** In observer hooks, start the work and handle its errors yourself, or return the promise knowing it is awaited.
- **Clean up.** If a plugin starts timers or connections, expose a `stop()` method (as `monitor`, `rateLimit` and `offlineQueue` do) and `unref` timers.
- **Test it** with [`mockFetch`](./testing.md) as the client's `fetch`, or a local `http` server, as in [`test/plugins.test.ts`](../test/plugins.test.ts).

## Recipes

### Webhook on failure or completion

Notify another system when a request fails, or when a circuit opens. Use observer hooks so a slow or failing webhook never affects the caller.

```js
const webhook = ({ url, secret, events = ['error', 'circuit'] }) => {
  const send = async (type, payload) => {
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-webhook-secret': secret },
      body: JSON.stringify({ type, at: new Date().toISOString(), ...payload }),
      signal: AbortSignal.timeout(3000),
    });
  };
  const fire = (type, payload) => {
    if (events.includes(type)) send(type, payload).catch(() => {});
  };
  return {
    name: 'webhook',
    hooks: {
      onError: (error, request) =>
        fire('error', { url: request.url, method: request.method, code: error.code, message: error.message }),
      onComplete: ({ request, attempts, durationMs, error }) =>
        fire('complete', { url: request.url, attempts, durationMs, ok: !error }),
      onCircuitStateChange: ({ key, from, to }) => fire('circuit', { key, from, to }),
    },
  };
};

const api = createClient({ plugins: [webhook({ url: process.env.ALERT_URL, secret: process.env.ALERT_SECRET })] });
```

Notes: the webhook uses the global `fetch`, not the client, so a failing webhook cannot trigger itself. Keep the secret in the environment, never in source. Runnable: [`plugins.mjs`](../examples/plugins.mjs).

### Rate limiting and caching

Use the built-in [`rateLimit()`](./rate-limiting.md) and [`cache()`](./cache.md) plugins rather than hand-written ones: they handle queueing, `Retry-After`, bounded memory, revalidation, invalidation and shared stores. [`examples/plugins.mjs`](../examples/plugins.mjs) still shows a minimal short-circuit cache to illustrate how middleware can answer without calling `next()`.
### Tracing spans

Start a span in `beforeRequest`, end it in `onComplete`, and read `request.meta` for the parent context. Or let [`monitor({ meter })`](./logging-and-monitoring.md) record OpenTelemetry metrics for you.

## Plugins versus hooks versus middleware

| Use | When |
| --- | --- |
| Hook in `hooks` | One-off behaviour for a single client or request. |
| Middleware | You must wrap or short-circuit the whole call (cache, mock, timing). |
| Plugin | The behaviour is reusable, needs a name, state or setup, or combines hooks and middleware. |

Examples: [`middleware-plugins.mjs`](../examples/middleware-plugins.mjs), [`observability.mjs`](../examples/observability.mjs), [`plugins.mjs`](../examples/plugins.mjs).
