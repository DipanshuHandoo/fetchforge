# Changelog

All notable changes are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org).

## [Unreleased]

## [1.0.0] - TBD

### Added

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
