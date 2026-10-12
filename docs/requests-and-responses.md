# Requests and responses

## Methods

| Method | Signature |
| --- | --- |
| `get`, `head`, `options`, `delete` | `(url, options?)` |
| `post`, `put`, `patch` | `(url, body?, options?)` |
| `request` | `(url, options)` where `options.method` defaults to `GET` |

`CONNECT`, `TRACE` and `TRACK` are rejected. Method names are upper-cased. Generic helpers take a result type: `api.get<User>('/users/1')`.

## URLs

- Absolute URLs (`https://…`) are used as-is.
- Relative URLs are joined to `baseUrl` (duplicate slashes at the join are removed). Without `baseUrl` they work only in browsers (resolved against `location`); elsewhere they reject with `RequestError` (`ERR_INVALID_URL`).
- Query `params` are appended to the URL: arrays repeat the key (`{tag: ['a','b']}` gives `?tag=a&tag=b`), `Date` values become ISO strings, `null` and `undefined` are skipped. Existing query strings in the URL are kept.

## Request bodies

| You pass | Sent as |
| --- | --- |
| `json: value` | `JSON.stringify(value)` plus `Content-Type: application/json` (unless you set one) |
| `body: {…}` or `[…]` | Same as `json` |
| `body: string / FormData / URLSearchParams / Blob / ArrayBuffer / typed array` | Passed to `fetch` unchanged |
| `body: ReadableStream` or an async iterable | Streamed. Such requests are **never retried or hedged**, because the stream cannot be replayed |

Passing both `body` and `json`, or any body on `GET`/`HEAD`, throws a `TypeError`.

## Headers

Set on the client and/or per request as an object, `Headers` or `[name, value][]`. Names are case-insensitive. A `null`/`undefined` value deletes a header inherited from an outer layer:

```js
const api = createClient({ headers: { 'x-app': 'demo' } });
await api.get('/x', { headers: { 'x-app': null } }); // sent without x-app
```

`Accept: application/json, text/plain, */*` is added when you set none. No `Content-Type` is forced on requests without a body.

## Response parsing (`responseType`)

| Value | `result.data` |
| --- | --- |
| `'auto'` (default) | Chosen from the response: `HEAD`, `204`, `205`, `304` → `undefined`; JSON content type → parsed JSON (empty body → `undefined`); text, XML, form, no content type or unknown → string; image, audio, video, font, PDF, zip, octet-stream → `Blob` |
| `'json'` | Parsed JSON (invalid JSON throws `ParseError`) |
| `'text'` | String |
| `'blob'`, `'arrayBuffer'`, `'formData'` | The matching body type |
| `'stream'` | The `ReadableStream` (not consumed; you read it). Never retried or hedged for the body |
| `'none'` | `undefined`; the body is not read |

For error responses (non-2xx) parsing is forgiving: invalid JSON falls back to the raw text and unreadable bodies give `undefined`, so you still get an `HttpError` with `status` instead of a `ParseError`.

## The result object

Every successful call resolves to a `FetchResult<T>`:

| Field | Meaning |
| --- | --- |
| `data` | Parsed body (see above) |
| `ok` | `true` for 2xx |
| `status`, `statusText` | From the final response |
| `headers` | Response headers as a plain lower-cased object |
| `url`, `method` | The request that was made (`baseUrl` and `params` applied) |
| `redirected`, `redirectInfo` | `{ wasRedirected, finalUrl, originalUrl }` |
| `response` | The underlying `Response` (body already consumed unless `responseType: 'stream'`) |
| `error` | `null`, or the `HttpError` when `throwHttpErrors` let a non-2xx response resolve |
| `attempts` | How many attempts were made (1 when nothing was retried) |
| `durationMs` | Total time including retry waits |

## Non-2xx responses

By default any non-2xx status rejects with `HttpError` (`status`, `statusText`, `headers`, `data`, `response`). Alternatives:

```js
await api.get('/x', { throwHttpErrors: false });                 // never throw; inspect result.ok / result.error
await api.get('/x', { throwHttpErrors: (s) => s >= 500 });       // throw only for 5xx
```

When an HTTP error is *not* thrown, `beforeError` hooks are skipped, `onSuccess` runs, and the failure still counts toward retry and circuit decisions (a 5xx is retried before being returned).

## Redirects and other fetch options

Redirects follow `fetch`'s `redirect` option (`'follow'` by default). `credentials`, `cache`, `mode`, `keepalive` and the other `RequestInit` fields work unchanged. Examples: [`request-options.mjs`](../examples/request-options.mjs), [`basic.mjs`](../examples/basic.mjs).
