# Offline queue and replay

`offlineQueue()` keeps mutations that can't reach the server and replays them, in order, when the connection returns. It's for apps where users keep working offline: field and mobile web apps, PWAs, note taking, forms on flaky networks.

```js
import { bearerAuth, createClient, idempotency, isQueuedError, offlineQueue } from '@dipanshuhandoo/fetchforge';

const queue = offlineQueue({
  onQueued: () => showToast('Saved offline. Will sync when you are back online.'),
  onDrop: (item, reason) => reportFailedSync(item, reason),
});
const api = createClient({ baseUrl: '/api', plugins: [bearerAuth(getToken), idempotency(), queue] });

try {
  await api.post('/notes', { text: 'written on the train' });
} catch (error) {
  if (isQueuedError(error)) return; // stored; will be replayed
  throw error;
}
```

Runnable: [`examples/idempotency-offline.mjs`](../examples/idempotency-offline.mjs).

## When a request is queued

A request is queued when its method is in `methods` (POST, PUT, PATCH, DELETE by default) and either:

- `isOnline()` returns `false` before sending (default `navigator.onLine`), or
- it fails and `queueOn(error, request)` returns `true` (default: network errors only, so no response was received).

Requests are **not** queued, and behave normally, when:

- `meta: { offline: false }` is set,
- the body isn't a string. JSON (plain objects/arrays) and text bodies are serialised to strings and can be queued; `FormData`, `Blob` and streams can't be persisted and are sent as usual,
- the queue holds `maxItems` items already.

## What the caller gets

| `mode` | Result |
| --- | --- |
| `'throw'` (default) | Rejects with `QueuedError` (`code: 'ERR_QUEUED'`, `id`). Callers that don't know about the queue don't mistake it for success. |
| `'resolve'` | Resolves a result with `status: 202`, `data: undefined` and `queued: <id>`. Convenient for optimistic UIs. |

## Replay

Replays go through the same client, so hooks and plugins apply: auth headers are added fresh, idempotency keys are reused, the cache invalidates on success. Replay is triggered:

- on the browser `online` event,
- every `replayInterval` ms (default 30 s, `0` disables; the timer is `unref`'d in Node.js),
- when you call `await queue.flush()`.

`flush()` returns `{ sent, dropped, remaining }` and is single-flight. Per item:

| Outcome | Action |
| --- | --- |
| 2xx | Removed, `onReplay(item, result)` |
| Network error | Stop; try again next time |
| 4xx except 408 and 429 | Dropped as `'rejected'` (the server refused it; repeating won't help) |
| Other errors (5xx, 408, 429, timeouts) | `attempts + 1`; dropped as `'max-attempts'` at `maxAttempts` (5) |
| Older than `maxAge` (24 h) | Dropped as `'expired'` without sending |

With `preserveOrder: true` (default) replay stops at the first item that fails, so a later edit never overtakes the create it depends on. Set `false` to skip past failures.

## Persistence and multiple tabs

- Default store: `localStorage` (prefix `fetchforge-offline:`) when available, so the queue survives reloads; otherwise memory. Any [store](./cache.md#stores) works: `store: indexedDbStore()` for larger queues, `fileStore({ dir })` in Node.js.
- Stored per item: URL, method, headers, string body, JSON-serialisable `meta`, timestamps, attempts.
- `authorization`, `cookie` and `proxy-authorization` headers are **not** stored (`omitHeaders`), so credentials never land in storage; your auth hook adds a fresh token on replay.
- When the Web Locks API is available (`navigator.locks`), queue writes are serialised across tabs and only one tab replays at a time.

## Node.js

Node has no `online` event and `navigator.onLine` is not meaningful, so the queue relies on network errors and the replay timer. Call `flush()` when your own connectivity check succeeds, and pass a durable store (e.g. `fileStore`) if the queue must survive restarts.

## Options

| Option | Default | Description |
| --- | --- | --- |
| `store` | localStorage, else memory | Where the queue persists (uses one key, `'queue'`). |
| `methods` | POST, PUT, PATCH, DELETE | Methods that may be queued. |
| `isOnline` | `navigator.onLine` (true when absent) | Checked before sending and before replay. |
| `queueOn` | network errors | `(error, request) => boolean`. |
| `preserveOrder` | `true` | Stop replay at the first failure. |
| `maxItems` | `100` | Beyond this, requests fail normally. |
| `maxAge` | `86400000` | ms; older items are dropped. |
| `maxAttempts` | `5` | Replay attempts before dropping. |
| `replayInterval` | `30000` | ms; `0` disables the timer. |
| `omitHeaders` | authorization, cookie, proxy-authorization | Headers never persisted. |
| `mode` | `'throw'` | `'throw'` or `'resolve'`. |
| `onQueued`, `onReplay`, `onDrop` | | Observers; exceptions are ignored. |

Methods on the returned plugin: `flush()`, `pending()` (copies of queued items), `clear()`, `stop()` (removes the timer and `online` listener).

## Limitations

- Replays happen later, possibly after the data changed on the server. Design endpoints so a late write is safe (idempotency keys, versions/ETags, last-write-wins).
- There's no automatic conflict resolution; handle `onDrop` with `'rejected'` (for example a 409) to tell the user.
- Only the queue lives in storage, not the response; a replayed request's result is reported to `onReplay`, not to the original caller.
