// Errors and messages: every typed error class and guard, custom message templates, and throwHttpErrors.
// Docs: docs/errors-and-messages.md
import assert from 'node:assert/strict';
import {
  DEFAULT_MESSAGES,
  FetchForgeError,
  HttpError,
  createClient,
  isAbortError,
  isFetchForgeError,
  isHttpError,
  isNetworkError,
  isTimeoutError,
} from '@dipanshuhandoo/fetchforge';
import { json, startServer } from './_server.mjs';

const api = await startServer((req, res) => {
  if (req.url === '/teapot') return json(res, 418, { reason: 'short and stout' });
  if (req.url === '/slow') return void setTimeout(() => json(res, 200, {}), 500);
  json(res, 200, { ok: true });
});

try {
  console.log('default http message template:', DEFAULT_MESSAGES.http);

  // Typed errors, with the server's parsed body attached.
  const client = createClient({ baseUrl: api.url });
  const http = await client.get('/teapot').catch((e) => e);
  assert.ok(isHttpError(http) && http instanceof HttpError);
  assert.equal(http.status, 418);
  assert.deepEqual(http.data, { reason: 'short and stout' });
  assert.equal(http.code, 'ERR_HTTP');

  // Custom messages: strings with {placeholders} or functions.
  const custom = createClient({
    baseUrl: api.url,
    timeout: 30,
    messages: {
      http: ({ status, method }) => `${method} failed with ${status}`,
      timeout: 'The server took longer than {timeout}ms',
    },
  });
  assert.equal((await custom.get('/teapot').catch((e) => e)).message, 'GET failed with 418');
  const timeout = await custom.get('/slow').catch((e) => e);
  assert.ok(isTimeoutError(timeout));
  assert.equal(timeout.message, 'The server took longer than 30ms');

  // Do not throw on HTTP errors: inspect result.error instead.
  const soft = await client.get('/teapot', { throwHttpErrors: (status) => status >= 500 });
  assert.equal(soft.ok, false);
  assert.equal(soft.error?.status, 418);

  // Network and abort errors.
  const dead = await createClient()
    .get('http://127.0.0.1:1/')
    .catch((e) => e);
  assert.ok(isNetworkError(dead));
  const controller = new AbortController();
  const pending = client.get('/slow', { signal: controller.signal, timeout: 5000 }).catch((e) => e);
  controller.abort();
  assert.ok(isAbortError(await pending));

  // Every error shares a base class and guard.
  assert.ok(isFetchForgeError(dead) && dead instanceof FetchForgeError);
  console.log('errors-messages example passed');
} finally {
  await api.close();
}
