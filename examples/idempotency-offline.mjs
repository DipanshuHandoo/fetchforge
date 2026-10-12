// Safe writes: Idempotency-Key makes POST retryable without double charges, and the offline queue keeps
// writes made without a connection and replays them, in order, when the connection returns.
// Docs: docs/idempotency.md, docs/offline.md
import assert from 'node:assert/strict';
import { createClient, idempotency, isQueuedError, offlineQueue } from '@dipanshuhandoo/fetchforge';
import { memoryStore } from '@dipanshuhandoo/fetchforge/stores';
import { json, startServer } from './_server.mjs';

// A payments API that honours Idempotency-Key, like Stripe: a repeated key returns the first result.
const processed = new Map();
const received = [];
let dropNextResponse = true;
const api = await startServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
  });
  req.on('end', () => {
    const key = req.headers['idempotency-key'];
    received.push({ url: req.url, key, body });
    if (key && processed.has(key)) return json(res, 201, processed.get(key));
    const result = { id: `pay_${processed.size + 1}`, ...JSON.parse(body || '{}') };
    if (key) processed.set(key, result);
    // Simulate the classic failure: the charge succeeded but the response was lost (gateway 502).
    if (dropNextResponse) {
      dropNextResponse = false;
      return json(res, 502, { error: 'bad gateway' });
    }
    json(res, 201, result);
  });
});

try {
  // 1. Idempotency: POST is retried (the key makes it safe) and the server returns the original charge.
  const payments = createClient({
    baseUrl: api.url,
    retry: { retries: 2, delay: 10 },
    plugins: [idempotency()],
  });
  const charge = await payments.post('/charges', { amount: 1999 });
  assert.equal(charge.status, 201);
  assert.equal(charge.attempts, 2);
  assert.equal(received[0].key, received[1].key, 'the retry reused the key');
  assert.equal(processed.size, 1, 'charged exactly once');

  // Supply your own key (e.g. the order id) so even a user double-click or a page reload can't double-charge.
  await payments.post('/charges', { amount: 500 }, { meta: { idempotencyKey: 'order-42' } });
  await payments.post('/charges', { amount: 500 }, { meta: { idempotencyKey: 'order-42' } });
  assert.equal(processed.size, 2);

  // 2. Offline queue: writes made while offline are stored and replayed later.
  //    In a browser the default store is localStorage and replay starts on the `online` event.
  let online = false;
  const queue = offlineQueue({
    store: memoryStore(),
    isOnline: () => online,
    mode: 'resolve',
    onQueued: (item) => console.log(`queued ${item.method} ${new URL(item.url).pathname}`),
  });
  const app = createClient({ baseUrl: api.url, retry: false, plugins: [idempotency(), queue] });

  const saved = await app.post('/notes', { text: 'written on the train' });
  assert.equal(saved.status, 202);
  assert.ok(saved.queued, 'resolve mode returns 202 with the queue id');
  await app.put('/notes/1', { text: 'edited offline' });
  assert.equal((await queue.pending()).length, 2);

  online = true;
  const flushed = await queue.flush();
  assert.deepEqual(flushed, { sent: 2, dropped: 0, remaining: 0 });
  const replayed = received.slice(-2);
  assert.deepEqual(
    replayed.map((r) => r.url),
    ['/notes', '/notes/1'],
    'replayed in order',
  );
  assert.ok(replayed[0].key, 'the idempotency key was persisted, so a replay after a crash is still safe');

  // 'throw' mode (default) rejects with QueuedError, so the UI can show "will sync later".
  online = false;
  const strict = offlineQueue({ store: memoryStore(), isOnline: () => online });
  const error = await createClient({ baseUrl: api.url, plugins: [strict] })
    .post('/notes', { text: 'x' })
    .catch((e) => e);
  assert.ok(isQueuedError(error));
  strict.stop();
  queue.stop();

  console.log('idempotency and offline example passed');
} finally {
  await api.close();
}
