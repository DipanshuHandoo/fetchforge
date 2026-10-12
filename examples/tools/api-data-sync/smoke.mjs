import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { json, startServer } from '../../_server.mjs';
import { runExample } from '../_shared/smoke.mjs';
import { lockCheckpoint, readCheckpoint } from './checkpoint.mjs';
import { createSyncClients } from './client.mjs';
import { startDemo } from './demo.mjs';
import { input } from './input.mjs';
import { reportSync } from './report.mjs';
import { jobFingerprint, prepareRecords, readPage, syncRecords } from './sync.mjs';

const work = await mkdtemp(path.join(tmpdir(), 'sync-test-'));
const demo = await startDemo();
const settings = { ...input, ...demo.input, requestsPerSecond: 100 };
const clients = createSyncClients(settings);
let invalidSource;
try {
  assert.throws(() => readPage({ items: [] }));
  assert.throws(() => prepareRecords([{ id: 1 }, { id: 1 }], settings, new Set()), /identity/);
  assert.throws(() => prepareRecords([{ id: 1 }], { ...settings, transform: () => null }, new Set()));
  const first = prepareRecords([{ id: 1, name: 'A' }], settings, new Set());
  const again = prepareRecords([{ id: 1, name: 'A' }], settings, new Set());
  assert.equal(first[0].meta.idempotencyKey, again[0].meta.idempotencyKey);
  demo.fail(7);
  const interrupted = await syncRecords(clients, settings, { stateDir: demo.stateDir });
  assert.equal(interrupted.complete, false);
  assert.deepEqual(
    interrupted.failures.map((item) => item.id),
    ['7'],
  );
  const checkpoint = path.join(demo.stateDir, 'checkpoint.json');
  const saved = JSON.parse(await readFile(checkpoint, 'utf8'));
  assert.equal(saved.cursor, null);
  assert.equal(saved.records, 0, 'partial page never advances');
  assert.equal(demo.processed.size, 9);
  assert.equal(demo.peak, 5, 'bulk reaches requested concurrency');
  assert.equal(demo.refreshes, 1, 'source token refresh works');
  demo.fail(undefined);
  const result = await syncRecords(clients, settings, { stateDir: demo.stateDir });
  assert.equal(result.complete, true);
  assert.equal(result.pages, 2);
  assert.equal(result.records, 20);
  assert.equal(demo.processed.size, 20, 'replayed successful writes are deduplicated');
  assert.ok(demo.keys.length > demo.processed.size, 'retries/replay actually occurred');
  assert.equal((await syncRecords(clients, settings, { stateDir: demo.stateDir })).alreadyComplete, true);
  await reportSync(result, work);
  assert.equal(JSON.parse(await readFile(path.join(work, 'summary.json'))).records, 20);
  await assert.rejects(
    syncRecords(clients, { ...settings, jobId: 'different-job' }, { stateDir: demo.stateDir }),
    /Checkpoint/,
  );
  await writeFile(path.join(work, 'corrupt.json'), '{}');
  await assert.rejects(
    readCheckpoint(path.join(work, 'corrupt.json'), jobFingerprint(settings)),
    /Checkpoint/,
  );
  const unlock = await lockCheckpoint(work);
  try {
    await assert.rejects(lockCheckpoint(work), /locked/);
  } finally {
    await unlock();
  }
  invalidSource = await startServer((_req, res) => json(res, 200, { items: [], nextCursor: 'same' }));
  const invalidSettings = { ...settings, sourceUrl: invalidSource.url, sourceAuth: {}, pageSize: 1 };
  const invalidClients = createSyncClients(invalidSettings);
  try {
    await assert.rejects(
      syncRecords(invalidClients, invalidSettings, { stateDir: path.join(work, 'cursor') }),
      /cursor did not advance/,
    );
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      syncRecords(invalidClients, invalidSettings, {
        stateDir: path.join(work, 'cancel'),
        signal: controller.signal,
      }),
    );
  } finally {
    invalidClients.close();
  }
  const cli = await runExample(
    path.join(import.meta.dirname, 'index.mjs'),
    ['--demo'],
    path.join(work, 'cli'),
  );
  assert.equal(cli.code, 0, cli.stderr);
  assert.equal(JSON.parse(await readFile(path.join(work, 'cli', 'summary.json'))).records, 20);
  assert.match(cli.stdout, /\[rateLimit\]/);
  assert.match(cli.stdout, /\[authRefresh\]/);
  demo.fail(17);
  const pageTwoState = path.join(work, 'page-two');
  const partialSecond = await syncRecords(clients, settings, { stateDir: pageTwoState });
  assert.equal(partialSecond.pages, 1);
  assert.equal(partialSecond.records, 10);
  assert.equal(partialSecond.cursor, '10');
  demo.fail(undefined);
  assert.equal((await syncRecords(clients, settings, { stateDir: pageTwoState })).records, 20);
  const controller = new AbortController();
  const cancelDestination = clients.destination.extend({
    hooks: { beforeRequest: () => controller.abort() },
  });
  try {
    const canceledState = path.join(work, 'mid-page-cancel');
    await assert.rejects(
      syncRecords({ ...clients, destination: cancelDestination }, settings, {
        stateDir: canceledState,
        signal: controller.signal,
      }),
    );
    assert.equal(JSON.parse(await readFile(path.join(canceledState, 'checkpoint.json'))).records, 0);
    await assert.rejects(readFile(path.join(canceledState, 'checkpoint.lock')), { code: 'ENOENT' });
  } finally {
    cancelDestination.abortAll();
  }
  console.log(
    'api-data-sync smoke passed (bulk concurrency 5, auth, retry, checkpoint, failure/replay, idempotency)',
  );
} finally {
  clients.close();
  await invalidSource?.close();
  await demo.close();
  await rm(work, { recursive: true, force: true });
}
