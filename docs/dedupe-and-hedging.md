# Deduplication and hedging

## Deduplication (`dedupe`)

**Purpose:** if the same request is already in flight, new callers join it instead of making another network call. Typical cause: several components asking for the same resource at once.

Off by default. Enable with `dedupe: true` or options.

| Option | Default | Meaning |
| --- | --- | --- |
| `methods` | `GET`, `HEAD` | Methods eligible for dedupe. |
| `key` | method + URL + headers + response type | `(request) => string` custom identity. |

Behaviour:

- Only **in-flight** calls are shared. When it settles, the entry is removed (this is not a cache).
- Followers receive the **same result object** (treat it as read-only) or the same error.
- Only the first caller's per-request hooks run. The shared call is aborted only when **all** callers abort; a single caller's `signal` just detaches that caller.
- `metrics.deduped` counts joined calls.

Different headers (for example another `Authorization`) produce different keys, so users are never mixed up. If your `key` ignores headers, make sure results don't differ by caller.

## Hedging (`hedging`)

**Purpose:** reduce tail latency. If the first request hasn't answered after a delay, send a duplicate; the first success wins and the rest are cancelled. Use only for safe, idempotent reads, and expect extra load on the server.

Off by default. `hedging: true`, `hedging: 150` (delay in ms) or options.

| Option | Default | Meaning |
| --- | --- | --- |
| `delay` | `200` | ms to wait before each extra request. Set near your p95 latency. |
| `maxHedges` | `1` | Extra requests beyond the first. |
| `methods` | `GET`, `HEAD`, `OPTIONS` | Methods that may be hedged. |

Notes:

- If a request fails before the delay passes, the next hedge starts immediately. The call fails only when every request has failed, and the last error is reported.
- Not applied to stream responses or stream request bodies.
- Hedges happen *within* an attempt; they count in `metrics.hedges` and `metrics.attempts`.
- Hedging composes with retries (each retry attempt may be hedged) and with the circuit breaker.

Example: [`dedupe-hedging.mjs`](../examples/dedupe-hedging.mjs).
