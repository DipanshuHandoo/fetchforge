import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { json, startServer } from '../../_server.mjs';
import { runExample } from '../_shared/smoke.mjs';
import { auditSitemap, extractLinks, parseSitemap } from './auditor.mjs';
import { createAuditClients } from './client.mjs';
import { startDemo } from './demo.mjs';
import { input } from './input.mjs';
import { readLocal } from './reader.mjs';
import { reportAudit } from './report.mjs';

const work = await mkdtemp(path.join(tmpdir(), 'sitemap-audit-test-'));
const demo = await startDemo();
const controller = new AbortController();
const settings = { ...input, ...demo.input };
const clients = createAuditClients(settings, controller.signal);
let extra;
try {
  assert.deepEqual(parseSitemap('<urlset/>'), { kind: 'pages', locations: [] });
  assert.deepEqual(
    parseSitemap(
      '<s:urlset xmlns:s="urn:test"><s:url><s:loc>https://example.com/?a=1&amp;b=2</s:loc></s:url></s:urlset>',
    ).locations,
    ['https://example.com/?a=1&b=2'],
  );
  for (const text of ['<bad/>', '<urlset><url/></urlset>', '<urlset>', '<!DOCTYPE x><urlset/>']) {
    assert.throws(() => parseSitemap(text));
  }
  assert.deepEqual(
    extractLinks(
      '<base href="/base/"><a href="a#x"></a><a href="a"></a><a href="#skip"></a><a href="javascript:alert(1)"></a>',
      'https://example.com/start',
    ),
    ['https://example.com/base/a'],
  );
  const report = await auditSitemap(clients, settings, controller.signal);
  assert.equal(report.summary.pages, 3);
  assert.equal(report.summary.brokenPages, 1);
  assert.equal(report.summary.links, 6);
  assert.equal(report.summary.brokenLinks, 4);
  assert.ok(report.links.some((link) => link.outbound));
  assert.ok(
    !demo.requests.some((req) => req.url === '/good' && req.method === 'GET'),
    'linked pages are not crawled',
  );
  await reportAudit(report, work);
  assert.equal((await readFile(path.join(work, 'pages.csv'), 'utf8')).trim().split('\n').length, 4);
  assert.equal(JSON.parse(await readFile(path.join(work, 'summary.json'))).complete, true);
  const cycle = await auditSitemap(clients, { ...settings, sitemap: `${demo.url}/cycle.xml` });
  assert.equal(cycle.summary.complete, false);
  const limited = await auditSitemap(clients, { ...settings, maxPages: 1, maxLinks: 1 });
  assert.equal(limited.summary.complete, false);
  const noLinks = await auditSitemap(clients, { ...settings, inspectLinks: false });
  assert.equal(noLinks.links.length, 0);
  const xmlFile = path.join(work, 'local.xml');
  await writeFile(xmlFile, `<urlset><url><loc>${demo.url}/page</loc></url></urlset>`);
  assert.equal((await auditSitemap(clients, { ...settings, sitemap: xmlFile })).pages.length, 1);
  await assert.rejects(readLocal(xmlFile, 1), /exceeds/);
  extra = await startServer((req, res) => {
    if (req.url === '/bad') return res.end('<urlset>');
    if (req.url === '/large') return res.end('x'.repeat(settings.maxBytes + 1));
    if (req.url === '/hang') {
      res.writeHead(200);
      res.write('<urlset>');
      return;
    }
    json(res, 500, {});
  });
  for (const route of ['/bad', '/large', '/error']) {
    const failed = await auditSitemap(clients, { ...settings, sitemap: `${extra.url}${route}` });
    assert.equal(failed.summary.complete, false);
  }
  const fast = createAuditClients({ ...settings, timeout: 50 }, controller.signal);
  try {
    await assert.rejects(fast.documents.get(`${extra.url}/hang`));
  } finally {
    fast.close();
  }
  controller.abort();
  await assert.rejects(auditSitemap(clients, settings, controller.signal));
  const cli = await runExample(
    path.join(import.meta.dirname, 'index.mjs'),
    ['--demo'],
    path.join(work, 'cli'),
  );
  assert.equal(cli.code, 1, cli.stderr);
  assert.match(cli.stdout, /\[audit summary\]/);
  assert.equal(JSON.parse(await readFile(path.join(work, 'cli', 'summary.json'))).brokenPages, 1);
  console.log('sitemap-auditor smoke passed (sitemap index, one-level links, limits, errors, reports)');
} finally {
  clients.close();
  await extra?.close();
  await demo.close();
  await rm(work, { recursive: true, force: true });
}
