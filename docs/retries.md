# Retries and backoff

Retrying is **off by default**. Enable with `retry: true` (3 retries), `retry: 5` (5 retries) or an options object. "Retries" counts attempts *after* the first, so `retries: 3` means at most 4 attempts.

```js
createClient({
  retry: { retries: 3, delay: 5000, backoff: 'linear' }, // waits 5s, 10s, 15s
});
```

## Options (`RetryOptions`)

| Option | Default | Meaning |
| --- | --- | --- |
| `retries` | `3` | Maximum retries after the first attempt (integer ≥ 0). |
| `delay` | `1000` | Base delay in ms. |
| `backoff` | `'exponential'` | `'fixed'`, `'linear'`, `'exponential'` or a function. See below. |
| `factor` | `2` | Multiplier for exponential backoff (≥ 1). |
| `maxDelay` | `30000` | Cap for the built-in strategies (not applied to a custom function). |
| `jitter` | `0` | Adds a random `0 … jitter × delay` ms (0 to 1) to spread out retry storms. |
| `methods` | `GET HEAD OPTIONS PUT DELETE` | Methods allowed to be retried. `POST` and `PATCH` are excluded because retrying can duplicate side effects. |
| `statusCodes` | `408 425 429 500 502 503 504` | HTTP statuses that may be retried. |
| `retryOnTimeout` | `true` | Retry per-attempt timeouts. |
| `retryOnNetworkError` | `true` | Retry connection failures. |
| `respectRetryAfter` | `true` | Honour the `Retry-After` response header. |
| `maxRetryAfter` | `60000` | If the server asks to wait longer than this, give up instead of waiting. |
| `shouldRetry` | none | `({ error, attempt, request, retryable }) => boolean` final say on the method/status/error rules. |

## Delay strategies

`n` is the retry number (1 for the first retry).

| `backoff` | Delay before retry `n` | With `delay: 5000` |
| --- | --- | --- |
| `'fixed'` | `delay` | 5s, 5s, 5s |
| `'linear'` | `delay × n` | 5s, 10s, 15s |
| `'exponential'` | `delay × factor^(n-1)` | 5s, 10s, 20s (factor 2) |
| `(n, { error, request }) => ms` | your value | anything |

Built-in strategies are capped by `maxDelay`, then jitter is added. A custom function's result is used as-is (negative or non-finite values become 0).

### `Retry-After`

For HTTP errors carrying `Retry-After` (seconds or an HTTP date), the wait becomes `max(computed delay, Retry-After)`. If `Retry-After` exceeds `maxRetryAfter`, retrying stops and the error is thrown. Disable with `respectRetryAfter: false`.

## What is retried

A failed attempt is retried only if **all** of these hold:

1. Retries remain, and the circuit is not open, and the call wasn't aborted, and the total timeout hasn't expired (these are hard stops that `shouldRetry` cannot override).
2. The body is replayable (stream bodies are never retried).
3. The built-in rules say so: the method is in `methods`; for HTTP errors the status is in `statusCodes`; network errors need `retryOnNetworkError`; attempt timeouts need `retryOnTimeout`.
4. `shouldRetry`, if given, returns `true`. It receives the built-in decision as `retryable` so you can extend rather than replace it:

```js
retry: {
  retries: 4,
  shouldRetry: ({ error, retryable }) => retryable || (error.status === 409 && error.data?.transient),
}
```

`ParseError` and non-listed statuses (such as 400, 401, 404) are not retried.

## Hooks and metrics

`beforeRetry` runs before each wait with `{ error, attempt, retriesLeft, delay, request }`. Assign `info.delay` to change the wait, or return `false` to stop retrying (the current error is thrown). `result.attempts` and `error.attempts` report how many attempts ran, and `metrics.retries` counts retries. See [Hooks](./hooks.md).

## Retrying non-idempotent requests

Do it only when the server supports idempotency keys:

```js
await api.post('/payments', undefined, {
  json,
  headers: { 'idempotency-key': key },
  retry: { retries: 2, methods: ['POST'] },
});
```

Example: [`retry-backoff.mjs`](../examples/retry-backoff.mjs).
