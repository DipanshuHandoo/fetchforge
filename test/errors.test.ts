import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AbortError,
  CircuitOpenError,
  FetchForgeError,
  type HttpError,
  NetworkError,
  TimeoutError,
  createClient,
  isAbortError,
  isCircuitOpenError,
  isFetchForgeError,
  isNetworkError,
  isParseError,
  isTimeoutError,
} from '../src/index.ts';
import { closedPortUrl, json, startServer, wait } from './helpers.ts';

test('attempt timeout raises TimeoutError and frees the connection', async () => {
  const server = await startServer(() => {});
  try {
    const client = createClient({ timeout: 40 });
    await assert.rejects(client.get(server.url), (error: unknown) => {
      assert.ok(error instanceof TimeoutError);
      assert.ok(isTimeoutError(error));
      assert.equal(error.scope, 'attempt');
      assert.equal(error.timeout, 40);
      assert.equal(error.code, 'ERR_TIMEOUT');
      assert.match(error.message, /timed out after 40ms/);
      return true;
    });
    assert.equal(client.getMetrics().timeouts, 1);
  } finally {
    await server.close();
  }
});

test('totalTimeout bounds attempts plus retry delays and is not retried', async () => {
  const server = await startServer((_req, res) => json(res, 503, {}));
  try {
    const client = createClient({ retry: { retries: 10, delay: 30, backoff: 'fixed' }, totalTimeout: 120 });
    await assert.rejects(client.get(server.url), (error: unknown) => {
      assert.ok(error instanceof TimeoutError);
      assert.equal(error.scope, 'total');
      assert.match(error.message, /total time limit/);
      return true;
    });
    assert.ok(server.hits >= 2 && server.hits < 10);
  } finally {
    await server.close();
  }
});

test('network failures raise NetworkError', async () => {
  const url = await closedPortUrl();
  await assert.rejects(createClient().get(url), (error: unknown) => {
    assert.ok(error instanceof NetworkError);
    assert.ok(isNetworkError(error));
    assert.ok(isFetchForgeError(error));
    assert.equal(error.code, 'ERR_NETWORK');
    assert.ok(error.cause);
    return true;
  });
});

test('caller signal aborts with AbortError, before and during a request', async () => {
  const server = await startServer(() => {});
  try {
    const client = createClient();
    const pre = AbortSignal.abort();
    await assert.rejects(client.get(server.url, { signal: pre }), AbortError);

    const controller = new AbortController();
    const pending = client.get(server.url, { signal: controller.signal });
    setTimeout(() => controller.abort(new Error('user cancelled')), 20);
    await assert.rejects(pending, (error: unknown) => {
      assert.ok(isAbortError(error));
      assert.equal((error as AbortError).cause instanceof Error, true);
      return true;
    });
    assert.equal(client.getMetrics().aborted, 2);
  } finally {
    await server.close();
  }
});

test('abortAll cancels in-flight requests', async () => {
  const server = await startServer(() => {});
  try {
    const client = createClient();
    const a = client.get(server.url);
    const b = client.get(`${server.url}/b`);
    await wait(20);
    client.abortAll();
    await assert.rejects(a, AbortError);
    await assert.rejects(b, AbortError);
    assert.equal(client.getMetrics().inFlight, 0);
  } finally {
    await server.close();
  }
});

test('custom messages: template and function forms, defaults elsewhere, broken function falls back', async () => {
  const server = await startServer((_req, res) => json(res, 418, {}));
  try {
    const templated = createClient({ messages: { http: 'Teapot says {status} for {method} {url}' } });
    await assert.rejects(templated.get(server.url), (error: unknown) => {
      assert.equal((error as HttpError).message, `Teapot says 418 for GET ${server.url}/`);
      return true;
    });

    const fn = createClient({ messages: { http: (c) => `custom:${c.status}:${c.detail}` } });
    await assert.rejects(fn.get(server.url), /^HttpError: custom:418:|custom:418:/);

    const broken = createClient({
      messages: {
        http: () => {
          throw new Error('boom');
        },
      },
    });
    await assert.rejects(broken.get(server.url), /HTTP 418/);

    const perRequest = createClient();
    await assert.rejects(
      perRequest.get(server.url, { messages: { http: 'per-request' } }),
      /^HttpError: per-request$|per-request/,
    );
    await assert.rejects(createClient({ messages: { invalidUrl: 'bad: {url}' } }).get('nope'), /bad: nope/);
  } finally {
    await server.close();
  }
});

test('error guards work on lookalikes and reject non-errors', () => {
  assert.equal(isFetchForgeError(null), false);
  assert.equal(isFetchForgeError(new Error('x')), false);
  assert.equal(isFetchForgeError({}), false);
  assert.equal(isParseError(new Error('x')), false);
  assert.equal(isCircuitOpenError(new FetchForgeError('m', 'ERR_HTTP', { method: 'GET', url: 'u' })), false);
  const error = new CircuitOpenError('open', { method: 'GET', url: 'u', key: 'k', retryAfter: 5 });
  assert.equal(isCircuitOpenError(error), true);
  assert.equal(error.name, 'CircuitOpenError');
  assert.equal(error.retryAfter, 5);
});

test('errors carry attempts after retries', async () => {
  const server = await startServer((_req, res) => json(res, 500, {}));
  try {
    const client = createClient({ retry: { retries: 2, delay: 1 } });
    await assert.rejects(client.get(server.url), (error: unknown) => (error as HttpError).attempts === 3);
    assert.equal(server.hits, 3);
  } finally {
    await server.close();
  }
});
