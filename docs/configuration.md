# Configuration reference

The same options object is accepted by `createClient(config)`, `client.extend(config)` and every request (`client.get(url, options)`). Client config adds `plugins`; request options add `method`, `body`, `json` and `signal`.

## All options

| Option | Type | Default | Purpose |
| --- | --- | --- | --- |
| `baseUrl` | `string` | none | Prefix for relative URLs. Absolute request URLs ignore it. Required for relative URLs outside browsers. |
| `headers` | `Headers`, `[k, v][]`, or object | none | Default headers. A `null`/`undefined` value **removes** a header set by an outer layer. |
| `params` | `URLSearchParams` or object | none | Query string. Arrays repeat the key, `Date` becomes ISO, `null`/`undefined` are skipped. |
| `timeout` | `number` (ms) | `60000` | Limit for **each attempt**. `0` disables. See [Timeouts](./timeouts.md). |
| `totalTimeout` | `number` (ms) | `0` (none) | Limit for the **whole call**, including retries and waits. |
| `responseType` | `'auto' \| 'json' \| 'text' \| 'blob' \| 'arrayBuffer' \| 'formData' \| 'stream' \| 'none'` | `'auto'` | How `result.data` is produced. |
| `throwHttpErrors` | `boolean \| (status) => boolean` | `true` | `false` (or a predicate returning `false`) resolves non-2xx responses with `result.error` set. |
| `retry` | `boolean \| number \| RetryOptions` | off | See [Retries](./retries.md). A number means "this many retries". |
| `circuitBreaker` | `boolean \| CircuitBreakerOptions` | off | See [Circuit breaker](./circuit-breaker.md). |
| `dedupe` | `boolean \| DedupeOptions` | off | See [Dedupe and hedging](./dedupe-and-hedging.md). |
| `hedging` | `boolean \| number \| HedgingOptions` | off | A number means "hedge delay in ms". |
| `hooks` | `Hooks` | none | See [Hooks](./hooks.md). |
| `middleware` | `Middleware \| Middleware[]` | none | See [Middleware](./middleware-and-plugins.md). |
| `messages` | `Partial<Messages>` | built-in | Override error messages. See [Errors and messages](./errors-and-messages.md). |
| `fetch` | `typeof fetch` | `globalThis.fetch` | Custom implementation (tests, proxies, instrumentation). |
| `meta` | `Record<string, unknown>` | none | Data copied onto `request.meta` for hooks and middleware. |
| `plugins` | `Plugin[]` | none | Client config only. |
| any `RequestInit` field | | none | `credentials`, `cache`, `mode`, `redirect`, `referrer`, `keepalive`, `integrity`, `priority` and so on are passed straight to `fetch`. |

Request-only options: `method`, `body` (plain objects and arrays are sent as JSON), `json` (always JSON-encoded, sets `Content-Type`), `signal` (an `AbortSignal`).

## Merge rules (client defaults, then request options)

| Kind | Rule |
| --- | --- |
| Scalars (`timeout`, `baseUrl`, `responseType`, `fetch`, `RequestInit` fields) | The request value replaces the client value. |
| `headers` | Merged by name; the request wins; `null` removes. |
| `params` | Client and request params are combined (appended). |
| `meta`, `messages` | Shallow-merged; the request wins. |
| `hooks`, `middleware` | **Appended**: client hooks run first, then request hooks. |
| `retry`, `circuitBreaker`, `dedupe`, `hedging` | `true` enables with defaults (or keeps the inherited options); `false` disables an inherited feature for this call; an object or number is merged field by field over the inherited options. |

Example: the client has `retry: { retries: 3, delay: 5000 }` and a request passes `retry: { delay: 100 }`. That call makes up to 3 retries, 100 ms apart. A request passing `retry: false` makes a single attempt.

## Validation

Options are validated **before any network call**, and invalid values reject with a `TypeError` or `RangeError`. Examples: a negative or non-finite `timeout`; a non-integer `retry.retries`; `retry.jitter` outside 0 to 1; `retry.factor` below 1; an unknown `retry.backoff` string; `circuitBreaker.failureThreshold` below 1; an unknown `responseType`; a non-function `fetch`, hook or middleware; a `signal` that is not an `AbortSignal`. A plugin without a unique `name` is rejected.

## Defaults at a glance

| Area | Default |
| --- | --- |
| Timeout | 60000 ms per attempt, no total timeout |
| Retry (when enabled) | 3 retries, 1000 ms, exponential ×2, capped at 30000 ms, jitter 0, idempotent methods only, statuses 408 425 429 500 502 503 504, retries timeouts and network errors, honours `Retry-After` up to 60000 ms |
| Circuit breaker (when enabled) | opens after 5 consecutive failures, stays open 30000 ms, 1 trial request, 1 success to close, keyed by URL origin |
| Dedupe (when enabled) | `GET` and `HEAD`; key is method + URL + headers + response type |
| Hedging (when enabled) | 200 ms delay, 1 extra request, `GET`/`HEAD`/`OPTIONS` |
| Bulk | concurrency 5 |
| `Accept` header | `application/json, text/plain, */*` when you don't set one |
