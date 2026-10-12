# Bulk requests

**Purpose:** run many requests with a concurrency limit, collecting every outcome without one failure aborting the rest. Scheduling is done by [`@dipanshuhandoo/async-slot-pool`](https://www.npmjs.com/package/@dipanshuhandoo/async-slot-pool).

```js
const summary = await api.bulk(
  ['/users/1', '/users/2', { url: '/orders', params: { limit: 5 }, retry: 2 }],
  { concurrency: 3, onProgress: (p) => console.log(`${p.done}/${p.total}`) },
);
```

## Input

An iterable of requests. A request is a URL string, or `{ url, ...RequestOptions }` (any option, including `method`, `json`, `retry`, `signal`). Each runs through the normal pipeline, so retries, circuit breaker, dedupe, hooks and metrics all apply per request.

## Options (`BulkOptions`)

| Option | Default | Meaning |
| --- | --- | --- |
| `concurrency` | `5` | Maximum requests in flight at once. |
| `stopOnError` | `false` | On the first failure, stop starting new requests. Remaining ones are `skipped`; requests already running finish. |
| `signal` | none | Aborts the batch: running requests are cancelled and unstarted ones are `skipped`. A request's own `signal` takes precedence for that request. |
| `onProgress` | none | `({ done, total, succeeded, failed }) => void` after each request settles. |

## Result (`BulkResult`)

| Field | Meaning |
| --- | --- |
| `results` | One entry per input, **in input order** |
| `fulfilled`, `rejected`, `skipped` | Counts |
| `total` | Number of inputs |
| `aborted` | `true` if the batch was stopped early (signal or `stopOnError`) |
| `durationMs` | Wall-clock time of the batch |

Each entry: `{ index, request, status: 'fulfilled' | 'rejected' | 'skipped', result?, error? }`. `result` is a normal `FetchResult`; `error` is the typed error.

`bulk()` itself does not reject because individual requests failed; inspect `summary.rejected` or filter `results`. It rejects only for invalid arguments.

```js
const failures = summary.results.filter((r) => r.status === 'rejected');
```

Example: [`bulk.mjs`](../examples/bulk.mjs).

Runnable tools: [HTTP status checker](../examples/tools/http-status-checker/README.md),
[sitemap auditor](../examples/tools/sitemap-auditor/README.md),
[uptime monitor](../examples/tools/api-uptime-monitor/README.md), and
[cursor API migrator](../examples/tools/api-data-sync/README.md). All use built-in
`bulk()` concurrency rather than a custom worker pool.
