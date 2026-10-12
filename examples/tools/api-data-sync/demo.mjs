import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { json, startServer } from '../../_server.mjs';

export async function startDemo() {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'fetchforge-sync-demo-'));
  const records = Array.from({ length: 20 }, (_, id) => ({
    id: id + 1,
    name: `Person ${id + 1}`,
    email: `person${id + 1}@example.com`,
  }));
  const processed = new Map();
  const keys = [];
  let token = 'fresh';
  let refreshes = 0;
  let failureId;
  let lostResponse = true;
  let active = 0;
  let peak = 0;
  const site = await startServer((req, res) => {
    if (req.url === '/token') {
      refreshes++;
      token = 'fresh';
      return json(res, 200, { access_token: token });
    }
    if (req.url.startsWith('/records')) {
      if (req.headers.authorization !== `Bearer ${token}`) return json(res, 401, {});
      const url = new URL(req.url, 'http://localhost');
      const offset = Number(url.searchParams.get('cursor') ?? 0);
      const limit = Number(url.searchParams.get('limit') ?? 10);
      const items = records.slice(offset, offset + limit);
      return json(res, 200, {
        items,
        nextCursor: offset + limit < records.length ? String(offset + limit) : null,
      });
    }
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      const payload = JSON.parse(body);
      const key = req.headers['idempotency-key'];
      keys.push(key);
      active++;
      peak = Math.max(peak, active);
      setTimeout(() => {
        active--;
        if (payload.externalId === failureId) return json(res, 500, {});
        if (processed.has(key)) return json(res, 201, processed.get(key));
        processed.set(key, payload);
        if (lostResponse) {
          lostResponse = false;
          return json(res, 502, { error: 'Response lost after write' });
        }
        json(res, 201, payload);
      }, 20);
    });
  });
  return {
    ...site,
    stateDir,
    processed,
    keys,
    get refreshes() {
      return refreshes;
    },
    get peak() {
      return peak;
    },
    fail: (id) => {
      failureId = id;
    },
    input: {
      sourceUrl: site.url,
      destinationUrl: site.url,
      pageSize: 10,
      requestsPerSecond: 5,
      sourceAuth: { token: 'expired', refreshUrl: `${site.url}/token`, refreshToken: 'local-demo-only' },
    },
    async close() {
      await site.close();
      await rm(stateDir, { recursive: true, force: true });
    },
  };
}
