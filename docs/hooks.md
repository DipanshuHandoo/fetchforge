# Hooks

Hooks let you run your own code at defined points of a request. Pass them as a function or an array of functions in `hooks`, on the client, on a request, or in a plugin. Hooks from the client run first, then the request's (see [merge rules](./configuration.md#merge-rules-client-defaults-then-request-options)). Every hook may be `async` and is awaited.

## Order of events

```
beforeRequest ─► fetch ─► afterResponse ─┬─ success ─► onSuccess ─┐
      ▲                                  └─ failure ─► retry? ────┤
      └──────── beforeRetry (wait) ◄──── yes                      │
                                         no ─► beforeError ─► onError ─► onComplete ◄─┘
```

## Reference

| Hook | When | Arguments | Return value | Failure behaviour |
| --- | --- | --- | --- | --- |
| `beforeRequest` | Before **every attempt** | `request` (`url`, `method`, `headers`, `body`, `attempt`, `meta`) | none. Mutate `request` (for example set headers) | Throwing rejects the request |
| `afterResponse` | After each response arrives, before the body is read and before HTTP errors are raised | `response`, `request` | Optionally a replacement `Response` | Throwing fails the attempt |
| `beforeRetry` | Before waiting for the next attempt | `{ error, attempt, retriesLeft, delay, request }` | `false` stops retrying; assign `info.delay` to change the wait | Throwing fails the request |
| `beforeError` | Once, when the call finally fails | `error`, `request` | Optionally a replacement `Error` | Throwing replaces the error with the thrown one |
| `onSuccess` | Once, on success | `result`, `request` | ignored | Isolated (see below) |
| `onError` | Once, on final failure (the error is the one that will be thrown) | `error`, `request` | ignored | Isolated |
| `onComplete` | Always last: success or failure (a `finally`) | `{ request, result?, error?, attempts, durationMs }` | ignored | Isolated |
| `onCircuitStateChange` | A circuit changes state | `{ key, from, to }` | ignored | Isolated. **Client-level only** |
| `onHookError` | An observer hook threw | `error`, `hookName` | ignored | Errors here are swallowed |

Notes:

- **Observer hooks** (`onSuccess`, `onError`, `onComplete`, `onCircuitStateChange`) can never change or break the request. Their exceptions (and rejected promises) go to `onHookError`.
- `afterResponse` receives the live `Response`; call `response.clone()` before reading its body, otherwise parsing fails.
- `beforeError` is skipped when `throwHttpErrors` lets a non-2xx response resolve (there is no thrown error). `onSuccess` runs instead and `result.error` is set.
- `request.attempt` is the 1-based attempt number; `request.meta` is the `meta` option.
- With dedupe, only the first caller's per-request hooks run for a shared call.
- Hook arguments that are objects (`request`) are shared; mutating them in `beforeRequest` changes what is sent.

## Typical uses

| Need | Hook |
| --- | --- |
| Add an auth token / correlation ID to every attempt | `beforeRequest` |
| Log retries, add jitter, or stop retrying on a condition | `beforeRetry` |
| Capture rate-limit headers, replace a response | `afterResponse` |
| Wrap errors in your own domain error | `beforeError` |
| Send metrics, trace spans, webhooks, alerts | `onSuccess` / `onError` / `onComplete` |
| Alert when a service is cut off | `onCircuitStateChange` |
| Log failures of your own hooks | `onHookError` |

```js
const api = createClient({
  hooks: {
    beforeRequest: (req) => req.headers.set('x-request-id', crypto.randomUUID()),
    beforeRetry: ({ attempt, delay, error }) => console.warn(`retry after attempt ${attempt} in ${delay}ms: ${error.message}`),
    onComplete: ({ request, attempts, durationMs, error }) => report(request.url, attempts, durationMs, !error),
    onHookError: (err, name) => console.error(`hook ${name} failed`, err),
  },
});
```

For hooks that should be reusable, package them as a [plugin](./middleware-and-plugins.md).

Example: [`hooks.mjs`](../examples/hooks.mjs).
