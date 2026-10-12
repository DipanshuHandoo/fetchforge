import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type FetchResult,
  HttpError,
  type Plugin,
  bearerAuth,
  createClient,
  fetchforge,
  isAbortError,
} from '../src/index.ts';
import { json, startServer, wait } from './helpers.ts';

test('dedupe shares one request between identical concurrent GETs', async () => {
  const server = await startServer(async (_req, res, n) => {
    await wait(30);
    json(res, 200, { n });
  });
  try {
    const client = createClient({ dedupe: true });
    const [a, b, c] = await Promise.all([
      client.get(server.url),
      client.get(server.url),
      client.get(server.url),
    ]);
    assert.equal(server.hits, 1);
    assert.deepEqual(a.data, { n: 1 });
    assert.equal(b.data, a.data);
    assert.equal(c.data, a.data);
    assert.equal(client.getMetrics().deduped, 2);
    await client.get(server.url);
    assert.equal(server.hits, 2);
  } finally {
    await server.close();
  }
});

test('dedupe distinguishes headers, URLs and methods; POST is not deduped by default', async () => {
  const server = await startServer(async (_req, res) => {
    await wait(20);
    json(res, 200, {});
  });
  try {
    const client = createClient({ dedupe: true });
    await Promise.all([
      client.get(server.url, { headers: { authorization: 'a' } }),
      client.get(server.url, { headers: { authorization: 'b' } }),
      client.get(`${server.url}/other`),
      client.post(server.url, {}),
      client.post(server.url, {}),
    ]);
    assert.equal(server.hits, 5);
    const custom = createClient({ dedupe: { methods: ['POST'] } });
    await Promise.all([custom.post(server.url, 'same'), custom.post(server.url, 'same')]);
    assert.equal(server.hits, 6);
    await Promise.all([
      createClient().get(server.url, { dedupe: { key: () => 'k' } }),
      createClient().get(`${server.url}/z`, { dedupe: { key: () => 'k' } }),
    ]);
    assert.equal(server.hits, 8);
    const shared = createClient({ dedupe: { key: () => 'k' } });
    await Promise.all([shared.get(server.url), shared.get(`${server.url}/z`)]);
    assert.equal(server.hits, 9);
  } finally {
    await server.close();
  }
});

test('dedupe: failures are shared; one caller aborting does not cancel the others; all aborting cancels the request', async () => {
  let aborted = 0;
  const server = await startServer((req, res) => {
    req.on('close', () => {
      if (!res.writableEnded) aborted++;
    });
    if (req.url === '/fail') return json(res, 500, {});
    setTimeout(() => !res.destroyed && json(res, 200, { ok: 1 }), 150);
  });
  try {
    const client = createClient({ dedupe: true, baseUrl: server.url });
    const settled = await Promise.allSettled([client.get('/fail'), client.get('/fail')]);
    assert.equal(server.hits, 1);
    assert.ok(settled.every((s) => s.status === 'rejected' && s.reason instanceof HttpError));

    const one = new AbortController();
    const first = client.get('/slow', { signal: one.signal });
    const second = client.get('/slow');
    await wait(20);
    one.abort();
    await assert.rejects(first, (e: unknown) => isAbortError(e));
    assert.deepEqual((await second).data, { ok: 1 });
    assert.equal(aborted, 0);

    const x = new AbortController();
    const y = new AbortController();
    const p1 = client.get('/slow2', { signal: x.signal });
    const p2 = client.get('/slow2', { signal: y.signal });
    await wait(20);
    x.abort();
    y.abort();
    await assert.rejects(p1);
    await assert.rejects(p2);
    await wait(50);
    assert.equal(aborted, 1);
  } finally {
    await server.close();
  }
});

test('hedging: a slow first request is beaten by a duplicate, and the loser is aborted', async () => {
  let aborted = 0;
  const server = await startServer((req, res, n) => {
    req.on('close', () => {
      if (!res.writableEnded) aborted++;
    });
    if (n === 1) return void setTimeout(() => !res.destroyed && json(res, 200, { who: 'slow' }), 400);
    json(res, 200, { who: 'fast' });
  });
  try {
    const client = createClient({ hedging: { delay: 30 } });
    const started = Date.now();
    const result = await client.get(server.url);
    assert.deepEqual(result.data, { who: 'fast' });
    assert.ok(Date.now() - started < 300);
    assert.equal(client.getMetrics().hedges, 1);
    await wait(30);
    assert.equal(aborted, 1);
  } finally {
    await server.close();
  }
});

