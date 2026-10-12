# Testing with `mockFetch`

`@dipanshuhandoo/fetchforge/testing` exports `mockFetch()`, a `fetch` replacement for unit tests, Storybook and demos. Pass it as the client's `fetch` option: no server, no network and no global patching, so tests can run in parallel.

```js
import { createClient } from '@dipanshuhandoo/fetchforge';
import { mockFetch } from '@dipanshuhandoo/fetchforge/testing';

const fetch = mockFetch({ baseUrl: 'https://api.test' })
  .get('/users/:id', ({ params }) => ({ json: { id: params.id, name: 'Ada' } }))
  .post('/users', { status: 201, json: { id: '2' } });

const api = createClient({ baseUrl: 'https://api.test', fetch });
```

Runnable with `node:test` (works the same in Vitest or Jest): [`examples/testing.mjs`](../examples/testing.mjs).

Design your code so the client can be injected (a parameter, a factory, or a module you can replace), and create a fresh mock per test.

## Routes

`mock.on(method, pattern, reply, options?)` or the shortcuts `get`, `post`, `put`, `patch`, `delete`, `head` and `any` (every method). All return the mock, so they chain. Routes are checked in the order added; the first match answers.

Patterns:

| Pattern | Matches |
| --- | --- |
| `'/users/:id'` | Path on `baseUrl`'s origin (any origin without `baseUrl`). `:name` captures one segment into `params` (URL-decoded). |
| `'/files/*'` | `*` matches the rest of the path. |
| `'https://cdn.test/a.png'` | Absolute URL: origin and path must match. |
| `'/search?q=fetch'` | Listed query parameters must be present with those values; others are ignored. |
| `/\/v\d+\/users/` | RegExp tested against the full URL; named groups become `params`. |
| `(url, method) => boolean` | Predicate. |

Trailing slashes are optional.

## Replies

A reply is an object, a `Response`, or a function `(info) => reply | Response` (sync or async):

| Field | Description |
| --- | --- |
| `status`, `statusText` | Default `200`, `''`. |
| `headers` | Plain object. |
| `json` | Serialised, sets `Content-Type: application/json`. |
| `text` | Sets `text/plain;charset=UTF-8`. |
| `body` | Any `BodyInit`. |
| `delay` | ms before replying; rejects early if the request is aborted, so timeouts and cancellation are testable. |
| `error` | `'network'` rejects with `TypeError('fetch failed')`, like a dropped connection; or any `Error` to reject with. |

The function receives `info`: `{ url, method, headers, body, json, params, call, signal }`. `body` is the request body as text, `json` its parsed value (or `undefined`), `call` the 1-based count for this route.

**Sequences.** Pass an array to serve replies in order; the last repeats. Ideal for retry tests:

```js
mockFetch().post('https://api.test/jobs', [{ status: 503 }, { error: 'network' }, { status: 201, json: { id: 1 } }]);
```

**Limited routes.** `{ times: n }` answers `n` calls, then the route is skipped and later routes (or `onUnmatched`) apply.

## Assertions

- `mock.calls`: every request received, in order: `{ url, method, headers, body, route }` (`headers` is a lowercase-keyed object; `route` is the index of the matching route, `-1` if unmatched).
- `mock.pending()`: routes with `times` that haven't been used up. Assert it's empty to check every expected call happened.
- `mock.reset()`: removes routes and calls.

```js
assert.deepEqual(fetch.calls.map((c) => `${c.method} ${new URL(c.url).pathname}`), ['GET /users/7']);
assert.equal(fetch.calls[0].headers.authorization, 'Bearer test-token');
assert.deepEqual(JSON.parse(fetch.calls[1].body), { name: 'Ada' });
assert.deepEqual(fetch.pending(), []);
```

## Unmatched requests

`onUnmatched: 'error'` (default) rejects with `mockFetch: no route for GET https://...`, so missing mocks fail loudly. `'passthrough'` sends unmatched requests with the real `fetch` captured when the mock was created, useful for partial mocking in demos.

## Testing plugins and failure handling

Everything above the transport runs for real: retries, timeouts, the circuit breaker, hooks and every plugin.

```js
// Timeouts
const slow = mockFetch().get('https://api.test/slow', { delay: 1000, json: {} });
await assert.rejects(createClient({ fetch: slow, timeout: 20, retry: false }).get('https://api.test/slow'), {
  name: 'TimeoutError',
});

// Cache: the second call must not reach the network
const once = mockFetch().get('https://api.test/config', { json: { theme: 'dark' } }, { times: 1 });
const client = createClient({ fetch: once, plugins: [cache()] });
await client.get('https://api.test/config');
assert.equal((await client.get('https://api.test/config')).cache, 'hit');

// Token refresh: 401 with the old token, 200 with the new one
const auth = mockFetch().any('https://api.test/*', ({ headers }) =>
  headers.get('authorization') === 'Bearer new' ? { json: 'ok' } : { status: 401 },
);
```

Tips:

- Use small `retry.delay` values (`1`) to keep retry tests fast, or `retry: false` where retries aren't under test.
- Call `stop()` on plugins that own timers (`rateLimit`, `offlineQueue`) at the end of a test, and `await cache.whenIdle()` before asserting on background revalidation.
- The mock is a plain function, so it also works with other clients or with `vi.spyOn(globalThis, 'fetch').mockImplementation(mock)` when code calls `fetch` directly.

## Limitations

- Requests never hit a real network stack: no CORS, cookies, redirects, compression or HTTP/2 behaviour. Cover those with integration tests against a local server (see `examples/_server.mjs`).
- Upload progress is reported as the mock reads the body, all at once.
