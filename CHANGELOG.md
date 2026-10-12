# Changelog

All notable changes are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org).

## [Unreleased]

Planned as 1.2.0 (minor: new features, no breaking API changes).

### Added

- `cache()` plugin: HTTP response cache with TTL, stale-while-revalidate, stale-if-error, Cache-Control/Expires/Age, ETag and Last-Modified revalidation (304), `Vary`, shared-cache rules, mutation invalidation, tags, pattern invalidation, per-request overrides, events and stats. See `docs/cache.md`.
- Pluggable stores in the new `@dipanshuhandoo/fetchforge/stores` entry: `memoryStore` (LRU), `redisStore` (ioredis or node-redis, duck-typed), `webStorageStore` (localStorage/sessionStorage), `indexedDbStore`, `cacheBridgeStore` (`@dipanshuhandoo/cache-bridge`); `fileStore` in `@dipanshuhandoo/fetchforge/stores/file` (Node.js). The `Store` interface is public for custom stores.
- `authRefresh()` plugin: single-flight token refresh on 401 with one replay; `AuthError` (`ERR_AUTH`). See `docs/auth-refresh.md`.
- `rateLimit()` plugin: client-side token buckets per origin (or custom key), queueing, `Retry-After`/429 cool-downs; `RateLimitError` (`ERR_RATE_LIMIT`). See `docs/rate-limiting.md`.
- `idempotency()` plugin: `Idempotency-Key` per call, reused across retries and offline replays. See `docs/idempotency.md`.
- `offlineQueue()` plugin: queues mutations while offline or on network errors and replays them in order; persistent stores, cross-tab locking, `QueuedError` (`ERR_QUEUED`). See `docs/offline.md`.
- `schema` option: validates responses with Standard Schema (Zod, Valibot, ArkType, ...), `safeParse`/`parse` objects or functions, with inferred types; `ValidationError` (`ERR_VALIDATION`). See `docs/validation.md`.
- `onDownloadProgress` and `onUploadProgress` options, and `iterateLines`, `iterateNdjson` and `iterateSse` stream helpers. See `docs/progress-and-streaming.md`.
- `mockFetch()` in the new `@dipanshuhandoo/fetchforge/testing` entry: routes with params, reply sequences, delays, network errors, call inspection. See `docs/testing.md`.
- Guards `isValidationError`, `isRateLimitError`, `isAuthError`, `isQueuedError`; message keys `validation`, `rateLimit`, `auth`, `queued`; the `queued` and `cache` fields on `FetchResult`.

### Changed

- Requests carrying an `Idempotency-Key` header are now retryable whatever their method (previously POST/PATCH were only retried when listed in `retry.methods`). Remove the header, or use `retry.shouldRetry`, if an API doesn't honour it.
- With `responseType: 'stream'`, the caller's `signal` now cancels the body after the call returns (as with native `fetch`), and `dedupe` no longer applies to stream requests (a body can only be read once).
- The packed tarball is larger (about 650 KB, mostly source maps) because of the new entries.

### Fixed

- Corrupted characters in `monitor` option documentation (`flushIntervalMs`, `reset()`, `retainMs`).
- Cache entries are partitioned by response type and hashed credentials from request headers and built-in auth plugins; streams bypass the cache. Requests with unpartitioned `beforeRequest` hooks also bypass unless an explicit cache key is provided.
- `authRefresh` now calls `onRefreshFailed` once per shared failed refresh, rather than once per waiting request.
- `offlineQueue.pending()` and queue observer callbacks now receive copies, so mutating returned headers or metadata cannot alter persisted requests.

## [1.1.0] - 2026-10-12

### Added

- `logger` plugin (redacted, correlated, level-filtered request logs) and `monitor` plugin (per-group statistics, latency percentiles, Prometheus export, event stream); see `docs/logging-and-monitoring.md`.
- `monitor` windowed snapshots (`snapshot({ windowMs })`), periodic `onFlush` with `stop()`/`flush()`, and an OpenTelemetry `meter` option.
- Interactive version selection in `npm run release`.

## [1.0.0] - 2026-10-12

### Added

- Detailed documentation in `docs/` (guides for every feature, configuration and API reference) and an annotated examples index.
- `createClient`, `FetchClient`, and the default `fetchforge` client.
- Per-attempt and total timeouts.
- Retries with fixed, linear, exponential and custom backoff, jitter and `Retry-After` support.
- Circuit breaker, request deduplication and request hedging (all opt-in).
- Hooks, middleware and plugins, including `bearerAuth`.
- `bulk()` requests with a concurrency limit via `@dipanshuhandoo/async-slot-pool`.
- Typed errors with configurable messages, and built-in metrics.
- ESM, CommonJS, minified and browser-global builds with TypeScript declarations.

### Changed (versus the unpublished `fetch.service.js`)

- Non-2xx responses throw `HttpError` by default (`throwHttpErrors: false` restores the old behaviour).
- The singleton export is replaced by `createClient` and named exports.
- `Content-Type` is no longer forced on every request.
