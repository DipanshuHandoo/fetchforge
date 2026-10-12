import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { json, startServer } from '../../_server.mjs';
import { runExample } from '../_shared/smoke.mjs';
import { createMonitorClients } from './client.mjs';
import { startDemo } from './demo.mjs';
import { input } from './input.mjs';
import { checkCycle, runMonitor, sendAlerts, summarizeHistory, validateInput } from './monitor.mjs';

const work = await mkdtemp(path.join(tmpdir(), 'uptime-test-'));
const demo = await startDemo();
const settings = { ...input, ...demo.input, intervalMs: 5, availabilityTarget: 50, latencyTarget: 50 };
const clients = createMonitorClients(settings);
let failingWebhook;
let bulkServer;
try {
  assert.throws(() => validateInput({ ...settings, endpoints: [] }));
  assert.throws(() => validateInput({ ...settings, availabilityTarget: 101 }));
  const window = summarizeHistory(
    [
      { at: 50, healthy: false, fast: false },
      { at: 100, healthy: true, fast: true },
      { at: 120, healthy: false, fast: false },
    ],
    { ...settings, windowMs: 100, maxSamples: 2 },
    150,
  );
  assert.equal(window.count, 2);
  assert.equal(window.availability, 50);
  assert.equal(summarizeHistory([], settings).sloHealthy, false);
  const history = new Map();
  const notified = new Map();
  const records = await checkCycle(clients, settings, history);
  assert.equal(records.find((item) => item.name === 'healthy').healthy, true);
  assert.equal(records.find((item) => item.name === 'flaky').healthy, true);
  assert.equal(records.find((item) => item.name === 'expected-404').healthy, true);
  assert.equal(records.find((item) => item.name === 'slow').sloHealthy, false);
  assert.equal(records.find((item) => item.name === 'schema').error, 'ERR_VALIDATION');
  assert.equal(clients.stats.snapshot().groups[`${demo.url}/flaky`].retries, 1);
  assert.deepEqual(await sendAlerts(clients, settings, records, notified), []);
  assert.equal(demo.alerts.length, 3);
  await sendAlerts(clients, settings, records, notified);
  assert.equal(demo.alerts.length, 3, 'no repeated unchanged alerts');
  demo.recover();
  const recovered = await checkCycle(clients, settings, history);
  await sendAlerts(clients, settings, recovered, notified);
  assert.ok(demo.alerts.some((alert) => alert.name === 'unhealthy' && alert.state === 'recovered'));
  failingWebhook = await startServer((_req, res) => json(res, 500, {}));
  const pending = new Map();
  const unhealthy = records.filter((item) => item.name === 'unhealthy');
  const failures = await sendAlerts(
    clients,
    { ...settings, webhook: failingWebhook.url },
    unhealthy,
    pending,
  );
  assert.equal(failures.length, 1);
  assert.equal(pending.size, 0, 'failed delivery remains pending');
  assert.equal(failingWebhook.count, 2, 'webhook retries are explicit');
  await sendAlerts(clients, settings, unhealthy, pending);
  assert.equal(pending.get('unhealthy'), false);

  const isolated = { ...settings, endpoints: [settings.endpoints[0], settings.endpoints[2]], webhook: '' };
  demo.recover();
  demo.input.endpoints[2].expectedStatuses = [503];
  const unexpected = await checkCycle(clients, isolated, new Map());
  assert.equal(unexpected[1].healthy, false, 'unexpected 200 is unhealthy');
  delete demo.input.endpoints[2].expectedStatuses;
  let reports = 0;
  let reporting = false;
  await runMonitor(
    clients,
    { ...settings, endpoints: [settings.endpoints[0]], webhook: '' },
    {
      continuous: true,
      maxCycles: 2,
      async report() {
        assert.equal(reporting, false);
        reporting = true;
        await sleep(20);
        reporting = false;
        reports++;
      },
    },
  );
  assert.equal(reports, 2);
  demo.fail();
  const circuitClient = clients.client.extend({
    retry: false,
    circuitBreaker: { failureThreshold: 2, resetTimeout: 50 },
  });
  try {
    const circuitClients = { ...clients, client: circuitClient };
    const circuitSettings = {
      ...settings,
      endpoints: [settings.endpoints[0], settings.endpoints[2]],
      webhook: '',
    };
    await checkCycle(circuitClients, circuitSettings, new Map());
    await checkCycle(circuitClients, circuitSettings, new Map());
    const open = await checkCycle(circuitClients, circuitSettings, new Map());
    assert.equal(open[0].healthy, true, 'one failed route does not open another route');
    assert.equal(open[1].error, 'ERR_CIRCUIT_OPEN');
    demo.recover();
    await sleep(70);
    const recovery = await checkCycle(circuitClients, circuitSettings, new Map());
    assert.equal(recovery[1].healthy, true);
    assert.equal(circuitClient.getCircuitState(settings.endpoints[2].url), 'closed');
  } finally {
    circuitClient.abortAll();
  }
  let active = 0;
  let peak = 0;
  bulkServer = await startServer((_req, res) => {
    active++;
    peak = Math.max(peak, active);
    setTimeout(() => {
      active--;
      json(res, 200, {});
    }, 20);
  });
  const bulk = await checkCycle(
    clients,
    {
      ...settings,
      endpoints: Array.from({ length: 20 }, (_, index) => ({
        name: `probe-${index}`,
        url: `${bulkServer.url}/${index}`,
      })),
      webhook: '',
    },
    new Map(),
  );
  assert.equal(bulk.length, 20);
  assert.equal(peak, 5, 'bulk probes actually overlap up to five slots');
  const controller = new AbortController();
  await assert.rejects(
    runMonitor(clients, settings, {
      continuous: true,
      signal: controller.signal,
      report: () => controller.abort(),
    }),
  );
  const cli = await runExample(path.join(import.meta.dirname, 'index.mjs'), ['--demo'], work);
  assert.equal(cli.code, 1, cli.stderr);
  assert.equal(JSON.parse(await readFile(path.join(work, 'summary.json'))).records.length, 6);
  assert.match(cli.stdout, /\[alert\]/);
  console.log('api-uptime-monitor smoke passed (health, SLOs, retry, schemas, transition alerts, shutdown)');
} finally {
  clients.close();
  await failingWebhook?.close();
  await bulkServer?.close();
  await demo.close();
  await rm(work, { recursive: true, force: true });
}
