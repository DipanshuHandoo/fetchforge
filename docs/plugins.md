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

| Plugin | Purpose | Options | Guide |
| --- | --- | --- | --- |
| `bearerAuth(token, options?)` | Adds an `Authorization` header on every attempt. The token may be a string or a (possibly async) function, so refreshed tokens apply to retries. | `header`, `scheme` | [middleware and plugins](./middleware-and-plugins.md#built-in-plugin-bearerauth) |
| `logger(options?)` | Structured, redacted request logs with correlation IDs, retry, failure, slow-request and circuit lines. Works with console, pino or winston. | `sink`, `level`, `slowThreshold`, `requestIdHeader`, `redactHeaders`, `redactParams`, `logHeaders` | [logging and monitoring](./logging-and-monitoring.md#loggeroptions) |
| `monitor(options?)` | Per-group statistics: counts, error codes, latency percentiles, rolling windows, periodic flush, OpenTelemetry meter, Prometheus text. | `groupBy`, `buckets`, `maxGroups`, `retainMs`, `sliceMs`, `flushIntervalMs`, `onFlush`, `meter`, `onEvent` | [logging and monitoring](./logging-and-monitoring.md#monitoroptions) |

All three are optional and dependency-free; they only use hooks, so they never change a request's outcome.

```js
import { bearerAuth, createClient, logger, monitor } from '@dipanshuhandoo/fetchforge';

const stats = monitor({ groupBy: 'route' });
const api = createClient({
  plugins: [bearerAuth(() => tokens.get()), logger({ sink: pino() }), stats],
});
```

## How a plugin is applied

1. `name` is checked: registering the same name twice on a client throws `TypeError`. `extend()` copies the registered names, so a child client cannot re-register an inherited plugin.
2. Hooks are appended after the client's existing hooks, in registration order. Middleware is appended likewise (first registered is outermost).
3. `setup(client)` runs once. Use it to read `client.getConfig()` or to call `client.use()` for dependent plugins.
4. A plugin may return extra methods on the same object (as `monitor` does with `snapshot()`); fetchforge ignores unknown properties.

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
- **Clean up.** If a plugin starts timers or connections, expose a `stop()` method (as `monitor` does) and `unref` timers.
- **Test it** with a local `http` server and a custom `fetch`, as in [`test/observability.test.ts`](../test/observability.test.ts).

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

### Rate-limit awareness

```js
const rateLimit = () => {
  let resumeAt = 0;
  return {
    name: 'rateLimit',
    hooks: {
      afterResponse: (response) => {
        const remaining = Number(response.headers.get('x-ratelimit-remaining'));
        const reset = Number(response.headers.get('x-ratelimit-reset'));
        if (remaining === 0 && reset) resumeAt = reset * 1000;
      },
    },
    middleware: async (_ctx, next) => {
      const wait = resumeAt - Date.now();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      return next();
    },
  };
};
```

### Response cache (short-circuit middleware)

```js
const cache = (ttlMs) => {
  const entries = new Map();
  return {
    name: 'cache',
    middleware: async ({ request }, next) => {
      if (request.method !== 'GET') return next();
      const hit = entries.get(request.url);
      if (hit && hit.expires > Date.now()) return hit.result;
      const result = await next();
      entries.set(request.url, { result, expires: Date.now() + ttlMs });
      return result;
    },
  };
};
```

Unbounded maps grow forever: add a size cap or use an LRU in real code.

### Tracing spans

Start a span in `beforeRequest`, end it in `onComplete`, and read `request.meta` for the parent context. Or let [`monitor({ meter })`](./logging-and-monitoring.md) record OpenTelemetry metrics for you.

## Plugins versus hooks versus middleware

| Use | When |
| --- | --- |
| Hook in `hooks` | One-off behaviour for a single client or request. |
| Middleware | You must wrap or short-circuit the whole call (cache, mock, timing). |
| Plugin | The behaviour is reusable, needs a name, state or setup, or combines hooks and middleware. |

Examples: [`middleware-plugins.mjs`](../examples/middleware-plugins.mjs), [`observability.mjs`](../examples/observability.mjs), [`plugins.mjs`](../examples/plugins.mjs).
