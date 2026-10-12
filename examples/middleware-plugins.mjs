// Middleware and plugins: wrap whole calls, build a reusable plugin, use bearerAuth, and extend() a client.
// Docs: docs/middleware-and-plugins.md
import assert from 'node:assert/strict';
import { bearerAuth, createClient } from '@dipanshuhandoo/fetchforge';
import { json, startServer } from './_server.mjs';

const api = await startServer((req, res) =>
  json(res, 200, { auth: req.headers.authorization ?? null, tenant: req.headers['x-tenant'] ?? null }),
);

try {
  const order = [];

  // Middleware wraps the whole request (including retries, dedupe and hooks).
  const timing = async ({ request }, next) => {
    order.push(`timing:start ${request.method}`);
    try {
      return await next();
    } finally {
      order.push('timing:end');
    }
  };
  const cache = new Map();
  const memoize = async ({ request }, next) => {
    const key = `${request.method} ${request.url}`;
    if (cache.has(key)) return cache.get(key);
    const result = await next();
    cache.set(key, result);
    return result;
  };

  // A plugin bundles hooks + middleware + one-time setup under a unique name.
  const tenantPlugin = (tenant) => ({
    name: 'tenant',
    hooks: { beforeRequest: (req) => void req.headers.set('x-tenant', tenant) },
    middleware: timing,
    setup: () => void order.push('setup'),
  });

  let tokens = 0;
  const client = createClient({
    plugins: [tenantPlugin('acme'), bearerAuth(async () => `token-${++tokens}`)],
    middleware: memoize,
  });

  const first = await client.get(`${api.url}/me`);
  assert.deepEqual(first.data, { auth: 'Bearer token-1', tenant: 'acme' });
  await client.get(`${api.url}/me`); // served by the middleware cache
  assert.equal(api.count, 1);

  // extend(): child client inheriting everything, with overrides.
  const admin = client.extend({ headers: { 'x-role': 'admin' } });
  assert.ok(admin.getConfig().headers);
  console.log(order.join(' | '));
  console.log('middleware-plugins example passed');
} finally {
  await api.close();
}
