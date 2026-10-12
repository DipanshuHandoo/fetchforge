# Troubleshooting and FAQ

**Nothing is retried.** Retry is opt-in: set `retry`. Also check the method (`POST`/`PATCH` are not retried by default), the status (only 408, 425, 429, 500, 502, 503, 504), and that the body isn't a stream.

**My `POST` was not retried.** By design. See [retrying non-idempotent requests](./retries.md#retrying-non-idempotent-requests).

**`Invalid URL` / `ERR_INVALID_URL` for `/path`.** Relative URLs need `baseUrl` outside browsers.

**`HttpError` on 404 but I want the body.** Read `error.data`, or pass `throwHttpErrors: false` and check `result.ok`.

**Total time exceeds my `timeout`.** `timeout` is per attempt. Use `totalTimeout` for an overall limit.

**`CircuitOpenError` for everything on a host.** The circuit is keyed by origin by default and opened after consecutive failures. Wait `retryAfter` ms, call `resetCircuit()`, or key it more finely with `circuitBreaker.key`. Note that 429 and 5xx count as failures.

**Dedupe returned stale or shared data.** Only in-flight calls are shared and followers get the same object. Don't mutate it, or turn dedupe off for that call with `dedupe: false`.

**`Body is unusable` in `afterResponse`.** Clone first: `response.clone().json()`.

**A hook threw but nothing happened.** Observer hooks (`onSuccess`, `onError`, `onComplete`, `onCircuitStateChange`) are isolated by design; add `onHookError` to see their errors.

**My middleware runs once even with retries.** Middleware wraps the whole call. Use `beforeRequest` for per-attempt logic.

**Aborted request shows `AbortError`, not `TimeoutError`.** `AbortSignal.timeout()` is your signal; use `timeout` or `totalTimeout` to get `TimeoutError`.

**Browser CORS errors appear as `NetworkError`.** Browsers hide CORS details from scripts. Check the console and server headers.

**Self-signed certificates or proxies in Node.** Pass a custom `fetch` (for example one built with undici's `Agent`) via the `fetch` option.

**Which Node versions?** 22 and later. Older versions lack required APIs (`AbortSignal.any`).

**How do I test code that uses fetchforge?** Pass a fake `fetch` in the client config; no network or timers are required. The repository's own tests and [`examples/_server.mjs`](../examples/_server.mjs) show approaches.

**Reporting bugs or vulnerabilities.** Bugs: open a GitHub issue with a minimal reproduction. Vulnerabilities: follow [SECURITY](../SECURITY.md); do not file a public issue.
