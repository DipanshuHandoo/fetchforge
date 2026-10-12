import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HttpError, createClient } from '../src/index.ts';
import { closedPortUrl, json, startServer } from './helpers.ts';

/** Records the delays the retry loop plans, then skips the real wait to keep tests fast. */
function delayRecorder(delays: number[]) {
  return {
    beforeRetry: (info: { delay: number }) => {
      delays.push(info.delay);
      info.delay = 0;
    },
  };
}

test('retries are off by default', async () => {
  const server = await startServer((_req, res) => json(res, 503, {}));
  try {
    await assert.rejects(createClient().get(server.url), HttpError);
    assert.equal(server.hits, 1);
  } finally {
    await server.close();
  }
});

test('retry succeeds after transient failures and reports attempts', async () => {
  const server = await startServer((_req, res, n) => (n < 3 ? json(res, 503, {}) : json(res, 200, { n })));
  try {
    const client = createClient({ retry: { retries: 3, delay: 1 } });
    const result = await client.get(server.url);
    assert.equal(result.attempts, 3);
    assert.deepEqual(result.data, { n: 3 });
    const metrics = client.getMetrics();
    assert.equal(metrics.retries, 2);
    assert.equal(metrics.attempts, 3);
  } finally {
    await server.close();
  }
});

test('retry shorthand: true and a number', async () => {
  const server = await startServer((_req, res) => json(res, 500, {}));
  try {
    await assert.rejects(createClient({ retry: 1 }).get(server.url, { retry: { delay: 1 } }));
    assert.equal(server.hits, 2);
    const disabled = createClient({ retry: { retries: 5, delay: 1 } });
    await assert.rejects(disabled.get(server.url, { retry: false }));
    assert.equal(server.hits, 3);
  } finally {
    await server.close();
  }
});

test('backoff strategies: fixed, linear (5s,10s,15s), exponential, custom, maxDelay', async () => {
  const server = await startServer((_req, res) => json(res, 500, {}));
  try {
    const run = async (retry: object) => {
      const delays: number[] = [];
      const client = createClient({ hooks: delayRecorder(delays) });
      await assert.rejects(client.get(server.url, { retry }));
      return delays;
    };
    assert.deepEqual(await run({ retries: 3, delay: 5000, backoff: 'fixed' }), [5000, 5000, 5000]);
    assert.deepEqual(await run({ retries: 3, delay: 5000, backoff: 'linear' }), [5000, 10000, 15000]);
    assert.deepEqual(
      await run({ retries: 3, delay: 100, backoff: 'exponential', factor: 3 }),
      [100, 300, 900],
    );
    assert.deepEqual(await run({ retries: 3, delay: 100 }), [100, 200, 400]);
    assert.deepEqual(
      await run({ retries: 3, delay: 1000, backoff: 'exponential', maxDelay: 1500 }),
      [1000, 1500, 1500],
    );
    assert.deepEqual(await run({ retries: 2, backoff: (n: number) => n * 7 }), [7, 14]);
    assert.deepEqual(await run({ retries: 1, backoff: () => Number.NaN }), [0]);
    const jittered = await run({ retries: 3, delay: 100, backoff: 'fixed', jitter: 0.5 });
    assert.ok(jittered.every((d) => d >= 100 && d <= 150));
  } finally {
    await server.close();
  }
});

test('non-idempotent methods and non-retryable statuses are not retried', async () => {
  const server = await startServer((req, res) => json(res, req.url === '/400' ? 400 : 503, {}));
  try {
    const client = createClient({ baseUrl: server.url, retry: { retries: 2, delay: 1 } });
    await assert.rejects(client.post('/x', { a: 1 }));
    assert.equal(server.hits, 1);
    await assert.rejects(client.get('/400'));
    assert.equal(server.hits, 2);
    await assert.rejects(client.post('/x', {}, { retry: { methods: ['POST'] } }));
    assert.equal(server.hits, 5);
  } finally {
    await server.close();
  }
});

test('custom statusCodes, retryOnNetworkError and retryOnTimeout', async () => {
  const server = await startServer((_req, res) => json(res, 409, {}));
  const closed = await closedPortUrl();
  const hung = await startServer(() => {});
  try {
    await assert.rejects(
      createClient().get(server.url, { retry: { retries: 1, delay: 1, statusCodes: [409] } }),
    );
    assert.equal(server.hits, 2);

    const delays: number[] = [];
    const client = createClient({ hooks: delayRecorder(delays) });
    await assert.rejects(client.get(closed, { retry: { retries: 2 } }));
    assert.equal(delays.length, 2);
    delays.length = 0;
    await assert.rejects(client.get(closed, { retry: { retries: 2, retryOnNetworkError: false } }));
    assert.equal(delays.length, 0);

    await assert.rejects(client.get(hung.url, { timeout: 20, retry: { retries: 1 } }));
    assert.equal(delays.length, 1);
    await assert.rejects(client.get(hung.url, { timeout: 20, retry: { retries: 1, retryOnTimeout: false } }));
    assert.equal(delays.length, 1);
  } finally {
    await server.close();
    await hung.close();
  }
});

