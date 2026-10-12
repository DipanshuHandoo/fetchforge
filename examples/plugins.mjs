// Custom plugins: a webhook plugin that notifies another system on failures and circuit changes, and a
// short-lived cache plugin built from middleware. Shows plugin names, setup() and combining plugins.
// The cache here only illustrates plugin authoring; for real use, the built-in `cache()` (examples/cache.mjs).
// Docs: docs/plugins.md
import assert from 'node:assert/strict';
import { bearerAuth, createClient } from '@dipanshuhandoo/fetchforge';
import { json, startServer } from './_server.mjs';

const received = [];
const hooksServer = await startServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
  });
  req.on('end', () => {
    received.push(JSON.parse(body));
    json(res, 200, { ok: true });
  });
});
const api = await startServer((req, res) =>
  req.url.startsWith('/down') ? json(res, 503, { error: 'down' }) : json(res, 200, { path: req.url }),
);

const webhook = ({ url, events = ['error', 'circuit'] }) => {
  const fire = (type, payload) => {
    if (!events.includes(type)) return;
    fetch(url, {
      method: 'POST',
      body: JSON.stringify({ type, ...payload }),
      signal: AbortSignal.timeout(3000),
    }).catch(() => {});
  };
  return {
    name: 'webhook',
    hooks: {
      onError: (error, request) => fire('error', { url: request.url, code: error.code }),
      onCircuitStateChange: ({ key, from, to }) => fire('circuit', { key, from, to }),
    },
  };
};

const cache = (ttlMs) => {
  const entries = new Map();
  return {
    name: 'my-cache',
    middleware: async ({ request }, next) => {
      if (request.method !== 'GET') return next();
      const hit = entries.get(request.url);
      if (hit && hit.expires > Date.now()) return hit.result;
      const result = await next();
      entries.set(request.url, { result, expires: Date.now() + ttlMs });
      return result;
    },
  };
};

try {
  const client = createClient({
    baseUrl: api.url,
    retry: false,
    circuitBreaker: { failureThreshold: 2, resetTimeout: 60000 },
    plugins: [bearerAuth('demo-token'), cache(1000), webhook({ url: hooksServer.url })],
  });

  await client.get('/users');
  await client.get('/users');
  assert.equal(api.count, 1, 'the cache plugin served the second call');

  await assert.rejects(client.get('/down'));
  await assert.rejects(client.get('/down'));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(
    received.some((e) => e.type === 'error'),
    'webhook received the failures',
  );
  assert.ok(
    received.some((e) => e.type === 'circuit' && e.to === 'open'),
    'webhook received the circuit opening',
  );

  assert.throws(() => client.use(cache(1000)), TypeError, 'plugin names are unique per client');
  console.log('webhook events:', received.map((e) => e.type).join(', '));
  console.log('plugins example passed');
} finally {
  await api.close();
  await hooksServer.close();
}
