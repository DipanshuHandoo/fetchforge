// Circuit breaker: stop calling a failing service, observe state changes, probe recovery, and reset manually.
// Docs: docs/circuit-breaker.md
import assert from 'node:assert/strict';
import { createClient, isCircuitOpenError } from '@dipanshuhandoo/fetchforge';
import { json, startServer } from './_server.mjs';

let healthy = false;
const api = await startServer((_req, res) => (healthy ? json(res, 200, { ok: true }) : json(res, 500, {})));

try {
  const changes = [];
  const client = createClient({
    circuitBreaker: { failureThreshold: 3, resetTimeout: 100, successThreshold: 1 },
    hooks: { onCircuitStateChange: (info) => void changes.push(info.to ?? info) },
  });
  const url = `${api.url}/x`;

  for (let i = 0; i < 3; i++) await client.get(url).catch(() => undefined);
  assert.equal(client.getCircuitState(url), 'open');

  // While open nothing reaches the server.
  const seen = api.count;
  const rejected = await client.get(url).catch((e) => e);
  assert.ok(isCircuitOpenError(rejected));
  assert.ok(rejected.retryAfter >= 0);
  assert.equal(api.count, seen);

  // After resetTimeout one probe is allowed; success closes the circuit.
  healthy = true;
  await new Promise((r) => setTimeout(r, 120));
  await client.get(url);
  assert.equal(client.getCircuitState(url), 'closed');

  client.resetCircuit(); // manual reset of every circuit
  assert.equal(client.getMetrics().circuitRejections, 1);
  console.log('circuit-breaker example passed; transitions:', changes.length);
} finally {
  await api.close();
}
