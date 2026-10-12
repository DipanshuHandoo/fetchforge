# API uptime and SLO monitor

A small endpoint probe, not a hosted monitoring platform. Check once for cron/CI,
or run a simple nonoverlapping loop. Fetchforge supplies bulk concurrency,
timeouts/retries, optional response schemas, logger, monitor and circuit breaker.

## Run

From the repository root:

```sh
npm run build
node examples/tools/api-uptime-monitor/index.mjs --demo
node examples/tools/api-uptime-monitor/index.mjs --demo --watch
```

The offline demo includes failing, slow and invalid-schema endpoints, so its
one-shot **exit code is 1**. Stop watch mode with Ctrl+C.

Edit `input.mjs`, then run without `--demo`:

```js
export const input = {
  endpoints: [
    { name: 'health', url: 'https://api.example.com/health', expectedStatuses: [200] },
    {
      name: 'contract',
      url: 'https://api.example.com/version',
      expectedStatuses: [200],
      schema(value) {
        if (typeof value?.version !== 'string') throw new Error('Expected version');
        return value;
      },
    },
  ],
  intervalMs: 60_000,
  windowMs: 300_000,
  maxSamples: 1000,
  availabilityTarget: 99,
  latencyTarget: 95,
  maxLatencyMs: 1000,
  timeout: 5000,
  webhook: process.env.UPTIME_WEBHOOK_URL ?? '',
};
```

Empty endpoints select the demo; `--demo` forces it. Endpoint names and URLs must
be unique. Default expected status is 200. An endpoint may override `maxLatencyMs`.
Use environment variables for webhook credentials, not hardcoded tokens or URL
query secrets. HTTP(S) URL credentials are rejected. This example assumes public
probe endpoints; add authentication explicitly in `client.mjs` for private APIs.

## Read the example

| File | Responsibility |
| --- | --- |
| `input.mjs` | Endpoints, schemas, SLO thresholds, interval and webhook. |
| `index.mjs` | One-shot/watch mode and shutdown cleanup. |
| `client.mjs` | `logger()`, `monitor()`, circuit breaker, retry and separate alert client. |
| `monitor.mjs` | `client.bulk(..., { concurrency: 5 })`, rolling health and alert transitions. |
| `report.mjs` | Latest-cycle CSV and JSON summary. |
| `demo.mjs`, `smoke.mjs` | Local endpoints/webhook and integration checks. |

Console callbacks show `[beforeRequest]`, `[beforeRetry]`, `[monitor]`,
`[circuit]`, `[bulk]`, `[alert]` and `[cycle]`.

## Health, SLOs and alerts

A probe is healthy when its final status is expected and any configured schema
passes. An expected 404 is healthy; an unexpected 200 is not. Schemas use
fetchforge's `schema` option and apply to successful HTTP responses, not error
bodies. Without a schema the body is discarded.

Availability is the percentage of healthy final probes. Latency compliance is
the percentage of all probes that are both healthy and within their latency
threshold. Durations include retry waits. The last `windowMs` and at most
`maxSamples` per endpoint are retained; sample counts are included in reports.
Restarting resets history. These are **observed probe SLOs**, not a production SLA
or traffic-weighted latency measurement. `monitor()` metrics separately retain
HTTP failure rates/latency; they do not understand your expected-status policy.

An endpoint alerts when currently unhealthy **or** its rolling SLOs are below
target; recovery alerts wait for both to become healthy. An initial healthy probe
does not alert. An unchanged condition does not repeatedly alert.

Webhook JSON contains `endpoint`, `state` (`unhealthy`/`recovered`), probe outcome,
latency and SLO values. Delivery uses a separate client with one POST retry.
This is at-least-once notification: a lost acknowledgement can cause duplicates.
Delivery failures are logged and left pending for the next cycle, not marked sent.
Without a webhook the same transition is logged locally.

Circuit breakers isolate each URL. Expected error statuses do not trip their
circuit; exhausted transient failures can open it. Open-circuit rejections count
as unhealthy observations; recovery probes occur after the reset interval.
Retries can conceal brief transient outages, deliberately measuring final-probe
availability; monitor retry counts show those incidents.

## Reports and lifecycle

Ignored `reports/checks.csv` and `reports/summary.json` contain the latest cycle,
SLO sample counts/percentages, library metrics and alert delivery errors. Each
cycle overwrites them; no durable historical storage is provided.
`FETCHFORGE_EXAMPLE_REPORT_DIR` can redirect test output.

One-shot exits 1 for unhealthy/SLO-failing probes or alert/report errors; otherwise
0. Watch mode finishes a whole cycle, including alerts/reports, before waiting
`intervalMs` and starting the next. Endpoint/alert failures do not stop watch mode;
configuration/report-writing failures do. SIGINT/SIGTERM abort work and stop timers.

For real alerting, supervise this process or schedule one-shot runs externally.
There is no distributed scheduler, persistent alert state, dashboard or durable
event queue. Do not expose endpoint configuration to untrusted users.

```sh
node examples/tools/api-uptime-monitor/smoke.mjs
```