test('hedging: no duplicate when the first response is fast; POST and streams are never hedged', async () => {
  const server = await startServer((_req, res) => json(res, 200, {}));
  try {
    const client = createClient({ hedging: 50 });
    await client.get(server.url);
    assert.equal(server.hits, 1);
    const slow = await startServer(async (_req, res) => {
      await wait(120);
      json(res, 200, {});
    });
    try {
      await client.post(slow.url, {});
      assert.equal(slow.hits, 1);
      await client.get(slow.url, { responseType: 'stream' }).then((r) => (r.data as ReadableStream).cancel());
      assert.equal(slow.hits, 2);
    } finally {
      await slow.close();
    }
  } finally {
    await server.close();
  }
});

test('hedging: failure of the first request launches the hedge immediately; all failing rejects', async () => {
  const server = await startServer((_req, res, n) => (n === 1 ? json(res, 500, {}) : json(res, 200, { n })));
  try {
    const client = createClient({ hedging: { delay: 5000 } });
    const result = await client.get(server.url);
    assert.deepEqual(result.data, { n: 2 });
    const failing = await startServer((_req, res) => json(res, 500, {}));
    try {
      await assert.rejects(createClient({ hedging: { delay: 5, maxHedges: 2 } }).get(failing.url), HttpError);
      assert.equal(failing.hits, 3);
    } finally {
      await failing.close();
    }
  } finally {
    await server.close();
  }
});

test('hedging respects caller abort', async () => {
  const server = await startServer(() => {});
  try {
    const controller = new AbortController();
    const pending = createClient({ hedging: { delay: 10 } }).get(server.url, { signal: controller.signal });
    setTimeout(() => controller.abort(), 40);
    await assert.rejects(pending, (e: unknown) => isAbortError(e));
  } finally {
    await server.close();
  }
});

test('hooks run in order, can mutate requests, and finally/onComplete always runs', async () => {
  const server = await startServer((req, res) =>
    json(res, req.url === '/fail' ? 500 : 200, { h: req.headers['x-hook'] }),
  );
  try {
    const log: string[] = [];
    const client = createClient({
      baseUrl: server.url,
      hooks: {
        beforeRequest: [
          (r) => {
            r.headers.set('x-hook', 'set');
            log.push(`before:${r.attempt}`);
          },
          async () => void log.push('before2'),
        ],
        afterResponse: (response) => void log.push(`after:${response.status}`),
        onSuccess: (result) => void log.push(`success:${result.status}`),
        onError: (e) => void log.push(`error:${e.name}`),
        onComplete: (info) => void log.push(`complete:${info.error ? 'err' : 'ok'}:${info.attempts}`),
      },
    });
    const ok = await client.get('/ok', { hooks: { onSuccess: () => void log.push('request-level') } });
    assert.deepEqual(ok.data, { h: 'set' });
    assert.deepEqual(log, [
      'before:1',
      'before2',
      'after:200',
      'success:200',
      'request-level',
      'complete:ok:1',
    ]);
    log.length = 0;
    await assert.rejects(client.get('/fail'));
    assert.deepEqual(log, ['before:1', 'before2', 'after:500', 'error:HttpError', 'complete:err:1']);
  } finally {
    await server.close();
  }
});

test('afterResponse may replace the response; beforeError may replace the error', async () => {
  const server = await startServer((_req, res) => json(res, 200, { v: 1 }));
  try {
    const replacing = createClient({
      hooks: {
        afterResponse: () =>
          new Response('{"v":2}', { status: 200, headers: { 'content-type': 'application/json' } }),
      },
    });
    assert.deepEqual((await replacing.get(server.url)).data, { v: 2 });

    const transform = createClient({
      hooks: {
        afterResponse: () => new Response('no', { status: 500 }),
        beforeError: (error) => new Error(`wrapped: ${error.message}`),
      },
    });
    await assert.rejects(transform.get(server.url), /^Error: wrapped: HTTP 500/);
  } finally {
    await server.close();
  }
});

