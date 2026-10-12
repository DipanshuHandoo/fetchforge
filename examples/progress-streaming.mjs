// Progress and streaming: upload/download progress for big transfers, and reading responses as they arrive:
// Server-Sent Events (live updates, LLM token streams), NDJSON (exports, logs) and plain lines.
// Docs: docs/progress-and-streaming.md
import assert from 'node:assert/strict';
import { createClient, iterateLines, iterateNdjson, iterateSse } from '@dipanshuhandoo/fetchforge';
import { startServer } from './_server.mjs';

const file = Buffer.alloc(256 * 1024, 7);
const api = await startServer((req, res) => {
  if (req.url === '/download') {
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(file.length) });
    // Send in chunks so progress is reported several times.
    let offset = 0;
    const tick = () => {
      if (offset >= file.length) return res.end();
      res.write(file.subarray(offset, offset + 32 * 1024));
      offset += 32 * 1024;
      setImmediate(tick);
    };
    return tick();
  }
  if (req.url === '/upload') {
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
    });
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ size }));
    });
    return;
  }
  if (req.url === '/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('event: status\ndata: {"step":"queued"}\nid: 1\n\n');
    res.write(': keep-alive comment\n\n');
    res.write('event: status\ndata: {"step":"running"}\nid: 2\n\n');
    res.write('data: multi-line\ndata: message\n\n');
    return res.end('event: done\ndata: {}\n\n');
  }
  if (req.url === '/export') {
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    for (let i = 1; i <= 3; i++) res.write(`${JSON.stringify({ id: i, sku: `SKU-${i}` })}\n`);
    return res.end();
  }
  if (req.url === '/logs') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    return res.end('boot\r\nready\nserving');
  }
  res.writeHead(404).end();
});

const client = createClient({ baseUrl: api.url, retry: false });

try {
  // 1. Download progress (e.g. a progress bar). total/percent come from Content-Length.
  const downloads = [];
  const download = await client.get('/download', {
    responseType: 'arrayBuffer',
    onDownloadProgress: (p) => downloads.push(p.percent),
  });
  assert.equal(download.data.byteLength, file.length);
  assert.ok(downloads.length > 1);
  assert.equal(downloads.at(-1), 100);
  console.log('download %', downloads.join(' '));

  // 2. Upload progress. Requests that report upload progress use a streamed body (Node.js and Chromium).
  const uploads = [];
  const upload = await client.post('/upload', new Uint8Array(file), {
    onUploadProgress: (p) => uploads.push(p.loaded),
  });
  assert.equal(upload.data.size, file.length);
  assert.equal(uploads.at(-1), file.length);

  // 3. Server-Sent Events: typed events, ids for resuming, multi-line data, comments ignored.
  const events = [];
  for await (const event of iterateSse(await client.get('/events', { responseType: 'stream' }))) {
    events.push(`${event.event}:${event.data}`);
    if (event.event === 'done') break;
  }
  assert.deepEqual(events, [
    'status:{"step":"queued"}',
    'status:{"step":"running"}',
    'message:multi-line\nmessage',
    'done:{}',
  ]);

  // 4. NDJSON: process a large export record by record with constant memory.
  const skus = [];
  for await (const row of iterateNdjson(await client.get('/export', { responseType: 'stream' }))) {
    skus.push(row.sku);
  }
  assert.deepEqual(skus, ['SKU-1', 'SKU-2', 'SKU-3']);

  // 5. Plain lines (CRLF or LF), including a last line without a newline.
  const lines = [];
  for await (const line of iterateLines(await client.get('/logs', { responseType: 'stream' })))
    lines.push(line);
  assert.deepEqual(lines, ['boot', 'ready', 'serving']);

  console.log('progress and streaming example passed');
} finally {
  await api.close();
}
