# Getting started

## Install

```sh
npm install @dipanshuhandoo/fetchforge
```

- Node.js **22 or later** (uses global `fetch`, `Headers`, `AbortSignal.any`).
- Browsers: bundle the ESM build, or load the global build (`FetchForge`) from `@dipanshuhandoo/fetchforge/browser` (also on unpkg / jsDelivr).
- One runtime dependency: [`@dipanshuhandoo/async-slot-pool`](https://www.npmjs.com/package/@dipanshuhandoo/async-slot-pool), used by `bulk()`.

| Import | Gives you |
| --- | --- |
| `import … from '@dipanshuhandoo/fetchforge'` | ESM, readable build |
| `require('@dipanshuhandoo/fetchforge')` | CommonJS, readable build |
| `…/min` | Minified ESM / CommonJS |
| `…/browser` | Minified IIFE exposing `window.FetchForge` |

TypeScript declarations ship in the package for both ESM and CommonJS consumers.

## First request

```js
import { createClient } from '@dipanshuhandoo/fetchforge';

const api = createClient({ baseUrl: 'https://api.example.com', timeout: 5000 });

const { data, status } = await api.get('/users/1');
const created = await api.post('/users', undefined, { json: { name: 'Ada' } });
```

Non-2xx responses **throw** an `HttpError` (change with `throwHttpErrors`). The body is parsed for you (`responseType: 'auto'`).

## Turning features on

Nothing retries, hedges, deduplicates or trips a circuit unless you ask:

```js
const api = createClient({
  baseUrl: 'https://api.example.com',
  timeout: 5000,
  retry: { retries: 3, delay: 5000, backoff: 'linear' }, // waits 5s, 10s, 15s
  circuitBreaker: true,
  dedupe: true,
});
```

## How a request flows

```
api.get(url, options)
 └─ merge client defaults + request options, validate
    └─ middleware chain (outermost first)
       └─ dedupe: join an identical in-flight call, or start one
          └─ total timeout + abort registry
             └─ retry loop  ◄───────────────┐
                └─ circuit breaker check    │ wait (backoff / Retry-After)
                   └─ beforeRequest hooks   │ after beforeRetry hooks
                      └─ fetch (optionally hedged, per-attempt timeout)
                         └─ afterResponse hooks → parse body → HttpError?
                            ├─ success → onSuccess → result
                            └─ failure → retry? ──yes──┘
                                         └ no → beforeError → onError → throw
                                         (onComplete always runs last)
```

Consequences worth knowing:

- **Middleware wraps everything**, including retries and dedupe. It runs once per call, not once per attempt.
- **`beforeRequest` runs on every attempt**, so auth tokens can refresh on retries.
- **The circuit breaker is consulted on every attempt**; once it opens, retrying stops at once.
- **Dedupe followers share one execution**; only the first caller's hooks run.

## Client lifecycle

- `createClient(config)` makes an independent client with its own circuits, dedupe table and metrics.
- `fetchforge` is a ready-made default client with no config.
- `client.extend(config)` creates a child that inherits the parent's settings and plugins, with its own state.
- Nothing is global and no timers are left running, so there is no `close()`. Use `client.abortAll()` to cancel in-flight work on shutdown.

Continue with the [configuration reference](./configuration.md) or run [`examples/full-tour.mjs`](../examples/full-tour.mjs).
