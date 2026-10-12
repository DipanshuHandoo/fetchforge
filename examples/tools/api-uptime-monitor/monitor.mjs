import { setTimeout as sleep } from 'node:timers/promises';
import { httpUrl, positiveInteger } from '../_shared/runtime.mjs';

export function validateInput(input) {
  if (!Array.isArray(input.endpoints) || !input.endpoints.length) throw new Error('Configure endpoints');
  const names = new Set();
  const urls = new Set();
  for (const endpoint of input.endpoints) {
    httpUrl(endpoint.url);
    if (
      typeof endpoint.name !== 'string' ||
      !endpoint.name ||
      names.has(endpoint.name) ||
      urls.has(endpoint.url)
    ) {
      throw new Error('Endpoint names and URLs must be unique');
    }
    names.add(endpoint.name);
    urls.add(endpoint.url);
    const statuses = endpoint.expectedStatuses ?? [200];
    if (
      !statuses.length ||
      statuses.some((value) => !Number.isInteger(value) || value < 100 || value > 599)
    ) {
      throw new Error('Expected statuses must be HTTP status integers');
    }
    positiveInteger(endpoint.maxLatencyMs ?? input.maxLatencyMs, 'maxLatencyMs');
  }
  for (const key of ['intervalMs', 'windowMs', 'maxSamples', 'timeout']) positiveInteger(input[key], key);
  for (const key of ['availabilityTarget', 'latencyTarget']) {
    if (!Number.isFinite(input[key]) || input[key] < 0 || input[key] > 100) {
      throw new Error(`${key} must be 0..100`);
    }
  }
  if (input.webhook) httpUrl(input.webhook);
}

export function summarizeHistory(samples, input, now = Date.now()) {
  const recent = samples.filter((item) => item.at > now - input.windowMs).slice(-input.maxSamples);
  const availability = recent.length
    ? (100 * recent.filter((item) => item.healthy).length) / recent.length
    : null;
  const latencyCompliance = recent.length
    ? (100 * recent.filter((item) => item.healthy && item.fast).length) / recent.length
    : null;
  return {
    samples: recent,
    count: recent.length,
    availability,
    latencyCompliance,
    sloHealthy:
      recent.length > 0 &&
      availability >= input.availabilityTarget &&
      latencyCompliance >= input.latencyTarget,
  };
}

export async function checkCycle(clients, input, history, signal, now = Date.now) {
  validateInput(input);
  const durations = [];
  const requests = input.endpoints.map((endpoint, index) => ({
    url: endpoint.url,
    method: 'GET',
    schema: endpoint.schema,
    responseType: endpoint.schema ? 'json' : 'none',
    circuitBreaker: {
      isFailure: (error) =>
        ['ERR_NETWORK', 'ERR_TIMEOUT'].includes(error.code) ||
        (error.code === 'ERR_HTTP' &&
          !(endpoint.expectedStatuses ?? [200]).includes(error.status) &&
          (error.status >= 500 || error.status === 429)),
    },
    retry: {
      statusCodes: [408, 425, 429, 500, 502, 503, 504].filter(
        (code) => !(endpoint.expectedStatuses ?? [200]).includes(code),
      ),
    },
    hooks: {
      onComplete: ({ durationMs }) => {
        durations[index] = durationMs;
      },
    },
  }));
  console.log('[bulk]', requests.length, 'probes, concurrency 5');
  const { results } = await clients.client.bulk(requests, { concurrency: 5, signal });
  signal?.throwIfAborted();
  return results.map((item, index) => {
    const endpoint = input.endpoints[index];
    const status = item.status === 'fulfilled' ? item.result.status : (item.error?.status ?? null);
    const healthy = item.status === 'fulfilled' && (endpoint.expectedStatuses ?? [200]).includes(status);
    const durationMs = durations[index] ?? null;
    const fast = durationMs !== null && durationMs <= (endpoint.maxLatencyMs ?? input.maxLatencyMs);
    const at = now();
    const summary = summarizeHistory(
      [...(history.get(endpoint.name) ?? []), { at, healthy, fast }],
      input,
      at,
    );
    history.set(endpoint.name, summary.samples);
    const { samples: _samples, ...slo } = summary;
    return {
      name: endpoint.name,
      at,
      status,
      healthy,
      durationMs,
      attempts: item.status === 'fulfilled' ? item.result.attempts : (item.error?.attempts ?? 0),
      error:
        item.status === 'fulfilled'
          ? healthy
            ? ''
            : 'Unexpected HTTP status'
          : (item.error?.code ?? 'Skipped'),
      ...slo,
      windowMs: input.windowMs,
    };
  });
}

export async function sendAlerts(clients, input, records, notified, signal) {
  const failures = [];
  for (const record of records) {
    const healthy = record.healthy && record.sloHealthy;
    const previous = notified.get(record.name);
    if (previous === healthy || (previous === undefined && healthy)) {
      notified.set(record.name, healthy);
      continue;
    }
    const alert = { endpoint: record.name, state: healthy ? 'recovered' : 'unhealthy', ...record };
    try {
      if (input.webhook) await clients.alerts.post(input.webhook, alert, { signal });
      console.log('[alert]', record.name, alert.state);
      notified.set(record.name, healthy);
    } catch (error) {
      signal?.throwIfAborted();
      console.error('[alert failed]', record.name, error.code ?? error.name);
      failures.push({ endpoint: record.name, error: error.code ?? error.name });
    }
  }
  return failures;
}

export async function runMonitor(
  clients,
  input,
  { continuous = false, signal, report, maxCycles = Infinity } = {},
) {
  validateInput(input);
  const history = new Map();
  const notified = new Map();
  let latest;
  for (let cycle = 0; cycle < maxCycles; cycle++) {
    signal?.throwIfAborted();
    const records = await checkCycle(clients, input, history, signal);
    const alertErrors = await sendAlerts(clients, input, records, notified, signal);
    latest = { records, alertErrors, metrics: clients.stats.snapshot() };
    await report?.(latest);
    console.log(
      '[cycle]',
      records
        .map((item) => `${item.name}: ${item.healthy && item.sloHealthy ? 'healthy' : 'unhealthy'}`)
        .join(', '),
    );
    if (!continuous || cycle + 1 === maxCycles) break;
    await sleep(input.intervalMs, undefined, { signal });
  }
  return latest;
}
