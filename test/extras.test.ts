import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type TransferProgress,
  createClient,
  isQueuedError,
  isValidationError,
  iterateLines,
  iterateNdjson,
  iterateSse,
  offlineQueue,
} from '../src/index.ts';
import { memoryStore } from '../src/stores.ts';
import { mockFetch } from '../src/testing.ts';
import { readBody, startServer, wait } from './helpers.ts';

const BASE = 'https://api.test';

const streamOf = (...chunks: string[]) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  });

test('schema: Standard Schema, safeParse, parse and plain functions transform data', async () => {
  const mock = mockFetch({ baseUrl: BASE }).get('/user', { json: { id: '7', name: 'Ada' } });
  const client = createClient({ baseUrl: BASE, fetch: mock });

  const standard = {
    '~standard': {
      version: 1 as const,
      vendor: 'test',
      validate: (value: unknown) => ({ value: { ...(value as object), checked: true } }),
    },
  };
  assert.deepEqual((await client.get('/user', { schema: standard })).data, {
    id: '7',
    name: 'Ada',
    checked: true,
  });

  const safe = {
    safeParse: (value: unknown) => ({ success: true, data: Number((value as { id: string }).id) }),
  };
  assert.equal((await client.get('/user', { schema: safe })).data, 7);

  const parse = { parse: async (value: unknown) => (value as { name: string }).name };
  assert.equal((await client.get('/user', { schema: parse })).data, 'Ada');

  const fn = (value: unknown) => Object.keys(value as object).length;
  assert.equal((await client.get('/user', { schema: fn })).data, 2);

  const configured = createClient({ baseUrl: BASE, fetch: mock, schema: fn });
  assert.equal((await configured.get('/user')).data, 2, 'schema can be a client default');
});

test('schema: failures raise ValidationError with issues, path and the raw data; not retried', async () => {
  const mock = mockFetch({ baseUrl: BASE }).get('/user', { json: { id: 7 } });
  const client = createClient({ baseUrl: BASE, fetch: mock, retry: { retries: 3, delay: 1 } });

  const standard = {
    '~standard': {
      version: 1 as const,
      vendor: 'test',
      validate: () => ({
        issues: [
          { message: 'Expected string', path: ['id'] },
          { message: 'Required', path: [{ key: 'profile' }, 'name'] },
        ],
      }),
    },
  };
  await assert.rejects(client.get('/user', { schema: standard }), (error) => {
    assert.ok(isValidationError(error));
    assert.equal(error.code, 'ERR_VALIDATION');
    assert.equal(error.issues.length, 2);
    assert.deepEqual(error.data, { id: 7 });
    assert.equal(error.status, 200);
    assert.match(error.message, /id: Expected string; profile\.name: Required/);
    return true;
  });
  assert.equal(mock.calls.length, 1);

  const zodLike = {
    safeParse: () => ({ success: false, error: { issues: [{ message: 'bad', path: [] }] } }),
  };
  await assert.rejects(client.get('/user', { schema: zodLike }), /bad/);
  const throwing = () => {
    throw new Error('nope');
  };
  await assert.rejects(client.get('/user', { schema: throwing }), (error) => {
    assert.ok(isValidationError(error));
    assert.deepEqual(error.issues, [{ message: 'nope' }]);
    return true;
  });
  const many = {
    safeParse: () => ({
      success: false,
      error: { issues: [1, 2, 3, 4, 5].map((n) => ({ message: `e${n}` })) },
    }),
  };
  await assert.rejects(client.get('/user', { schema: many }), /e1; e2; e3 \(\+2 more\)/);
  assert.throws(() => createClient({ schema: 42 as never }), /schema/);
});

