# Timeouts and cancellation

Two independent limits plus caller-driven cancellation. All produce typed errors, and all clean up their timers and connections.

## Per-attempt timeout: `timeout`

- Limits **one** attempt, from sending until the body is parsed. Default `60000` ms; `0` disables.
- On expiry the attempt is aborted and fails with `TimeoutError` (`scope: 'attempt'`, `timeout` = the limit).
- It is retryable by default (`retry.retryOnTimeout`), so with retries each attempt gets a fresh `timeout`.

```js
const api = createClient({ timeout: 5000 });
await api.get('/slow', { timeout: 20000 }); // per-request override
```

## Total timeout: `totalTimeout`

- Limits the **whole call**: every attempt plus every wait between attempts. Default none.
- On expiry, in-flight work and any backoff wait are aborted and the call fails with `TimeoutError` (`scope: 'total'`). A total timeout is **never retried**.
- Use it as a deadline for the user-visible operation; use `timeout` as the budget for one try.

```js
createClient({ timeout: 2000, totalTimeout: 10000, retry: 5 });
// at most 10s overall, however many retries are left
```

## Cancellation: `signal`, `abortAll()`

```js
const controller = new AbortController();
const pending = api.get('/x', { signal: controller.signal });
controller.abort();            // rejects with AbortError (ERR_ABORTED)
```

- A signal that is already aborted rejects immediately without sending.
- Aborting stops retries and backoff waits. It does **not** count as a circuit-breaker failure.
- `AbortSignal.timeout(ms)` is treated as the caller's signal, so it surfaces as `AbortError`; use `timeout` / `totalTimeout` if you want `TimeoutError`.
- `client.abortAll()` aborts every request in flight on that client (handy on shutdown).
- With `dedupe`, the shared call is aborted only when **all** callers have aborted.

## Choosing values

| Situation | Suggestion |
| --- | --- |
| Interactive UI call | `timeout` 3000–10000, `totalTimeout` ≈ what the user will wait |
| Background job with retries | moderate `timeout`, generous `totalTimeout` or none |
| File upload or download | raise or disable `timeout` (`0`), rely on `signal` |

Examples: [`timeouts.mjs`](../examples/timeouts.mjs), [`request-options.mjs`](../examples/request-options.mjs) (`abortAll`).
