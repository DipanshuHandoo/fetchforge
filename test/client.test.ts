import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HttpError, ParseError, RequestError, createClient, isHttpError } from '../src/index.ts';
import { json, readBody, startServer } from './helpers.ts';

test('GET parses JSON and returns the full result shape', async () => {
  const server = await startServer((_req, res) => json(res, 200, { hello: 'world' }));
  try {
    const client = createClient({ baseUrl: server.url });
    const result = await client.get<{ hello: string }>('/x');
    assert.deepEqual(result.data, { hello: 'world' });
    assert.equal(result.ok, true);
    assert.equal(result.status, 200);
    assert.equal(result.method, 'GET');
    assert.equal(result.attempts, 1);
    assert.equal(result.error, null);
    assert.equal(result.headers['content-type'], 'application/json');
    assert.equal(result.redirectInfo.wasRedirected, false);
    assert.ok(result.durationMs >= 0);
  } finally {
    await server.close();
  }
});

test('POST sends plain objects as JSON, GET sends no content-type', async () => {
  let seen: { method?: string; type?: string; body: string; accept?: string } | undefined;
  let getType: string | undefined;
  const server = await startServer(async (req, res) => {
    if (req.method === 'GET') {
      getType = req.headers['content-type'];
      return json(res, 200, {});
    }
    seen = {
      method: req.method,
      type: req.headers['content-type'],
      body: await readBody(req),
      accept: req.headers.accept,
    };
    json(res, 201, { id: 1 });
  });
  try {
    const client = createClient({ baseUrl: server.url });
    const created = await client.post('/items', { name: 'a' });
    assert.equal(created.status, 201);
    assert.deepEqual(seen, {
      method: 'POST',
      type: 'application/json',
      body: '{"name":"a"}',
      accept: 'application/json, text/plain, */*',
    });
    await client.get('/items');
    assert.equal(getType, undefined);
  } finally {
    await server.close();
  }
});

test('PUT, PATCH, DELETE, OPTIONS use the right method; string bodies are untouched', async () => {
  const seen: string[] = [];
  const server = await startServer(async (req, res) => {
    seen.push(`${req.method}:${req.headers['content-type'] ?? ''}:${await readBody(req)}`);
    res.end('ok');
  });
  try {
    const client = createClient({ baseUrl: server.url });
    await client.put('/a', 'raw', { headers: { 'content-type': 'text/plain' } });
    await client.patch('/a', { x: 1 });
    await client.delete('/a');
    await client.options('/a');
    assert.deepEqual(seen, ['PUT:text/plain:raw', 'PATCH:application/json:{"x":1}', 'DELETE::', 'OPTIONS::']);
  } finally {
    await server.close();
  }
});

test('HEAD returns headers without a body', async () => {
  const server = await startServer((_req, res) => {
    res.writeHead(200, { 'x-total': '42', 'content-type': 'application/json' });
    res.end();
  });
  try {
    const result = await createClient().head(server.url);
    assert.equal(result.method, 'HEAD');
    assert.equal(result.data, undefined);
    assert.equal(result.headers['x-total'], '42');
  } finally {
    await server.close();
  }
});

test('params, baseUrl joining, and default headers merge with per-request headers', async () => {
  let seenUrl = '';
  let seenHeaders: Record<string, unknown> = {};
  const server = await startServer((req, res) => {
    seenUrl = req.url ?? '';
    seenHeaders = req.headers;
    res.end('{}');
  });
  try {
    const client = createClient({
      baseUrl: `${server.url}/v1/`,
      headers: { 'x-a': '1', 'x-b': '2' },
      params: { shared: 'yes' },
    });
    await client.get('/users?keep=1', {
      params: { tag: ['a', 'b'], skip: undefined, flag: true },
      headers: { 'x-b': '3', 'x-a': null },
    });
    const parsed = new URL(seenUrl, 'http://x');
    assert.equal(parsed.pathname, '/v1/users');
    assert.deepEqual(
      [...parsed.searchParams],
      [
        ['keep', '1'],
        ['shared', 'yes'],
        ['tag', 'a'],
        ['tag', 'b'],
        ['flag', 'true'],
      ],
    );
    assert.equal(seenHeaders['x-a'], undefined);
    assert.equal(seenHeaders['x-b'], '3');
  } finally {
    await server.close();
  }
});

