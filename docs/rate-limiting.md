# Client-side rate limiting

`rateLimit()` keeps a client under an API's quota by queueing requests in a **token bucket per origin**, instead of firing them all and collecting `429 Too Many Requests`. Bursts are released smoothly, server signals (`Retry-After`, `X-RateLimit-*`, `RateLimit-*`) pause the bucket, and you decide whether excess requests wait or fail fast.

```js
import { createClient, rateLimit } from '@dipanshuhandoo/fetchforge';

const github = createClient({
  baseUrl: 'https://api.github.com',
  plugins: [rateLimit({ limit: 10, interval: 1000 })], // 10 req/s, bursts of 10
});

// 500 calls, no 429s: they are released at 10/s.
await Promise.all(repos.map((repo) => github.get(`/repos/${repo}`)));
```

Runnable: [`examples/rate-limit.mjs`](../examples/rate-limit.mjs).

Practical tool: [API data sync/migrator](../examples/tools/api-data-sync/README.md)
combines bounded bulk concurrency with per-origin token buckets; retries consume
quota too.

## How it works

- Each bucket holds up to `limit` tokens and refills continuously at `limit / interval`. A request takes one token; with none left, it waits in a FIFO queue.
- Buckets are keyed by the URL origin by default, so one client talking to several hosts keeps separate budgets. Use `key` to share one budget across hosts, or split per API key/tenant.
- The wait happens in `beforeRequest`, so **every attempt** (including retries and hedges) consumes a token, which is what the server counts.
- With `respectHeaders` (default), a `429`/`503` with `Retry-After`, or `X-RateLimit-Remaining: 0` with `X-RateLimit-Reset` (seconds or epoch seconds), or `RateLimit-Remaining: 0` with `RateLimit-Reset`, pauses the bucket for that long (capped by `maxPause`).
- Aborting a queued request removes it from the queue without using a token.

## Options

| Option | Default | Description |
| --- | --- | --- |
| `limit` | required | Requests per `interval`, also the burst size. |
| `interval` | required | Window in ms. |
| `key` | URL origin | `(request) => string`, bucket per key. |
| `maxQueue` | unlimited | Waiting requests per bucket; more reject with `RateLimitError`. |
| `maxWait` | unlimited | Reject instead of waiting when the estimated wait exceeds this (ms). |
| `respectHeaders` | `true` | Pause on server rate-limit headers. |
| `maxPause` | `60000` | Upper bound for a server-requested pause, ms. |
| `onDelay` | | `({ key, waitMs, queued }) => void`, called when a request has to wait. |

Plugin methods: `state()` returns `{ [key]: { tokens, queued, pausedUntil } }`; `stop()` rejects queued requests with `RateLimitError` and clears timers (call it on shutdown).

## Errors

`RateLimitError` (`code: 'ERR_RATE_LIMIT'`) has `key` and `retryAfter` (ms). It is thrown only by the client-side limiter (`maxQueue`, `maxWait`, `stop()`); a server `429` is still an `HttpError` and is retried by the [retry](./retries.md) policy, which honours `Retry-After`.

```js
const interactive = createClient({ plugins: [rateLimit({ limit: 5, interval: 1000, maxWait: 300 })] });
try {
  await interactive.get('/search', { params: { q } });
} catch (error) {
  if (isRateLimitError(error)) toast(`Too many searches, try again in ${Math.ceil(error.retryAfter / 1000)} s`);
}
```

## Recipes

**Per tenant / API key** in a multi-tenant worker:

```js
rateLimit({ limit: 100, interval: 60000, key: (request) => request.headers.get('x-tenant-id') ?? 'default' });
```

**Bulk jobs.** [`bulk()`](./bulk.md) limits how many requests run at once; `rateLimit()` limits how many start per second. Use both: concurrency protects you, the rate protects the provider.

```js
const client = createClient({ plugins: [rateLimit({ limit: 50, interval: 1000 })] });
await client.bulk(urls, { concurrency: 20 });
```

**With the cache.** Register [`cache()`](./cache.md) first: hits are answered before any token is taken.

## Limits

- The budget is per client instance and per process. For a quota shared by many processes, use a central limiter (Redis, an API gateway); this plugin then smooths each instance's share.
- Time spent waiting in the queue counts toward the per-attempt `timeout`. Raise `timeout` or set `maxWait` for long queues.
- Queued requests keep a Node.js process alive until they are sent or `stop()` is called.
