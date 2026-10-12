# Logging and monitoring

Two optional plugins, both dependency-free. They only use hooks, so they never change a request's outcome: a failing log sink or `onEvent` callback is swallowed.

```js
import { createClient, logger, monitor } from '@dipanshuhandoo/fetchforge';

const stats = monitor({ groupBy: 'route' });
const api = createClient({ plugins: [logger({ level: 'info' }), stats] });
```

## `logger(options)`

**Purpose:** structured, safe, correlatable request logs.

| Option | Default | Meaning |
| --- | --- | --- |
| `sink` | `console` | Any object with `debug`, `info`, `warn`, `error` methods taking `(message, fields)`. Works with console, pino, winston, or your own. Missing methods are skipped. |
| `level` | `'info'` | Minimum level: `'debug'`, `'info'`, `'warn'`, `'error'` or `'silent'`. |
| `slowThreshold` | `0` (off) | Completed requests taking at least this many ms are logged at `warn` and marked "(slow)". |
| `logHeaders` | `false` | Include request headers (redacted) in `debug` and error lines. |
| `redactHeaders` | none | Extra header names to redact. Always redacted: `authorization`, `cookie`, `set-cookie`, `proxy-authorization`, `x-api-key`. |
| `redactParams` | none | Extra query parameter names to redact. Always redacted: `token`, `access_token`, `api_key`, `apikey`, `key`, `password`, `secret`, `signature`, `sig`. URL credentials (`user:pass@`) are always removed. |
| `requestIdHeader` | `'x-request-id'` | Header carrying a correlation ID. A caller-supplied value is reused; otherwise a UUID is generated and sent. `false` disables IDs. |

What is logged:

| Event | Level | Message and fields |
| --- | --- | --- |
| Each attempt starts | `debug` | `GET url attempt n`; `requestId`, `method`, `url`, `attempt`, optional `headers` |
| A retry is scheduled | `warn` | `retrying GET url in 100ms`; `attempt`, `retriesLeft`, `delay`, `code`, `reason` |
| Success | `info` (`warn` if slow, or if a non-2xx resolved because `throwHttpErrors` is off) | `GET url -> 200 in 35ms`; `status`, `attempts`, `durationMs` |
| Final failure | `error` | `GET url failed after 3 attempt(s): message`; `code`, `status`, `attempts`, `durationMs` |
| Circuit change | `warn` when it opens, otherwise `info` | `circuit "key" closed -> open`; `key`, `from`, `to` |
| A hook of yours threw | `warn` | `hook "name" threw: message` |

Every request line carries the same `requestId` across all of its attempts, also available to your own hooks as `request.meta.requestId`.

```js
import pino from 'pino';
const log = pino();
createClient({
  plugins: [logger({
    sink: { debug: (m, f) => log.debug(f, m), info: (m, f) => log.info(f, m), warn: (m, f) => log.warn(f, m), error: (m, f) => log.error(f, m) },
    slowThreshold: 2000,
  })],
});
```

Note: pino puts the object first, so adapt as above. `console`, winston and similar accept `(message, fields)` directly.

## `monitor(options)`

**Purpose:** statistics for dashboards and alerts, richer than the client's global `getMetrics()`: broken down per group, with error codes and latency percentiles.

| Option | Default | Meaning |
| --- | --- | --- |
| `groupBy` | `'origin'` | How requests are bucketed: `'origin'` (scheme + host), `'route'` (origin + path, numeric ids, UUIDs and long hex segments become `:id`), or `({ url, method }) => string`. |
| `buckets` | `5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000` | Latency histogram upper bounds in ms (strictly ascending, positive). |
| `maxGroups` | `500` | Limit on distinct groups to bound memory; extra groups are merged into `__other__`. |
| `onEvent` | none | Receives every event (below), for forwarding to OpenTelemetry, StatsD, Datadog and so on, without bundling their SDKs. |

The returned plugin also has methods:

| Method | Returns |
| --- | --- |
| `snapshot({ windowMs }?)` | Without arguments, all-time statistics. With `windowMs` (at most `retainMs`), only the last `windowMs`, giving real rates such as the last minute's error rate and p95. `{ groups, circuits }`. Each group has `requests`, `succeeded`, `failed`, `attempts`, `retries`, `errors` (by code), `statusCodes`, and `latency: { count, sum, min, max, avg, p50, p95, p99 }`. Circuits map key to `{ state, opened }`. |
| `toPrometheus(prefix = 'fetchforge')` | Prometheus text: `<prefix>_requests_total{group,outcome}`, `_errors_total{group,code}`, `_retries_total`, `_request_duration_ms` histogram (`_bucket`, `_sum`, `_count`), `_circuit_open_total{key}`. |
| `flush()` | Calls `onFlush` now. |
| `stop()` | Stops the flush timer; collection continues. Call it on shutdown. |
| `reset()` | Clears everything. |

Events passed to `onEvent`:

| `type` | Fields |
| --- | --- |
| `'request'` | `group`, `method`, `url`, `ok`, `status?`, `code?`, `attempts`, `durationMs` |
| `'retry'` | `group`, `attempt`, `delay`, `code?` |
| `'circuit'` | `key`, `from`, `to` |

Notes:

- Percentiles come from the histogram, so they are accurate to the bucket. Pick buckets around your latency targets.
- A request counts as failed if it threw, or if a non-2xx response resolved with `throwHttpErrors: false`.
- Latency includes retry waits. With `dedupe`, calls that joined an in-flight request are not counted separately.
- Keep `url` out of `groupBy` functions unless the values are bounded; unbounded labels are what `maxGroups` guards against.

Push stats to a database and read the last minute:

```js
const stats = monitor({
  groupBy: 'route',
  flushIntervalMs: 60000,
  onFlush: ({ interval, at }) => db.collection('fetch_stats').insertOne({ at, interval }),
  onFlushError: (error) => console.error('stats flush failed', error),
});
// later
const lastMinute = stats.snapshot({ windowMs: 60000 });
```

Send to OpenTelemetry:

```js
import { metrics } from '@opentelemetry/api';
monitor({ meter: metrics.getMeter('fetchforge') });
```

Expose Prometheus metrics from your own server:

```js
http.createServer((req, res) => {
  if (req.url === '/metrics') return res.end(stats.toPrometheus('myapp'));
}).listen(9100);
```

## Logger versus monitor versus `getMetrics()`

| Need | Use |
| --- | --- |
| Human-readable trail of what happened and why | `logger` |
| Per-service or per-route dashboards, SLOs, alerts | `monitor` |
| A quick global counter set, no plugin | `client.getMetrics()` (see [Metrics](./metrics.md)) |
| Custom tracing spans | Your own [hooks](./hooks.md) or the monitor's `onEvent` |

Example: [`observability.mjs`](../examples/observability.mjs).

Runnable tool: [API uptime and SLO monitor](../examples/tools/api-uptime-monitor/README.md).
It keeps expected-status/schema health separate from `monitor()` HTTP metrics,
calculates bounded rolling probe SLOs, and sends transition alerts.
