import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../', import.meta.url));
const browser = await chromium.launch({ headless: true });
try {
  for (const name of ['fetchforge.global.js', 'fetchforge.global.min.js']) {
    const script = await readFile(
      new URL(`dist/browser/${name}`, `file:///${root.replace(/\\/g, '/')}`),
      'utf8',
    );
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.route('https://fetchforge.test/**', (route) => {
      const url = route.request().url();
      if (url.endsWith('/bad')) return route.fulfill({ status: 500, json: { ok: false } });
      return route.fulfill({
        status: 200,
        json: { ok: true },
        headers: { 'access-control-allow-origin': '*' },
      });
    });
    await page.goto('about:blank');
    await page.addScriptTag({ content: script });
    const out = await page.evaluate(async () => {
      const client = FetchForge.createClient({ baseUrl: 'https://fetchforge.test' });
      const ok = await client.get('/x');
      const err = await client.get('/bad').catch((e) => e);
      const bulk = await client.bulk(['/a', '/b'], { concurrency: 1 });
      return { ok: ok.data.ok, http: err instanceof FetchForge.HttpError, fulfilled: bulk.fulfilled };
    });
    assert.deepEqual(errors, []);
    assert.deepEqual(out, { ok: true, http: true, fulfilled: 2 });
    await page.close();
  }
  console.log('Browser global bundles passed (readable and minified).');
} finally {
  await browser.close();
}
