// Request options: query params, response types, JSON bodies, header removal, metrics, and abortAll().
// Docs: docs/requests-and-responses.md, docs/configuration.md, docs/metrics.md
import assert from 'node:assert/strict';
import { createClient } from '@dipanshuhandoo/fetchforge';
import { json, startServer } from './_server.mjs';

const api = await startServer((req, res) => {
  if (req.url?.startsWith('/text')) {
    res.writeHead(200, { 'content-type': 'text/plain' });
    return void res.end('hello');
  }
  if (req.url === '/hold') return; // never answers
  json(res, 200, { query: req.url, method: req.method, ct: req.headers['content-type'] ?? null });
});

try {
  const client = createClient({ baseUrl: api.url, headers: { 'x-app': 'demo' } });

  // Query params: arrays, dates, null/undefined skipped.
  const q = await client.get('/search', { params: { tag: ['a', 'b'], page: 2, skip: undefined } });
  assert.equal(q.data.query, '/search?tag=a&tag=b&page=2');

  // Response types.
  assert.equal((await client.get('/text', { responseType: 'text' })).data, 'hello');
  assert.equal((await client.get('/x', { responseType: 'none' })).data, undefined);
  const buf = await client.get('/text', { responseType: 'arrayBuffer' });
  assert.equal(buf.data.byteLength, 5);

  // JSON body and header removal (null removes an inherited header).
  const posted = await client.post('/p', undefined, { json: { a: 1 }, headers: { 'x-app': null } });
  assert.equal(posted.data.ct, 'application/json');

  // Metrics and cancellation of everything in flight.
  const hanging = client.get('/hold', { timeout: 5000 }).catch((e) => e);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(client.getMetrics().inFlight, 1);
  client.abortAll();
  assert.equal((await hanging).code, 'ERR_ABORTED');

  const m = client.getMetrics();
  assert.equal(m.inFlight, 0);
  assert.equal(m.aborted, 1);
  assert.ok(m.latency.count > 0 && m.statusCodes['200'] > 0);
  console.log('metrics:', { requests: m.requests, succeeded: m.succeeded, aborted: m.aborted });
  client.resetMetrics();
  assert.equal(client.getMetrics().requests, 0);
  console.log('request-options example passed');
} finally {
  await api.close();
}
