# Circuit breaker

## Purpose

When a service is failing, retrying and sending more traffic makes things worse. The circuit breaker watches outcomes per service and, after enough consecutive failures, **rejects calls immediately** (no network request) for a cooldown, then carefully probes recovery.

Off by default. Enable with `circuitBreaker: true` or an options object.

## States

```
 closed ──(failureThreshold consecutive failures)──► open
   ▲                                                   │
   │                                          resetTimeout elapses
   └──(successThreshold successes)── half-open ◄───────┘
                                       │ any failure
                                       └──────────────► open
```

- **closed**: normal. Successes reset the failure count.
- **open**: every call throws `CircuitOpenError` (`key`, `retryAfter` ms until the next probe). Retries stop immediately.
- **half-open**: up to `halfOpenMaxRequests` trial calls are let through; `successThreshold` successes close the circuit, any failure re-opens it.

## Options (`CircuitBreakerOptions`)

| Option | Default | Meaning |
| --- | --- | --- |
| `failureThreshold` | `5` | Consecutive failures that open the circuit. |
| `resetTimeout` | `30000` | ms to stay open before half-open. |
| `halfOpenMaxRequests` | `1` | Concurrent trial calls allowed while half-open. |
| `successThreshold` | `1` | Successes needed in half-open to close. |
| `key` | URL origin | A fixed string, or `({ url, method }) => string`, choosing which circuit a request uses. |
| `isFailure` | built-in rule | `(error) => boolean` decides what counts as a failure. |

The default key is the URL **origin** (`https://api.example.com`), so every path of one service shares a circuit. Key by route, tenant or region with `key`.

## What counts as a failure

Network errors, timeouts (per attempt), HTTP 5xx and 429. Other 4xx responses count as successes (the service is up, the request was bad). Aborts and total timeouts are neutral (they say nothing about the service). Each retry attempt is counted, so retries accelerate opening.

## Observing and controlling

```js
const api = createClient({
  circuitBreaker: { failureThreshold: 3, resetTimeout: 10000 },
  hooks: { onCircuitStateChange: ({ key, from, to }) => log(key, from, to) },
});
api.getCircuitState('https://api.example.com'); // 'closed' | 'open' | 'half-open'
api.resetCircuit('https://api.example.com');    // force closed; no argument resets all
```

`onCircuitStateChange` is a client-level hook (it is not available per request). `getCircuitState` accepts a key or a URL. `metrics.circuitRejections` counts rejected calls.

## Handling the rejection

```js
try { await api.get(url); }
catch (e) {
  if (isCircuitOpenError(e)) return cachedValue ?? retryLater(e.retryAfter);
  throw e;
}
```

Circuits live in memory per client (per process). They are not shared across processes or clients; `extend()` children start with their own.

Example: [`circuit-breaker.mjs`](../examples/circuit-breaker.mjs).
