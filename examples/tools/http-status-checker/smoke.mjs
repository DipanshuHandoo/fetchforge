import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createClient } from '@dipanshuhandoo/fetchforge';
import { startServer } from '../../_server.mjs';
import { checkBulk, checkUrl } from './checker.mjs';
import { createStatusClient } from './client.mjs';
import { startDemo } from './demo.mjs';
import { reportsDir, writeCsv } from './report.mjs';

const work = await mkdtemp(path.join(tmpdir(), 'status-examples-'));
let active = 0;
let peak = 0;
const site = await startServer((req, res) => {
  active++;
  peak = Math.max(peak, active);
  setTimeout(() => {
    active--;
    if (req.url === '/disconnect') return res.destroy();
    const locations = { '/loop': '/loop', '/bad': 'mailto:test@example.com', '/unreachable': '/disconnect' };
    const location = req.url.startsWith('/endless/')
      ? `/endless/${Number(req.url.split('/')[2]) + 1}`
      : locations[req.url];
    const status = req.url === '/failure' ? 500 : location || req.url === '/missing-location' ? 301 : 200;
    res.writeHead(status, location ? { location } : {});
    res.end();
  }, 20);
});

try {
  const client = createClient({ retry: false, redirect: 'manual', throwHttpErrors: false });
  for (const [url, error] of [
    ['/loop', 'Redirect loop'],
    ['/bad', 'Redirect is not HTTP(S)'],
    ['/missing-location', 'Redirect has no Location header'],
    ['/endless/0', 'More than 10 redirects'],
  ]) {
    assert.equal((await checkUrl(client, site.url + url)).error, error);
    assert.equal((await checkBulk(client, [site.url + url]))[0].error, error);
  }
  assert.ok((await checkUrl(client, 'not a URL')).error);
  const mixed = await checkBulk(client, ['not a URL', `${site.url}/failure`, `${site.url}/unreachable`]);
  assert.ok(mixed[0].error);
  assert.equal(mixed[1].finalStatus, 500);
  assert.equal(mixed[2].firstStatus, 301);
  assert.equal(mixed[2].finalStatus, null);
  assert.equal(mixed[2].finalUrl, `${site.url}/disconnect`);
  assert.ok(mixed[2].error);
  const timed = await checkUrl(createClient({ timeout: 1, retry: false }), `${site.url}/timeout`);
  assert.match(timed.error, /timed out/i);
  await new Promise((resolve) => setTimeout(resolve, 30));
  peak = 0;
  const urls = Array.from({ length: 50 }, (_, index) => `${site.url}/page/${index}`);
  const records = await checkBulk(client, urls);
  assert.equal(peak, 5, 'built-in bulk processes exactly five requests concurrently');
  assert.deepEqual(
    records.map((record) => record.url),
    urls,
  );
  assert.ok(records.every((record) => record.finalStatus === 200 && !record.error));
  peak = 0;
  for (const url of urls) await checkUrl(client, url);
  assert.equal(peak, 1, 'sequential checks never overlap');

  const demo = await startDemo();
  try {
    const demoResults = await checkBulk(
      createClient({ retry: { retries: 1, delay: 1 }, redirect: 'manual', throwHttpErrors: false }),
      demo.urls,
    );
    assert.equal(demoResults.filter((record) => record.finalStatus === 404).length, 10);
    assert.equal(demoResults.filter((record) => record.finalStatus === 200).length, 40);
    assert.deepEqual(
      demoResults[1].chain.map((hop) => hop.status),
      [301, 302, 200],
    );
    assert.equal(demoResults[1].finalUrl, demo.urls[1].replace('/redirect/', '/ok/'));
  } finally {
    await demo.close();
  }

  const { client: cached, stats, responses } = createStatusClient();
  try {
    await checkUrl(cached, urls[0]);
    await checkUrl(cached, urls[0]);
    assert.equal(responses.stats().hits, 1);
  } finally {
    stats.stop();
  }
  const file = path.join(work, 'escaping.csv');
  await writeCsv([{ ...records[0], error: '=SUM(1,2)"\nmessage' }], file);
  assert.match(await readFile(file, 'utf8'), /"'=SUM\(1,2\)""\nmessage"/);
  const nested = path.join(work, 'nested', 'reports', 'report.csv');
  await writeCsv(records, nested);
  assert.match(await readFile(nested, 'utf8'), /^"url"/);
  await assert.rejects(writeCsv(records, path.join(file, 'report.csv')));

  for (const mode of ['sequential', 'bulk']) {
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [fileURLToPath(new URL(`./${mode}.mjs`, import.meta.url)), '--demo'],
      { cwd: work, maxBuffer: 2_000_000 },
    );
    const csv = await readFile(path.join(reportsDir, `status-${mode}.csv`), 'utf8');
    assert.equal(csv.trim().split('\n').length, 51);
    assert.match(stdout, /\[beforeRequest\]/);
    assert.match(stdout, /\[beforeRetry\]/);
    assert.match(stdout, /\[monitor summary\]/);
    if (mode === 'bulk') assert.match(stdout, /\[bulk\] 50 requests, concurrency 5/);
    await promisify(execFile)(
      process.execPath,
      [fileURLToPath(new URL(`./${mode}.mjs`, import.meta.url)), urls[0]],
      { cwd: work, maxBuffer: 2_000_000 },
    );
    assert.equal(
      (await readFile(path.join(reportsDir, `status-${mode}.csv`), 'utf8')).trim().split('\n').length,
      2,
    );
  }
  console.log('http-status-checker smoke test passed (50 URLs, sequential and bulk concurrency 5)');
} finally {
  await site.close();
  await rm(work, { recursive: true, force: true });
}
