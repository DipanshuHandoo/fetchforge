import { json, startServer } from '../../_server.mjs';

export async function startDemo() {
  let healthy = false;
  let flaky = 0;
  const alerts = [];
  const site = await startServer((req, res) => {
    if (req.url === '/webhook') {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        alerts.push(JSON.parse(body));
        json(res, 200, { received: true });
      });
      return;
    }
    if (req.url === '/unhealthy') return json(res, healthy ? 200 : 503, { ok: healthy });
    if (req.url === '/flaky' && ++flaky === 1) return json(res, 503, { ok: false });
    if (req.url === '/schema') return json(res, 200, { ok: 'not-a-boolean' });
    if (req.url === '/missing') return json(res, 404, {});
    if (req.url === '/slow') return setTimeout(() => json(res, 200, { ok: true }), 60);
    json(res, 200, { ok: true });
  });
  return {
    ...site,
    alerts,
    recover: () => {
      healthy = true;
    },
    fail: () => {
      healthy = false;
    },
    input: {
      endpoints: [
        { name: 'healthy', url: `${site.url}/healthy` },
        { name: 'flaky', url: `${site.url}/flaky` },
        { name: 'unhealthy', url: `${site.url}/unhealthy` },
        { name: 'expected-404', url: `${site.url}/missing`, expectedStatuses: [404] },
        { name: 'slow', url: `${site.url}/slow`, maxLatencyMs: 20 },
        {
          name: 'schema',
          url: `${site.url}/schema`,
          schema(value) {
            if (typeof value?.ok !== 'boolean') throw new Error('Expected boolean ok');
            return value;
          },
        },
      ],
      webhook: `${site.url}/webhook`,
    },
  };
}
