import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createClient, logger, monitor } from '../src/index.ts';
import { redactUrl } from '../src/logger.ts';
import { closedPortUrl, json, startServer, wait } from './helpers.ts';

type Line = { level: string; message: string; fields: Record<string, unknown> };

function memorySink() {
  const lines: Line[] = [];
  const at =
    (level: string) =>
    (message: string, fields: Record<string, unknown> = {}) => {
      lines.push({ level, message, fields });
    };
  return { lines, sink: { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') } };
}

test('logger logs success at info with a correlation id header, and redacts secrets', async () => {
  const seen: Array<string | string[] | undefined> = [];
  const server = await startServer((req, res) => {
    seen.push(req.headers['x-request-id']);
    json(res, 200, { ok: true });
  });
  try {
    const { lines, sink } = memorySink();
    const api = createClient({ plugins: [logger({ logger: sink })] });
    await api.get(`${server.url}/a`, { params: { token: 'SECRET', page: 2 } });
    assert.equal(lines.length, 1);
    const [line] = lines as [Line];
    assert.equal(line.level, 'info');
    assert.match(line.message, /-> 200 in \d+ms/);
    assert.ok(!JSON.stringify(line).includes('SECRET'));
    assert.match(String(line.fields.url), /page=2/);
    assert.equal(typeof line.fields.requestId, 'string');
    assert.equal(seen[0], line.fields.requestId);
  } finally {
    await server.close();
  }
});

test('logger keeps one request id across retries and logs retries and failures', async () => {
  const server = await startServer((_req, res) => json(res, 503, {}));
  try {
    const { lines, sink } = memorySink();
    const api = createClient({
      retry: { retries: 2, delay: 1, jitter: 0 },
      plugins: [logger({ logger: sink })],
    });
    await assert.rejects(api.get(server.url));
    const retries = lines.filter((l) => l.level === 'warn');
    const failure = lines.find((l) => l.level === 'error');
    assert.equal(retries.length, 2);
    assert.ok(failure);
    assert.equal(failure.fields.code, 'ERR_HTTP');
    assert.equal(failure.fields.status, 503);
    assert.equal(failure.fields.attempts, 3);
    const ids = new Set([...retries, failure].map((l) => l.fields.requestId));
    assert.equal(ids.size, 1);
  } finally {
    await server.close();
  }
});

test('logger honours level, slow threshold, caller request id and header redaction', async () => {
  const server = await startServer(async (_req, res) => {
    await wait(15);
    json(res, 200, {});
  });
  try {
    const quiet = memorySink();
    await createClient({ plugins: [logger({ logger: quiet.sink, level: 'error' })] }).get(server.url);
    assert.equal(quiet.lines.length, 0);

    const slow = memorySink();
    await createClient({ plugins: [logger({ logger: slow.sink, slowThreshold: 1 })] }).get(server.url);
    assert.equal(slow.lines[0]?.level, 'warn');
    assert.match(slow.lines[0]?.message ?? '', /slow/);

    const dbg = memorySink();
    await createClient({ plugins: [logger({ logger: dbg.sink, level: 'debug', logHeaders: true })] }).get(
      server.url,
      {
        headers: { authorization: 'Bearer SECRET', 'x-request-id': 'mine' },
      },
    );
    const start = dbg.lines.find((l) => l.level === 'debug');
    assert.ok(start);
    assert.ok(!JSON.stringify(start).includes('SECRET'));
    assert.equal((start.fields.headers as Record<string, string>).authorization, '[redacted]');
    assert.equal(start.fields.requestId, 'mine');
  } finally {
    await server.close();
  }
});

test('logger never breaks a request when the sink throws, and validates options', async () => {
  const server = await startServer((_req, res) => json(res, 200, {}));
  try {
    const bad = {
      info() {
        throw new Error('sink down');
      },
    };
    const result = await createClient({ plugins: [logger({ logger: bad })] }).get(server.url);
    assert.equal(result.status, 200);
    assert.throws(() => logger({ level: 'loud' as never }), RangeError);
    assert.throws(() => logger({ slowThreshold: -1 }), RangeError);
  } finally {
    await server.close();
  }
});

test('logger logs circuit changes and strips credentials from URLs', async () => {
  const url = await closedPortUrl();
  const { lines, sink } = memorySink();
  const api = createClient({
    circuitBreaker: { failureThreshold: 1, resetTimeout: 60000 },
    plugins: [logger({ logger: sink })],
  });
  await assert.rejects(api.get(url));
  assert.ok(lines.some((l) => l.level === 'warn' && /closed -> open/.test(l.message)));
  assert.equal(
    redactUrl('http://user:pw@host/x?Token=1&a=2', new Set(['token'])),
    'http://host/x?Token=%5Bredacted%5D&a=2',
  );
  assert.equal(redactUrl('not a url', new Set()), 'not a url');
});

test('monitor aggregates counts, errors, status codes and latency per group', async () => {
  const server = await startServer((req, res) => json(res, req.url === '/bad' ? 500 : 200, {}));
  try {
    const events: string[] = [];
    const mon = monitor({ onEvent: (e) => events.push(e.type) });
    const api = createClient({ plugins: [mon] });
    await api.get(`${server.url}/ok`);
    await api.get(`${server.url}/ok`);
    await assert.rejects(api.get(`${server.url}/bad`));
    const group = Object.values(mon.snapshot().groups)[0];
    assert.ok(group);
    assert.equal(group.requests, 3);
    assert.equal(group.succeeded, 2);
    assert.equal(group.failed, 1);
    assert.deepEqual(group.errors, { ERR_HTTP: 1 });
    assert.deepEqual(group.statusCodes, { '200': 2, '500': 1 });
    assert.equal(group.latency.count, 3);
    assert.ok(group.latency.p50 <= group.latency.p99);
    assert.ok(group.latency.p99 <= group.latency.max);
    assert.deepEqual(events, ['request', 'request', 'request']);
  } finally {
    await server.close();
  }
});

test('monitor counts retries, groups by route with ids collapsed, and resets', async () => {
  const server = await startServer((_req, res) => json(res, 503, {}));
  try {
    const mon = monitor({ groupBy: 'route' });
    const api = createClient({ retry: { retries: 1, delay: 1, jitter: 0 }, plugins: [mon] });
    await assert.rejects(api.get(`${server.url}/users/123`));
    await assert.rejects(api.get(`${server.url}/users/456`));
    const { groups } = mon.snapshot();
    const names = Object.keys(groups);
    assert.equal(names.length, 1);
    assert.ok(names[0]?.endsWith('/users/:id'));
    assert.equal(groups[names[0] as string]?.retries, 2);
    assert.equal(groups[names[0] as string]?.attempts, 4);
    mon.reset();
    assert.deepEqual(mon.snapshot().groups, {});
  } finally {
    await server.close();
  }
});

test('monitor tracks circuits, caps groups, and supports custom grouping', async () => {
  const url = await closedPortUrl();
  const mon = monitor({ groupBy: ({ method }) => method, maxGroups: 1 });
  const api = createClient({ circuitBreaker: { failureThreshold: 1, resetTimeout: 60000 }, plugins: [mon] });
  await assert.rejects(api.get(url));
  await assert.rejects(api.post(url, {}), (e: Error) => e.name === 'CircuitOpenError');
  const snap = mon.snapshot();
  assert.deepEqual(Object.keys(snap.groups).sort(), ['GET', '__other__']);
  assert.equal(Object.values(snap.circuits)[0]?.opened, 1);
  assert.equal(Object.values(snap.circuits)[0]?.state, 'open');
});

test('monitor exports Prometheus text and validates options', async () => {
  const server = await startServer((_req, res) => json(res, 200, {}));
  try {
    const mon = monitor({ buckets: [1000] });
    await createClient({ plugins: [mon] }).get(server.url);
    const text = mon.toPrometheus('my-app');
    assert.match(text, /# TYPE my_app_requests_total counter/);
    assert.match(text, /my_app_requests_total\{group="http:\/\/127\.0\.0\.1:\d+",outcome="success"\} 1/);
    assert.match(text, /my_app_request_duration_ms_bucket\{group="[^"]+",le="\+Inf"\} 1/);
    assert.match(text, /my_app_request_duration_ms_count\{group="[^"]+"\} 1/);
    assert.throws(() => monitor({ buckets: [] }), RangeError);
    assert.throws(() => monitor({ buckets: [10, 5] }), RangeError);
    assert.throws(() => monitor({ maxGroups: 0 }), RangeError);
  } finally {
    await server.close();
  }
});

test('a throwing monitor onEvent never breaks requests', async () => {
  const server = await startServer((_req, res) => json(res, 200, {}));
  try {
    const mon = monitor({
      onEvent: () => {
        throw new Error('boom');
      },
    });
    const result = await createClient({ plugins: [mon] }).get(server.url);
    assert.equal(result.status, 200);
    assert.equal(Object.values(mon.snapshot().groups)[0]?.succeeded, 1);
  } finally {
    await server.close();
  }
});
