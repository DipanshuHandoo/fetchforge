# Metrics

Each client keeps in-memory counters (no I/O, no timers). Read with `client.getMetrics()`, which returns a snapshot copy; clear with `client.resetMetrics()`.

| Field | Meaning |
| --- | --- |
| `requests` | Calls started (a deduped follower counts) |
| `inFlight` | Calls currently running |
| `succeeded` | Calls that resolved |
| `failed` | Calls that rejected (aborts and timeouts included) |
| `aborted` | Calls ended by abort |
| `timeouts` | Calls ended by a timeout |
| `attempts` | Network attempts made, including retries and hedges |
| `retries` | Retries performed |
| `circuitRejections` | Calls rejected by an open circuit |
| `deduped` | Calls that joined an in-flight call |
| `hedges` | Extra hedge requests launched |
| `statusCodes` | Map of HTTP status to count, for example `{ "200": 12, "503": 2 }` |
| `latency` | `{ count, min, max, avg, last }` in ms, over completed calls (including retry waits) |

```js
const m = api.getMetrics();
console.log(`${m.succeeded}/${m.requests} ok, avg ${m.latency.avg} ms, ${m.retries} retries`);
```

Metrics are per client instance (`extend()` children start at zero). For export to Prometheus, OpenTelemetry or similar, use `onComplete` (per call) or poll `getMetrics()` on an interval you own.

`client.abortAll()` is the related control: it cancels all in-flight requests on the client, which then count as `aborted`.