test('observer hook failures never break the request and are reported to onHookError', async () => {
  const server = await startServer((_req, res) => json(res, 200, {}));
  try {
    const reported: string[] = [];
    const client = createClient({
      hooks: {
        onSuccess: () => {
          throw new Error('observer bug');
        },
        onComplete: async () => {
          throw new Error('async observer bug');
        },
        onHookError: [
          (error, hook) => void reported.push(`${hook}:${(error as Error).message}`),
          () => {
            throw new Error('reporter bug');
          },
        ],
      },
    });
    assert.equal((await client.get(server.url)).status, 200);
    assert.deepEqual(reported, ['onSuccess:observer bug', 'onComplete:async observer bug']);
  } finally {
    await server.close();
  }
});

test('a throwing beforeRequest hook rejects the request with that error', async () => {
  const client = createClient({
    hooks: {
      beforeRequest: () => {
        throw new RangeError('blocked');
      },
    },
  });
  await assert.rejects(client.get('http://127.0.0.1:1'), RangeError);
});

test('middleware composes koa-style and can short-circuit', async () => {
  const server = await startServer((_req, res) => json(res, 200, { real: true }));
  try {
    const order: string[] = [];
    const client = createClient({
      middleware: [
        async (_ctx, next) => {
          order.push('a:in');
          const result = await next();
          order.push('a:out');
          return result;
        },
        async (ctx, next) => {
          order.push('b:in');
          if (ctx.request.url.endsWith('/cached')) {
            return { ...(await next()), data: { cached: true } } as FetchResult;
          }
          return next();
        },
      ],
    });
    assert.deepEqual((await client.get(`${server.url}/cached`)).data, { cached: true });
    assert.deepEqual(order, ['a:in', 'b:in', 'a:out']);

    const shortCircuit = createClient({
      middleware: (ctx) =>
        Promise.resolve({ url: ctx.request.url, data: 'stub', status: 200 } as FetchResult),
    });
    assert.equal((await shortCircuit.get(server.url)).data, 'stub');
    assert.equal(server.hits, 1);
  } finally {
    await server.close();
  }
});

test('plugins contribute hooks and middleware; duplicates and invalid plugins are rejected', async () => {
  const server = await startServer((req, res) => json(res, 200, { auth: req.headers.authorization }));
  try {
    const calls: string[] = [];
    const plugin: Plugin = {
      name: 'tracer',
      hooks: { onComplete: () => void calls.push('complete') },
      middleware: async (_c, next) => {
        calls.push('mw');
        return next();
      },
      setup: () => void calls.push('setup'),
    };
    const client = createClient({ plugins: [plugin, bearerAuth('secret')] });
    assert.deepEqual((await client.get(server.url)).data, { auth: 'Bearer secret' });
    assert.deepEqual(calls, ['setup', 'mw', 'complete']);
    assert.throws(() => client.use(plugin), /already registered/);
    assert.throws(() => client.use({} as Plugin), TypeError);
    assert.throws(() => client.use(null as never), TypeError);
    assert.throws(() => bearerAuth(5 as never), TypeError);
    // extend() keeps plugin effects and the registry
    assert.throws(() => client.extend().use(plugin), /already registered/);
    assert.deepEqual((await client.extend().get(server.url)).data, { auth: 'Bearer secret' });
  } finally {
    await server.close();
  }
});

test('bearerAuth: async token function re-evaluated per attempt, custom header/scheme, explicit header wins', async () => {
  const seen: Array<string | undefined> = [];
  const server = await startServer((req, res, n) => {
    seen.push((req.headers['x-token'] ?? req.headers.authorization) as string | undefined);
    json(res, n === 1 ? 503 : 200, {});
  });
  try {
    let version = 0;
    const client = createClient({
      retry: { retries: 1, delay: 1 },
      plugins: [bearerAuth(async () => `t${++version}`, { header: 'x-token', scheme: '' })],
    });
    await client.get(server.url);
    assert.deepEqual(seen, ['t1', 't2']);
    seen.length = 0;
    await createClient({ plugins: [bearerAuth('x')] }).get(server.url, {
      headers: { authorization: 'Custom y' },
    });
    assert.deepEqual(seen, ['Custom y']);
    seen.length = 0;
    await createClient({ plugins: [bearerAuth(() => null)] }).get(server.url);
    assert.deepEqual(seen, [undefined]);
  } finally {
    await server.close();
  }
});