test('Retry-After is honoured and capped by maxRetryAfter', async () => {
  const server = await startServer((_req, res) => json(res, 429, {}, { 'retry-after': '2' }));
  try {
    const delays: number[] = [];
    const client = createClient({ hooks: delayRecorder(delays) });
    await assert.rejects(client.get(server.url, { retry: { retries: 1, delay: 10 } }));
    assert.deepEqual(delays, [2000]);

    await assert.rejects(client.get(server.url, { retry: { retries: 1, delay: 10, maxRetryAfter: 1000 } }));
    assert.equal(server.hits, 3);

    delays.length = 0;
    await assert.rejects(
      client.get(server.url, { retry: { retries: 1, delay: 10, respectRetryAfter: false } }),
    );
    assert.deepEqual(delays, [10]);
  } finally {
    await server.close();
  }
});

test('shouldRetry overrides built-in rules; beforeRetry can stop retrying', async () => {
  const server = await startServer((_req, res) => json(res, 400, {}));
  try {
    const seen: boolean[] = [];
    const client = createClient({
      retry: {
        retries: 2,
        delay: 1,
        shouldRetry: ({ retryable, error }) => {
          seen.push(retryable);
          return error instanceof HttpError && error.status === 400;
        },
      },
    });
    await assert.rejects(client.get(server.url));
    assert.equal(server.hits, 3);
    assert.deepEqual(seen, [false, false]);

    const stop = createClient({
      retry: { retries: 5, delay: 1 },
      hooks: { beforeRetry: () => false },
    });
    await assert.rejects(stop.get(server.url, { retry: { statusCodes: [400] } }));
    assert.equal(server.hits, 4);
  } finally {
    await server.close();
  }
});

test('beforeRetry receives attempt info and may change the delay', async () => {
  const server = await startServer((_req, res) => json(res, 500, {}));
  try {
    const infos: Array<{ attempt: number; retriesLeft: number; status: number }> = [];
    const client = createClient({
      retry: { retries: 2, delay: 60_000 },
      hooks: {
        beforeRetry: (info) => {
          infos.push({
            attempt: info.attempt,
            retriesLeft: info.retriesLeft,
            status: (info.error as HttpError).status,
          });
          info.delay = 0;
        },
      },
    });
    await assert.rejects(client.get(server.url));
    assert.deepEqual(infos, [
      { attempt: 1, retriesLeft: 1, status: 500 },
      { attempt: 2, retriesLeft: 0, status: 500 },
    ]);
  } finally {
    await server.close();
  }
});

test('aborting during the retry delay stops immediately without further attempts', async () => {
  const server = await startServer((_req, res) => json(res, 500, {}));
  try {
    const controller = new AbortController();
    const client = createClient({ retry: { retries: 5, delay: 60_000 } });
    const pending = client.get(server.url, { signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    await assert.rejects(pending, (error: unknown) => (error as Error).name === 'AbortError');
    assert.equal(server.hits, 1);
  } finally {
    await server.close();
  }
});

test('stream request bodies are never retried', async () => {
  const server = await startServer((req, res) => {
    req.resume();
    req.on('end', () => json(res, 503, {}));
  });
  try {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('x'));
        controller.close();
      },
    });
    const client = createClient({ retry: { retries: 3, delay: 1, methods: ['POST'] } });
    await assert.rejects(client.post(server.url, body));
    assert.equal(server.hits, 1);
  } finally {
    await server.close();
  }
});

test('retried POST resends the same body each time', async () => {
  const bodies: string[] = [];
  const server = await startServer(async (req, res, n) => {
    let data = '';
    for await (const chunk of req) data += chunk;
    bodies.push(data);
    json(res, n < 3 ? 502 : 200, {});
  });
  try {
    const client = createClient({ retry: { retries: 3, delay: 1, methods: ['POST'] } });
    await client.post(server.url, { a: 1 });
    assert.deepEqual(bodies, ['{"a":1}', '{"a":1}', '{"a":1}']);
  } finally {
    await server.close();
  }
});
