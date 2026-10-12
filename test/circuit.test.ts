import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CircuitOpenError, HttpError, createClient, isCircuitOpenError } from '../src/index.ts';
import { closedPortUrl, json, startServer, wait } from './helpers.ts';

test('circuit opens after consecutive failures and stops hitting the server', async () => {
  const server = await startServer((_req, res) => json(res, 500, {}));
  try {
    const transitions: string[] = [];
    const client = createClient({
      circuitBreaker: { failureThreshold: 3, resetTimeout: 10000 },
      hooks: { onCircuitStateChange: ({ from, to }) => void transitions.push(`${from}>${to}`) },
    });
    for (let i = 0; i < 3; i++) await assert.rejects(client.get(server.url), HttpError);
    assert.equal(client.getCircuitState(server.url), 'open');
    await assert.rejects(client.get(server.url), (error: unknown) => {
      assert.ok(error instanceof CircuitOpenError);
      assert.ok(isCircuitOpenError(error));
      assert.equal(error.key, new URL(server.url).origin);
      assert.ok(error.retryAfter > 0 && error.retryAfter <= 10000);
      assert.match(error.message, /Circuit breaker is open/);
      return true;
    });
    assert.equal(server.hits, 3);
    assert.equal(client.getMetrics().circuitRejections, 1);
    assert.deepEqual(transitions, ['closed>open']);
  } finally {
    await server.close();
  }
});

test('a success resets the consecutive failure count; 4xx do not count as failures', async () => {
  let status = 500;
  const server = await startServer((_req, res) => json(res, status, {}));
  try {
    const client = createClient({ circuitBreaker: { failureThreshold: 2 } });
    await assert.rejects(client.get(server.url));
    status = 200;
    await client.get(server.url);
    status = 500;
    await assert.rejects(client.get(server.url));
    assert.equal(client.getCircuitState(server.url), 'closed');
    status = 404;
    for (let i = 0; i < 5; i++) await assert.rejects(client.get(server.url));
    assert.equal(client.getCircuitState(server.url), 'closed');
  } finally {
    await server.close();
  }
});

test('half-open: trial request closes the circuit on success, reopens on failure', async () => {
  let healthy = false;
  const server = await startServer((_req, res) => json(res, healthy ? 200 : 503, {}));
  try {
    const transitions: string[] = [];
    const client = createClient({
      circuitBreaker: { failureThreshold: 1, resetTimeout: 60 },
      hooks: { onCircuitStateChange: ({ from, to }) => void transitions.push(`${from}>${to}`) },
    });
    await assert.rejects(client.get(server.url));
    await wait(80);
    await assert.rejects(client.get(server.url), HttpError); // trial fails -> open again
    assert.equal(client.getCircuitState(server.url), 'open');
    await assert.rejects(client.get(server.url), CircuitOpenError);
    await wait(80);
    healthy = true;
    await client.get(server.url);
    assert.equal(client.getCircuitState(server.url), 'closed');
    assert.deepEqual(transitions, [
      'closed>open',
      'open>half-open',
      'half-open>open',
      'open>half-open',
      'half-open>closed',
    ]);
  } finally {
    await server.close();
  }
});

test('half-open limits concurrent trial requests', async () => {
  let release: (() => void) | undefined;
  let phase = 'fail';
  const server = await startServer(async (_req, res) => {
    if (phase === 'fail') return json(res, 500, {});
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    json(res, 200, {});
  });
  try {
    const client = createClient({
      circuitBreaker: { failureThreshold: 1, resetTimeout: 30, halfOpenMaxRequests: 1 },
    });
    await assert.rejects(client.get(server.url));
    await wait(50);
    phase = 'ok';
    const trial = client.get(server.url);
    await wait(20);
    await assert.rejects(client.get(`${server.url}/other`), CircuitOpenError);
    release?.();
    await trial;
    assert.equal(client.getCircuitState(server.url), 'closed');
  } finally {
    await server.close();
  }
});

test('an aborted trial request neither closes nor reopens the circuit and frees the probe slot', async () => {
  let phase = 'fail';
  const server = await startServer(async (_req, res) => {
    if (phase === 'fail') return json(res, 500, {});
    await wait(5000);
    res.end();
  });
  try {
    const client = createClient({ circuitBreaker: { failureThreshold: 1, resetTimeout: 20 } });
    await assert.rejects(client.get(server.url));
    await wait(40);
    phase = 'hang';
    const controller = new AbortController();
    const trial = client.get(server.url, { signal: controller.signal });
    await wait(20);
    controller.abort();
    await assert.rejects(trial);
    assert.equal(client.getCircuitState(server.url), 'half-open');
    phase = 'fail';
    await assert.rejects(client.get(server.url), HttpError); // slot was released, trial allowed again
  } finally {
    await server.close();
  }
});

test('circuits are tracked per key; custom key and isFailure are supported; resetCircuit works', async () => {
  const a = await startServer((_req, res) => json(res, 500, {}));
  const b = await startServer((_req, res) => json(res, 200, {}));
  try {
    const client = createClient({ circuitBreaker: { failureThreshold: 1, resetTimeout: 60000 } });
    await assert.rejects(client.get(a.url));
    await assert.rejects(client.get(a.url), CircuitOpenError);
    await client.get(b.url);
    assert.equal(client.getCircuitState(b.url), 'closed');
    client.resetCircuit(a.url);
    assert.equal(client.getCircuitState(a.url), 'closed');
    await assert.rejects(client.get(a.url), HttpError);
    client.resetCircuit();
    assert.equal(client.getCircuitState(a.url), 'closed');

    const custom = createClient({
      circuitBreaker: { failureThreshold: 1, key: () => 'shared', isFailure: (e) => e.code === 'ERR_HTTP' },
    });
    await assert.rejects(custom.get(a.url));
    assert.equal(custom.getCircuitState('shared'), 'open');
    await assert.rejects(custom.get(b.url), CircuitOpenError);
  } finally {
    await a.close();
    await b.close();
  }
});

test('network errors and timeouts count toward the circuit; circuit errors are not retried', async () => {
  const url = await closedPortUrl();
  const client = createClient({
    circuitBreaker: { failureThreshold: 2, resetTimeout: 60000 },
    retry: { retries: 5, delay: 1 },
  });
  await assert.rejects(client.get(url)); // 2 failed attempts open the circuit, the 3rd is rejected
  assert.equal(client.getCircuitState(url), 'open');
  assert.equal(client.getMetrics().attempts, 3);
  assert.equal(client.getMetrics().circuitRejections, 1);
});

test('circuit option validation', async () => {
  await assert.rejects(
    createClient().get('http://127.0.0.1:1', { circuitBreaker: { failureThreshold: 0 } }),
    RangeError,
  );
  await assert.rejects(
    createClient().get('http://127.0.0.1:1', { circuitBreaker: { resetTimeout: -5 } }),
    RangeError,
  );
  assert.equal(createClient().getCircuitState('https://unknown.test'), 'closed');
});
