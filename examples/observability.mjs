// Logging and monitoring: the logger plugin (redacted, correlated log lines) and the monitor plugin
// (per-group counts, error codes, latency percentiles, Prometheus text, event stream).
// Docs: docs/logging-and-monitoring.md
import assert from 'node:assert/strict';
import { createClient, logger, monitor } from '@dipanshuhandoo/fetchforge';
import { json, startServer } from './_server.mjs';

const api = await startServer((req, res, count) => {
  if (req.url.startsWith('/flaky') && count % 2 === 1) return json(res, 503, { error: 'try later' });
  json(res, 200, { path: req.url });
});

try {
  const lines = [];
  const record = (level) => (message, fields) => lines.push({ level, message, fields });
  const events = [];
  const stats = monitor({ groupBy: 'route', onEvent: (event) => events.push(event) });

  const client = createClient({
    baseUrl: api.url,
    retry: { retries: 2, delay: 1 },
    plugins: [
      // Any object with debug/info/warn/error works: console, pino, winston, ...
      logger({
        logger: {
          debug: record('debug'),
          info: record('info'),
          warn: record('warn'),
          error: record('error'),
        },
      }),
      stats,
    ],
  });

  await client.get('/users/42', { params: { token: 'super-secret', page: 1 } });
  await client.get('/flaky');
  await assert.rejects(client.get('/users/7', { retry: false, signal: AbortSignal.abort() }));

  const first = lines[0];
  assert.ok(!JSON.stringify(lines).includes('super-secret'), 'secrets are redacted');
  assert.equal(typeof first.fields.requestId, 'string', 'every line carries a correlation id');
  assert.ok(lines.some((l) => l.level === 'warn' && /retrying/.test(l.message)));

  const snapshot = stats.snapshot();
  const groups = Object.keys(snapshot.groups);
  assert.ok(
    groups.some((name) => name.endsWith('/users/:id')),
    'ids are collapsed into :id',
  );
  assert.ok(events.some((e) => e.type === 'retry'));

  const text = stats.toPrometheus('myapp');
  assert.match(text, /myapp_requests_total/);
  console.log(text.split('\n').slice(0, 6).join('\n'));
  console.log('observability example passed');
} finally {
  await api.close();
}
