# Examples

Every example starts a tiny local server, so they run offline and double as integration tests. They are executed against the packed tarball by `npm run test:package`.

From a clone: `npm run build`, then `node examples/<name>.mjs`. Each file starts with a comment naming its purpose and the matching guide in [`docs/`](../docs/README.md). `_server.mjs` is a shared helper (a local HTTP server), not an example.

## What each example does

**[`full-tour.mjs`](./full-tour.mjs)** (start here). One client configured with timeouts, retries, circuit breaker, dedupe, hooks, middleware, a plugin, custom messages and metrics, used against a deliberately flaky API. Purpose: see how the features combine.

**[`basic.mjs`](./basic.mjs)**. GET, POST with JSON, HEAD, and a non-2xx response becoming `HttpError`. Purpose: the minimum you need day to day. Guide: [requests and responses](../docs/requests-and-responses.md).

**[`request-options.mjs`](./request-options.mjs)**. Query params, response types, JSON bodies, removing an inherited header, reading metrics, and cancelling with `abortAll()`. Purpose: per-request control. Guides: [configuration](../docs/configuration.md), [metrics](../docs/metrics.md).

**[`timeouts.mjs`](./timeouts.mjs)**. A slow endpoint hit by the per-attempt `timeout` and the overall `totalTimeout`, and the `scope` on `TimeoutError`. Purpose: bound how long a call may take. Guide: [timeouts](../docs/timeouts.md).

**[`retry-backoff.mjs`](./retry-backoff.mjs)**. Fixed, linear (5s, 10s, 15s style), exponential and custom delay functions; why POST isn't retried; `shouldRetry`. Purpose: ride out transient failures. Guide: [retries](../docs/retries.md).

**[`circuit-breaker.mjs`](./circuit-breaker.mjs)**. Failures open the circuit, calls are rejected without network traffic, a probe closes it again; manual reset. Purpose: protect a struggling service. Guide: [circuit breaker](../docs/circuit-breaker.md).

**[`dedupe-hedging.mjs`](./dedupe-hedging.mjs)**. Identical concurrent calls become one request; a slow first request is raced by a hedge. Purpose: less load and lower tail latency. Guide: [dedupe and hedging](../docs/dedupe-and-hedging.md).

**[`hooks.mjs`](./hooks.mjs)**. The lifecycle hooks in order, replacing a response or error, stopping retries from `beforeRetry`, and isolation of observer-hook failures. Purpose: logging, tracing, auth, alerting. Guide: [hooks](../docs/hooks.md).

**[`middleware-plugins.mjs`](./middleware-plugins.mjs)**. Middleware, a reusable plugin, `bearerAuth`, and `extend()`. Purpose: reuse behaviour across clients. Guide: [middleware and plugins](../docs/middleware-and-plugins.md).

**[`errors-messages.mjs`](./errors-messages.mjs)**. Error classes and guards, custom message templates, and `throwHttpErrors`. Purpose: precise, friendly error handling. Guide: [errors and messages](../docs/errors-and-messages.md).

**[`bulk.mjs`](./bulk.mjs)**. A batch with a concurrency limit, per-item options and partial failures. Purpose: many calls at once. Guide: [bulk](../docs/bulk.md).

**[`resilience.mjs`](./resilience.mjs)**. Linear retries plus a circuit breaker together. Purpose: a starting point for production defaults. Guides: [retries](../docs/retries.md), [circuit breaker](../docs/circuit-breaker.md).

**[`plugins.mjs`](./plugins.mjs)**. A custom webhook plugin (notifies another system on failures and circuit changes) and a cache plugin, combined with `bearerAuth`. Purpose: shows how to write and combine your own plugins. Guide: [plugins](../docs/plugins.md).

**[`observability.mjs`](./observability.mjs)**. The `logger` plugin (redaction, correlation IDs, retry and failure lines) and the `monitor` plugin (per-route stats, windowed snapshots, periodic flush, OpenTelemetry meter, events, Prometheus text). Purpose: know what your API calls are doing in production. Guide: [logging and monitoring](../docs/logging-and-monitoring.md).
