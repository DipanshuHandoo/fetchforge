# Progress and streaming

Report upload and download progress for large transfers, and read responses as they arrive: Server-Sent Events (live updates, LLM token streams), NDJSON (exports, logs) and plain lines.

Runnable: [`examples/progress-streaming.mjs`](../examples/progress-streaming.mjs).

## Download progress

```js
const { data } = await api.get('/exports/report.zip', {
  responseType: 'blob',
  onDownloadProgress: ({ loaded, total, percent }) => bar.update(percent ?? loaded),
});
```

`TransferProgress` is `{ loaded, total, percent }`:

- `loaded`: bytes received so far.
- `total`: from `Content-Length`, or `undefined` when the server doesn't send it or the body is compressed (`Content-Encoding` other than `identity`, because the decoded body is larger than the header says). The final event always has `total` set to the bytes received.
- `percent`: 0 to 100 when `total` is known, otherwise `undefined` until the final event, which reports `100`.

The callback runs per chunk, and once more at the end if needed. Works in every runtime with `fetch` streams, for every `responseType`. Exceptions thrown by the callback don't fail the request; they're reported to `onHookError` hooks with the name `'onDownloadProgress'` (or `'onUploadProgress'`).

## Upload progress

```js
await api.post('/uploads', file, {
  onUploadProgress: ({ percent }) => bar.update(percent),
  timeout: 0, // large uploads: rely on totalTimeout or a signal instead
});
```

The body (string, `Blob`/`File`, `FormData`, `URLSearchParams`, buffers, JSON) is serialised once per attempt and sent as a stream in 64 KB chunks. `total` is the serialised size; for `FormData` the multipart `Content-Type` with its boundary is set for you. A body that is already a `ReadableStream` or async iterable is counted as it flows (`total` unknown).

**Runtime support.** Streaming request bodies require `duplex: 'half'`, which fetchforge sets:

| Runtime | Support |
| --- | --- |
| Node.js 22+ (undici), Deno, Bun | Yes |
| Chromium-based browsers | Yes, over **HTTP/2 or HTTP/3** only. HTTP/1.1 requests fail with a `TypeError`. |
| Firefox, Safari | Not supported at the time of writing; the request fails. |

Streamed bodies are sent with chunked transfer encoding and no `Content-Length`; some servers and proxies (for example S3 presigned PUTs) reject that. Only set `onUploadProgress` where the target supports it; for browsers that don't, use `XMLHttpRequest` for that upload.

Requests with a stream body are not retried (the stream can only be read once); serialisable bodies are re-serialised per attempt and can be.

## Streaming responses

`responseType: 'stream'` returns as soon as headers arrive, with `data` set to the body `ReadableStream`. `timeout` and `totalTimeout` cover the wait for headers, not the body, so long-lived streams aren't cut off. The caller's `signal` keeps working after the call returns: aborting it cancels the body, as with native `fetch`.

```js
import { iterateLines, iterateNdjson, iterateSse } from '@dipanshuhandoo/fetchforge';
```

Each helper accepts a `FetchResult` from a `'stream'` request, a `Response`, or a `ReadableStream`. They're async generators: `break`, `return` or a thrown error cancels the underlying stream, so connections aren't leaked.

### Server-Sent Events

```js
const controller = new AbortController();
const result = await api.get('/jobs/42/events', {
  responseType: 'stream',
  headers: { accept: 'text/event-stream' },
  signal: controller.signal,
});
for await (const event of iterateSse(result)) {
  if (event.event === 'progress') render(JSON.parse(event.data));
  if (event.event === 'done') break;
}
```

Yields `{ event, data, id, retry }` following the HTML spec: `event` defaults to `'message'`, multiple `data:` lines are joined with `\n`, comments (`: keep-alive`) are skipped, `id` persists across events, a leading BOM is ignored, and an unterminated event at EOF is discarded.

Unlike `EventSource`, this works with POST bodies and custom headers (typical for LLM APIs) and goes through your hooks and plugins. It doesn't reconnect by itself; to resume, send the last `id` as `Last-Event-ID` on a new request.

### NDJSON / JSON Lines

```js
const result = await api.get('/exports/orders', { responseType: 'stream' });
for await (const order of iterateNdjson(result)) {
  await db.orders.upsert(order); // constant memory, however large the export
}
```

Blank lines are skipped; an invalid line throws `SyntaxError` and cancels the stream.

### Lines

`iterateLines(source)` yields UTF-8 lines split on `\n`, `\r\n` or `\r` (including a `\r\n` split across chunks), and the last line even without a trailing newline.

## Interaction with other features

- `schema` validation doesn't run and `cache()` doesn't store `'stream'` responses. If a URL is also fetched normally through `cache()`, pass `meta: { cache: false }` on the stream request so a cached copy isn't served as parsed data.
- `onDownloadProgress` works with `'stream'` too; progress is reported as you consume the stream.
- `dedupe` and hedging never apply to `'stream'` requests (a body can only be read once).