test('responseType: text, blob, arrayBuffer, none and auto detection', async () => {
  const server = await startServer((req, res) => {
    if (req.url === '/text') return void res.writeHead(200, { 'content-type': 'text/plain' }).end('hi');
    if (req.url === '/bin')
      return void res.writeHead(200, { 'content-type': 'image/png' }).end(Buffer.from([1, 2, 3]));
    if (req.url === '/empty') return void res.writeHead(204).end();
    json(res, 200, { a: 1 });
  });
  try {
    const client = createClient({ baseUrl: server.url });
    assert.equal((await client.get('/text')).data, 'hi');
    const blob = (await client.get('/bin')).data as Blob;
    assert.equal(blob.size, 3);
    assert.equal((await client.get('/empty')).data, undefined);
    assert.equal((await client.get('/json', { responseType: 'text' })).data, '{"a":1}');
    const buf = (await client.get('/json', { responseType: 'arrayBuffer' })).data as ArrayBuffer;
    assert.equal(buf.byteLength, 7);
    assert.equal((await client.get('/json', { responseType: 'none' })).data, undefined);
  } finally {
    await server.close();
  }
});

test('responseType stream returns an unconsumed body', async () => {
  const server = await startServer((_req, res) => res.end('streamed'));
  try {
    const result = await createClient().get(server.url, { responseType: 'stream' });
    const text = await new Response(result.data as ReadableStream).text();
    assert.equal(text, 'streamed');
  } finally {
    await server.close();
  }
});

test('responseType stream: the caller signal still cancels the body; streams are never deduped', async () => {
  const server = await startServer((_req, res) => {
    res.writeHead(200);
    res.write('a');
  });
  try {
    const client = createClient({ retry: false, dedupe: true, timeout: 5000 });
    const controller = new AbortController();
    const [first, second] = await Promise.all([
      client.get(server.url, { responseType: 'stream', signal: controller.signal }),
      client.get(server.url, { responseType: 'stream' }),
    ]);
    assert.notEqual(first.data, second.data, 'each caller gets its own body');
    const reader = (first.data as ReadableStream<Uint8Array>).getReader();
    assert.equal((await reader.read()).value?.byteLength, 1);
    controller.abort();
    await assert.rejects(reader.read());
    await (second.data as ReadableStream).cancel();
  } finally {
    await server.close();
  }
});

test('invalid JSON on a 200 raises ParseError', async () => {
  const server = await startServer((_req, res) =>
    res.writeHead(200, { 'content-type': 'application/json' }).end('{oops'),
  );
  try {
    await assert.rejects(createClient().get(server.url), (error: unknown) => {
      assert.ok(error instanceof ParseError);
      assert.equal(error.code, 'ERR_PARSE');
      assert.equal(error.status, 200);
      return true;
    });
  } finally {
    await server.close();
  }
});

test('non-2xx throws HttpError with parsed data; invalid body on error falls back to text', async () => {
  const server = await startServer((req, res) => {
    if (req.url === '/bad')
      return void res.writeHead(500, { 'content-type': 'application/json' }).end('<html>');
    json(res, 404, { message: 'nope' });
  });
  try {
    const client = createClient({ baseUrl: server.url });
    await assert.rejects(client.get('/missing'), (error: unknown) => {
      assert.ok(error instanceof HttpError);
      assert.ok(isHttpError(error));
      assert.equal(error.status, 404);
      assert.deepEqual(error.data, { message: 'nope' });
      assert.equal(error.code, 'ERR_HTTP');
      assert.equal(error.method, 'GET');
      assert.match(error.message, /HTTP 404/);
      assert.equal(error.attempts, 1);
      return true;
    });
    await assert.rejects(client.get('/bad'), (error: unknown) => {
      assert.equal((error as HttpError).data, '<html>');
      return true;
    });
  } finally {
    await server.close();
  }
});

