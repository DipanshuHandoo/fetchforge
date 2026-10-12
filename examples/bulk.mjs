import assert from 'node:assert/strict';
import { createClient } from '@dipanshuhandoo/fetchforge';
import { json, startServer } from './_server.mjs';

let active = 0;
let peak = 0;
const api = await startServer(async (req, res) => {
  active++;
  peak = Math.max(peak, active);
  await new Promise((resolve) => setTimeout(resolve, 20));
  active--;
  if (req.url === '/bad') return json(res, 500, { error: 'boom' });
  json(res, 200, { path: req.url });
});

try {
  const client = createClient({ baseUrl: api.url });
  const paths = ['/a', '/b', '/bad', '/c', '/d', '/e'];
  const summary = await client.bulk(paths, { concurrency: 2 });

  assert.equal(summary.total, 6);
  assert.equal(summary.fulfilled, 5);
  assert.equal(summary.rejected, 1);
  assert.ok(peak <= 2, `concurrency limit respected (peak ${peak})`);
  assert.deepEqual(
    summary.results.map((r) => r.index),
    [0, 1, 2, 3, 4, 5],
  );
  console.log('bulk example passed');
} finally {
  await api.close();
}
