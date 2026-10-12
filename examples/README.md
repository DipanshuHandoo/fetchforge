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

**[`plugins.mjs`](./plugins.mjs)**. A custom webhook plugin (notifies another system on failures and circuit changes) and a minimal illustrative cache plugin, combined with `bearerAuth`. Purpose: shows how to write and combine your own plugins (for real caching use `cache()` below). Guide: [plugins](../docs/plugins.md).

**[`observability.mjs`](./observability.mjs)**. The `logger` plugin (redaction, correlation IDs, retry and failure lines) and the `monitor` plugin (per-route stats, windowed snapshots, periodic flush, OpenTelemetry meter, events, Prometheus text). Purpose: know what your API calls are doing in production. Guide: [logging and monitoring](../docs/logging-and-monitoring.md).

**[`cache.mjs`](./cache.mjs)**. The `cache()` plugin end to end: TTL, stale-while-revalidate, `Cache-Control`, ETag revalidation with 304s, stale-if-error during an outage, private/no-store responses, per-request bypass and reload, invalidation after mutations, tags, pattern invalidation and stats. Purpose: cut latency and load for read-heavy APIs. Guide: [response cache](../docs/cache.md).

**[`cache-stores.mjs`](./cache-stores.mjs)**. The same cache on different stores: two "pods" sharing Redis (`shared: true`), `@dipanshuhandoo/cache-bridge`, `localStorage`, a file store for CLIs, and an in-memory LRU with `clone`. Uses in-memory stand-ins for Redis, cache-bridge and localStorage so it runs anywhere; the comments show the real wiring. Purpose: choose and plug in a store. Guide: [stores](../docs/cache.md#stores).

**[`auth-refresh.mjs`](./auth-refresh.mjs)**. An expiring access token: concurrent 401s trigger one refresh, requests are replayed with the new token, and a failed refresh surfaces as `AuthError` (sign the user out). Purpose: silent session renewal. Guide: [auth refresh](../docs/auth-refresh.md).

**[`rate-limit.mjs`](./rate-limit.mjs)**. A token bucket keeping a burst under a third-party quota, per-origin buckets, `Retry-After` pauses, and `maxWait` for interactive calls. Purpose: never trip a provider's rate limit. Guide: [rate limiting](../docs/rate-limiting.md).

**[`idempotency-offline.mjs`](./idempotency-offline.mjs)**. A payment POST retried safely after a lost response (charged once), business idempotency keys, and an offline queue that stores writes and replays them in order with their keys. Purpose: safe writes on unreliable networks. Guides: [idempotency](../docs/idempotency.md), [offline queue](../docs/offline.md).

**[`validation.mjs`](./validation.mjs)**. Response validation with a Standard Schema (what Zod, Valibot and ArkType implement) and a `safeParse` object; a contract change raises `ValidationError` with field paths. No schema library required. Purpose: catch API contract drift at the boundary. Guide: [validation](../docs/validation.md).

**[`progress-streaming.mjs`](./progress-streaming.mjs)**. Download and upload progress, Server-Sent Events, NDJSON and line streams. Purpose: progress bars, live updates, large exports with constant memory. Guide: [progress and streaming](../docs/progress-and-streaming.md).

**[`testing.mjs`](./testing.mjs)**. Unit tests with `mockFetch` under `node:test`: route params, reply sequences for retries, network errors, timeouts, testing the cache plugin, and unmatched requests. Purpose: test code that uses fetchforge without a server. Guide: [testing](../docs/testing.md).

## Tools

Small runnable tools built on the public API, each in its own folder under [`tools/`](./tools) with a README and an offline `smoke.mjs` test (also run against the packed tarball).

**[`tools/http-status-checker`](./tools/http-status-checker/README.md)**. `sequential.mjs` checks URLs one by one; `bulk.mjs` uses built-in `client.bulk()` with concurrency 5. Both report statuses, redirect chains and final URLs to CSV in ignored `reports/`. Edit `input.mjs`, pass URLs as arguments, or use `--demo` for 50 local URLs. Client configuration shows retries, cache, logger, monitor and labelled hook output.

**[`tools/sitemap-auditor`](./tools/sitemap-auditor/README.md)**. Reads a local/remote sitemap or sitemap index and reuses the status checker. Optional one-level HTML link checks find broken internal/outbound links. Bounded XML/HTML reads, discovery errors, CSV reports and coverage summary. XML/HTML parser dependencies install only inside this example.

**[`tools/api-uptime-monitor`](./tools/api-uptime-monitor/README.md)**. One-shot or nonoverlapping interval probes with expected statuses and optional schemas, rolling in-memory availability/latency SLOs, monitor metrics, endpoint circuit breakers and unhealthy/recovery webhook alerts.

**[`tools/api-data-sync`](./tools/api-data-sync/README.md)**. Pages through a cursor API, transforms records and bulk POSTs them with auth refresh, rate limits and stable idempotency keys. Checkpoints completed pages only; stops on failure and resumes the interrupted page. Safe replay requires destination-side idempotency.

Each new tool has editable `input.mjs`, a thin `index.mjs`, visible client/plugin setup,
local `--demo`, ignored reports, and an offline smoke test. The auditor and monitor
demos deliberately include unhealthy URLs and exit 1; their smoke tests assert this.