test('download progress reports bytes, total and percent', async () => {
  const payload = 'x'.repeat(200000);
  const server = await startServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain', 'content-length': String(payload.length) });
    res.end(payload);
  });
  try {
    const events: TransferProgress[] = [];
    const client = createClient({ baseUrl: server.url });
    const result = await client.get('/', { onDownloadProgress: (p) => events.push(p) });
    assert.equal(result.data, payload);
    const last = events.at(-1);
    assert.deepEqual(last, { loaded: payload.length, total: payload.length, percent: 100 });
    assert.ok(events.length >= 1);
    assert.ok(events.every((e, i) => i === 0 || e.loaded >= (events[i - 1]?.loaded ?? 0)));
  } finally {
    await server.close();
  }
});

test('download progress without content-length reports an unknown total until the end', async () => {
  const mock = mockFetch({ baseUrl: BASE }).get('/s', () => new Response(streamOf('ab', 'cd')));
  const events: TransferProgress[] = [];
  const client = createClient({ baseUrl: BASE, fetch: mock });
  assert.equal(
    (await client.get('/s', { responseType: 'text', onDownloadProgress: (p) => events.push(p) })).data,
    'abcd',
  );
  assert.deepEqual(events, [
    { loaded: 2, total: undefined, percent: undefined },
    { loaded: 4, total: undefined, percent: undefined },
    { loaded: 4, total: 4, percent: 100 },
  ]);
});

test('upload progress streams JSON and FormData bodies with the right content type', async () => {
  const server = await startServer(async (req, res) => {
    const body = await readBody(req);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({ type: req.headers['content-type'], length: body.length, body: body.slice(0, 20) }),
    );
  });
  try {
    const client = createClient({ baseUrl: server.url });
    const events: TransferProgress[] = [];
    const big = { blob: 'y'.repeat(150000) };
    const result = await client.post<{ type: string; length: number }>('/', big, {
      onUploadProgress: (p) => events.push(p),
    });
    const size = JSON.stringify(big).length;
    assert.equal(result.data.length, size);
    assert.equal(result.data.type, 'application/json');
    assert.ok(events.length >= 3, 'chunked into 64 KiB pieces');
    assert.deepEqual(events.at(-1), { loaded: size, total: size, percent: 100 });

    const form = new FormData();
    form.set('file', new Blob(['hello']), 'a.txt');
    const formEvents: TransferProgress[] = [];
    const sent = await client.post<{ type: string }>('/', form, {
      onUploadProgress: (p) => formEvents.push(p),
    });
    assert.match(sent.data.type, /^multipart\/form-data; boundary=/);
    assert.equal(formEvents.at(-1)?.percent, 100);
  } finally {
    await server.close();
  }
});

test('iterateLines handles \\n, \\r\\n, \\r, split chunks, multibyte characters and early exit', async () => {
  const lines: string[] = [];
  for await (const line of iterateLines(streamOf('a\nb\r', '\nc\rd', '\u00e9\n\nlast'))) lines.push(line);
  assert.deepEqual(lines, ['a', 'b', 'c', 'd\u00e9', '', 'last']);

  const bytes = new TextEncoder().encode('\u20ac\n');
  const split = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes.slice(0, 1));
      controller.enqueue(bytes.slice(1));
      controller.close();
    },
  });
  for await (const line of iterateLines(split)) assert.equal(line, '\u20ac');

  let cancelled = false;
  const endless = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new TextEncoder().encode('tick\n'));
    },
    cancel() {
      cancelled = true;
    },
  });
  for await (const line of iterateLines(endless)) {
    assert.equal(line, 'tick');
    break;
  }
  assert.ok(cancelled, 'breaking out cancels the stream');
  await assert.rejects(iterateLines({} as never).next(), /Expected a ReadableStream/);
});