test('throwHttpErrors false or a predicate resolves non-2xx responses', async () => {
  const server = await startServer((req, res) => json(res, req.url === '/404' ? 404 : 500, { e: 1 }));
  try {
    const client = createClient({ baseUrl: server.url, throwHttpErrors: false });
    const result = await client.get('/404');
    assert.equal(result.ok, false);
    assert.equal(result.status, 404);
    assert.equal(result.error?.status, 404);
    assert.deepEqual(result.data, { e: 1 });

    const picky = createClient({ baseUrl: server.url, throwHttpErrors: (status) => status >= 500 });
    assert.equal((await picky.get('/404')).status, 404);
    await assert.rejects(picky.get('/500'), HttpError);
  } finally {
    await server.close();
  }
});

test('input validation', async () => {
  const client = createClient();
  await assert.rejects(client.get(''), TypeError);
  await assert.rejects(client.get(123 as unknown as string), TypeError);
  await assert.rejects(client.get('not a url'), (error: unknown) => {
    assert.ok(error instanceof RequestError);
    assert.equal(error.code, 'ERR_INVALID_URL');
    return true;
  });
  await assert.rejects(client.request('http://127.0.0.1:1', { method: 'bad method' }), TypeError);
  await assert.rejects(client.request('http://127.0.0.1:1', { method: 'TRACE' }), TypeError);
  await assert.rejects(client.request('http://127.0.0.1:1', { body: 'x' }), /cannot have a body/);
  await assert.rejects(client.post('http://127.0.0.1:1', 'x', { json: {} }), /either "body" or "json"/);
  await assert.rejects(client.get('http://127.0.0.1:1', { signal: {} as AbortSignal }), TypeError);
  await assert.rejects(client.get('http://127.0.0.1:1', { timeout: -1 }), RangeError);
  await assert.rejects(client.get('http://127.0.0.1:1', { retry: { retries: 1.5 } }), RangeError);
  await assert.rejects(client.get('http://127.0.0.1:1', { retry: { jitter: 2 } }), RangeError);
  await assert.rejects(
    client.get('http://127.0.0.1:1', { retry: { backoff: 'zigzag' as 'fixed' } }),
    TypeError,
  );
  await assert.rejects(client.get('http://127.0.0.1:1', { responseType: 'xml' as 'json' }), TypeError);
  await assert.rejects(client.get('http://127.0.0.1:1', { hooks: { onSuccess: 'x' as never } }), TypeError);
  assert.throws(() => createClient({ fetch: 1 as never }), TypeError);
  assert.throws(() => createClient({ middleware: [1 as never] }), TypeError);
});

test('relative URL without baseUrl is rejected outside browsers', async () => {
  await assert.rejects(
    createClient().get('/relative'),
    (error: unknown) => (error as RequestError).code === 'ERR_INVALID_URL',
  );
});

test('custom fetch implementation is used', async () => {
  const calls: string[] = [];
  const client = createClient({
    fetch: async (input) => {
      calls.push(String(input));
      return new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } });
    },
  });
  const result = await client.get('https://example.test/path');
  assert.deepEqual(result.data, { ok: true });
  assert.deepEqual(calls, ['https://example.test/path']);
});

test('getConfig returns a copy and extend creates an independent client', async () => {
  const base = createClient({ baseUrl: 'https://a.test', headers: { 'x-a': '1' }, timeout: 5 });
  const child = base.extend({ headers: { 'x-b': '2' }, timeout: 9 });
  assert.deepEqual(base.getConfig().headers, { 'x-a': '1' });
  assert.deepEqual(child.getConfig().headers, { 'x-a': '1', 'x-b': '2' });
  assert.equal(base.getConfig().timeout, 5);
  assert.equal(child.getConfig().timeout, 9);
});