test('bulk runs requests with a concurrency limit, keeps input order and records failures', async () => {
  let active = 0;
  let peak = 0;
  const server = await startServer(async (req, res) => {
    active++;
    peak = Math.max(peak, active);
    await wait(25);
    active--;
    if (req.url === '/bad') return json(res, 500, {});
    json(res, 200, { path: req.url });
  });
  try {
    const client = createClient({ baseUrl: server.url });
    const progress: number[] = [];
    const out = await client.bulk(['/a', '/bad', { url: '/b', method: 'GET' }, '/c', '/d', '/e'], {
      concurrency: 2,
      onProgress: (p) => void progress.push(p.done),
    });
    assert.equal(peak, 2);
    assert.equal(out.total, 6);
    assert.equal(out.fulfilled, 5);
    assert.equal(out.rejected, 1);
    assert.equal(out.skipped, 0);
    assert.equal(out.aborted, false);
    assert.deepEqual(
      out.results.map((r) => r.index),
      [0, 1, 2, 3, 4, 5],
    );
    const bad = out.results[1];
    assert.equal(bad?.status, 'rejected');
    assert.ok(bad?.status === 'rejected' && bad.error instanceof HttpError);
    const second = out.results[2];
    assert.ok(second?.status === 'fulfilled' && (second.result.data as { path: string }).path === '/b');
    assert.equal(progress.at(-1), 6);
  } finally {
    await server.close();
  }
});

test('bulk stopOnError skips pending work; signal cancels the run; empty and invalid input', async () => {
  const server = await startServer(async (req, res) => {
    await wait(20);
    json(res, req.url === '/bad' ? 500 : 200, {});
  });
  try {
    const client = createClient({ baseUrl: server.url });
    const stopped = await client.bulk(['/bad', '/a', '/b', '/c'], { concurrency: 1, stopOnError: true });
    assert.equal(stopped.aborted, true);
    assert.equal(stopped.rejected, 1);
    assert.equal(stopped.skipped, 3);

    const controller = new AbortController();
    const run = client.bulk(['/a', '/b', '/c', '/d'], { concurrency: 1, signal: controller.signal });
    setTimeout(() => controller.abort(), 30);
    const cancelled = await run;
    assert.equal(cancelled.aborted, true);
    assert.ok(cancelled.skipped >= 1);
    assert.equal(cancelled.fulfilled + cancelled.rejected + cancelled.skipped, 4);

    const empty = await client.bulk([]);
    assert.deepEqual([empty.total, empty.results.length], [0, 0]);
    await assert.rejects(client.bulk(['/a'], { concurrency: 0 }));
    const invalid = await client.bulk(['']);
    assert.equal(invalid.results[0]?.status, 'rejected');
  } finally {
    await server.close();
  }
});

test('metrics track requests, outcomes, status codes and latency; reset keeps the in-flight gauge', async () => {
  const server = await startServer(async (req, res) => {
    await wait(10);
    json(res, req.url === '/e' ? 500 : 200, {});
  });
  try {
    const client = createClient({ baseUrl: server.url });
    await client.get('/ok');
    await assert.rejects(client.get('/e'));
    const pending = client.get('/ok');
    assert.equal(client.getMetrics().inFlight, 1);
    client.resetMetrics();
    assert.equal(client.getMetrics().inFlight, 1);
    await pending;
    const m = client.getMetrics();
    assert.equal(m.inFlight, 0);
    client.resetMetrics();
    await client.get('/ok');
    await assert.rejects(client.get('/e'));
    const after = client.getMetrics();
    assert.equal(after.requests, 2);
    assert.equal(after.succeeded, 1);
    assert.equal(after.failed, 1);
    assert.deepEqual(after.statusCodes, { 200: 1, 500: 1 });
    assert.equal(after.latency.count, 2);
    assert.ok(after.latency.min <= after.latency.avg && after.latency.avg <= after.latency.max);
  } finally {
    await server.close();
  }
});

test('the default client is exported and usable', async () => {
  const server = await startServer((_req, res) => json(res, 200, { d: 1 }));
  try {
    assert.deepEqual((await fetchforge.get(server.url)).data, { d: 1 });
  } finally {
    await server.close();
  }
});