test('iterateNdjson and iterateSse with client results and Responses', async () => {
  const mock = mockFetch({ baseUrl: BASE })
    .get('/ndjson', () => new Response(streamOf('{"a":1}\n\n{"a"', ':2}\n')))
    .get(
      '/sse',
      () =>
        new Response(
          streamOf(
            '\uFEFF: comment\nretry: 1500\nid: 1\ndata: hello\n\n',
            'event: update\ndata: line1\ndata: line2\n\n',
            'data\nid\n\n',
            'data: unterminated',
          ),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
    );
  const client = createClient({ baseUrl: BASE, fetch: mock });
  const rows: unknown[] = [];
  for await (const row of iterateNdjson(await client.get('/ndjson', { responseType: 'stream' })))
    rows.push(row);
  assert.deepEqual(rows, [{ a: 1 }, { a: 2 }]);

  const events = [];
  for await (const event of iterateSse(await mock('https://api.test/sse'))) events.push(event);
  assert.deepEqual(events, [
    { event: 'message', data: 'hello', id: '1', retry: 1500 },
    { event: 'update', data: 'line1\nline2', id: '1', retry: undefined },
    { event: 'message', data: '', id: '', retry: undefined },
  ]);
  await assert.rejects(async () => {
    for await (const _ of iterateLines(new Response(null))) {
      // unreachable
    }
  }, /no body/);
});

test('offlineQueue: queues while offline and replays in order when back online', async () => {
  let online = false;
  const store = memoryStore();
  const mock = mockFetch({ baseUrl: BASE }).post('/notes', ({ json }) => ({ status: 201, json }));
  const queued: string[] = [];
  const replayed: string[] = [];
  const plugin = offlineQueue({
    store,
    isOnline: () => online,
    replayInterval: 0,
    onQueued: (item) => queued.push(item.id),
    onReplay: (item) => replayed.push(item.id),
  });
  const client = createClient({
    baseUrl: BASE,
    fetch: mock,
    headers: { authorization: 'Bearer secret' },
    plugins: [plugin],
  });

  await assert.rejects(client.post('/notes', { n: 1 }, { meta: { trace: 'a' } }), (error) => {
    assert.ok(isQueuedError(error));
    assert.equal(error.id, queued[0]);
    return true;
  });
  await assert.rejects(client.post('/notes', { n: 2 }), (error) => isQueuedError(error));

  const pending = await plugin.pending();
  assert.equal(pending.length, 2);
  assert.equal(pending[0]?.headers.authorization, undefined, 'credentials are never persisted');
  assert.deepEqual(pending[0]?.meta, { trace: 'a' });
  assert.deepEqual(await plugin.flush(), { sent: 0, dropped: 0, remaining: 2 }, 'still offline');

  online = true;
  assert.deepEqual(await plugin.flush(), { sent: 2, dropped: 0, remaining: 0 });
  assert.deepEqual(replayed, queued);
  const posts = mock.calls.filter((c) => c.method === 'POST');
  assert.deepEqual(
    posts.map((c) => c.body),
    ['{"n":1}', '{"n":2}'],
  );
  assert.equal(posts[0]?.headers.authorization, 'Bearer secret', 'fresh credentials on replay');
  plugin.stop();
});

test('offlineQueue: pending and observer callbacks cannot mutate queued request data', async () => {
  const store = memoryStore();
  const online = false;
  const plugin = offlineQueue({
    store,
    isOnline: () => online,
    replayInterval: 0,
    onQueued(item) {
      item.headers['x-origin'] = 'callback mutation';
      if (item.meta) item.meta.trace = 'callback mutation';
    },
  });
  const client = createClient({
    baseUrl: BASE,
    fetch: mockFetch({ baseUrl: BASE }),
    plugins: [plugin],
  });
  await client
    .post('/writes', 'payload', {
      headers: { 'x-origin': 'caller' },
      meta: { trace: 'original' },
    })
    .catch(() => {});

  const [first] = await plugin.pending();
  assert.equal(first?.headers['x-origin'], 'caller');
  assert.equal(first?.meta?.trace, 'original');
  if (first) {
    first.headers['x-origin'] = 'pending mutation';
    if (first.meta) first.meta.trace = 'pending mutation';
  }
  const [again] = await plugin.pending();
  assert.equal(again?.headers['x-origin'], 'caller');
  assert.equal(again?.meta?.trace, 'original');
  plugin.stop();
});

test('offlineQueue: network failures queue (resolve mode); 4xx drop; 5xx retry up to maxAttempts', async () => {
  const mock = mockFetch({ baseUrl: BASE })
    .post('/flaky', [{ error: 'network' }, { status: 201 }])
    .post('/bad', [{ error: 'network' }, { status: 422 }])
    .post('/down', [{ error: 'network' }, { status: 503 }]);
  const drops: string[] = [];
  const plugin = offlineQueue({
    store: memoryStore(),
    mode: 'resolve',
    maxAttempts: 2,
    preserveOrder: false,
    replayInterval: 0,
    onDrop: (_item, reason) => drops.push(reason),
  });
  const client = createClient({ baseUrl: BASE, fetch: mock, plugins: [plugin] });
  const result = await client.post('/flaky', 'text body');
  assert.equal(result.status, 202);
  assert.equal(typeof result.queued, 'string');
  await client.post('/bad', '{}');
  await client.post('/down', '{}');
  assert.equal((await plugin.pending()).length, 3);

  assert.deepEqual(await plugin.flush(), { sent: 1, dropped: 1, remaining: 1 });
  assert.equal((await plugin.pending())[0]?.attempts, 1);
  assert.deepEqual(await plugin.flush(), { sent: 0, dropped: 1, remaining: 0 });
  assert.deepEqual(drops, ['rejected', 'max-attempts']);
  plugin.stop();
});

test('offlineQueue: maxItems, maxAge, opt-out, stream bodies and stop on a network error', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000000 });
  let online = false;
  const mock = mockFetch({ baseUrl: BASE }).post('/x', { status: 204 });
  const plugin = offlineQueue({
    store: memoryStore(),
    isOnline: () => online,
    maxItems: 1,
    maxAge: 1000,
    replayInterval: 0,
  });
  const client = createClient({ baseUrl: BASE, fetch: mock, plugins: [plugin] });

  await assert.rejects(client.post('/x', '1'), (error) => isQueuedError(error));
  assert.equal((await client.post('/x', '2')).status, 204, 'full queue falls through to the network');
  assert.equal((await client.post('/x', '3', { meta: { offline: false } })).status, 204);
  assert.equal((await client.post('/x', new Blob(['b']))).status, 204, 'non-string bodies are not queued');

  t.mock.timers.tick(2000);
  online = true;
  assert.deepEqual(await plugin.flush(), { sent: 0, dropped: 1, remaining: 0 }, 'expired items are dropped');

  online = false;
  const down = mockFetch({ baseUrl: BASE }).post('/x', { error: 'network' });
  const stopping = offlineQueue({ store: memoryStore(), isOnline: () => online, replayInterval: 0 });
  const other = createClient({ baseUrl: BASE, fetch: down, plugins: [stopping] });
  await other.post('/x', '1').catch(() => {});
  await other.post('/x', '2').catch(() => {});
  online = true;
  assert.deepEqual(
    await stopping.flush(),
    { sent: 0, dropped: 0, remaining: 2 },
    'a network error stops the drain',
  );
  await stopping.clear();
  assert.deepEqual(await stopping.pending(), []);
  stopping.stop();
  plugin.stop();
});

test('offlineQueue: background replay on the interval timer', async () => {
  let online = false;
  const mock = mockFetch({ baseUrl: BASE }).post('/x', { status: 204 });
  const plugin = offlineQueue({ store: memoryStore(), isOnline: () => online, replayInterval: 20 });
  const client = createClient({ baseUrl: BASE, fetch: mock, plugins: [plugin] });
  await client.post('/x', '1').catch(() => {});
  online = true;
  for (let i = 0; i < 50 && (await plugin.pending()).length > 0; i++) await wait(10);
  assert.equal((await plugin.pending()).length, 0);
  assert.equal(mock.calls.length, 1);
  plugin.stop();
});
