import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './run.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const metadata = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const temporary = await mkdtemp(path.join(tmpdir(), 'fetchforge-'));
const listOnly = process.argv.includes('--list');

const required = [
  'package.json',
  'README.md',
  'CHANGELOG.md',
  'LICENSE',
  'docs/README.md',
  'docs/api-reference.md',
  'dist/esm/index.js',
  'dist/esm/index.min.js',
  'dist/esm/index.d.ts',
  'dist/cjs/index.js',
  'dist/cjs/index.min.js',
  'dist/cjs/index.d.ts',
  'dist/cjs/package.json',
  'dist/browser/fetchforge.global.js',
  'dist/browser/fetchforge.global.min.js',
  ...['stores', 'file-store', 'testing'].flatMap((entry) => [
    `dist/esm/${entry}.js`,
    `dist/esm/${entry}.d.ts`,
    `dist/cjs/${entry}.js`,
    `dist/cjs/${entry}.d.ts`,
  ]),
];
const forbidden =
  /(^|\/)(src|test|scripts|examples|\.github|node_modules)\/|\.env|\.tsbuildinfo$|^tsconfig|^biome/;

const exercise = `
  const { createClient, HttpError, isCircuitOpenError } = MOD;
  const server = (await import('node:http')).createServer((req, res) => {
    res.writeHead(req.url === '/bad' ? 500 : 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: req.url !== '/bad' }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    const client = createClient({ baseUrl: base });
    const ok = await client.get('/x');
    if (ok.data.ok !== true) throw new Error('GET failed');
    const err = await client.get('/bad').catch((e) => e);
    if (!(err instanceof HttpError) || err.status !== 500) throw new Error('HttpError contract differs');
    const bulk = await client.bulk(['/a', '/b'], { concurrency: 1 });
    if (bulk.fulfilled !== 2) throw new Error('bulk failed');
    console.log('ok');
  } finally {
    server.closeAllConnections();
    server.close();
  }
`;

try {
  if (!process.argv.includes('--built')) run('npm', ['run', 'build'], { cwd: root });
  assert.equal(metadata.name, '@dipanshuhandoo/fetchforge');
  assert.equal(metadata.license, 'MIT');
  assert.equal(metadata.publishConfig.access, 'public');
  assert.equal(metadata.private, undefined);

  const packing = ['pack', '--json', '--ignore-scripts', '--pack-destination', temporary];
  packing.push(listOnly ? '--dry-run' : '--dry-run=false');
  const result = JSON.parse(run('npm', packing, { cwd: root, capture: true }));
  const packed = Array.isArray(result) ? result[0] : result[metadata.name];
  const files = packed.files.map(({ path: p }) => p);
  for (const file of required) assert.ok(files.includes(file), `tarball is missing ${file}`);
  for (const file of files) {
    if (file.endsWith('.map')) continue;
    assert.ok(!forbidden.test(file), `tarball contains unexpected file ${file}`);
  }
  assert.ok(packed.size < 800000, `tarball is unexpectedly large: ${packed.size} bytes`);
  for (const file of files.filter((f) => f.endsWith('.map'))) {
    const map = JSON.parse(await readFile(path.join(root, file), 'utf8'));
    assert.ok(
      map.sources.every((s) => !path.isAbsolute(s) && !/^[a-z]:/i.test(s)),
      `${file} has absolute source paths`,
    );
  }
  console.log(`Tarball allowlist passed: ${files.length} files, ${packed.size} bytes.`);
  if (listOnly) {
    console.log(files.sort().join('\n'));
  } else {
    const tarball = path.join(temporary, packed.filename);
    run(process.execPath, [path.join(root, 'node_modules/publint/src/cli.js'), tarball].filter(Boolean), {
      cwd: root,
    });
    const consumer = path.join(temporary, 'consumer');
    await mkdir(consumer);
    await writeFile(path.join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
    run(
      'npm',
      [
        'install',
        tarball,
        '--dry-run=false',
        '--no-package-lock',
        '--no-audit',
        '--no-fund',
        '--ignore-scripts',
      ],
      { cwd: consumer },
    );
    run(
      'npm',
      [
        'install',
        '-D',
        'typescript@^7',
        '@types/node@^24',
        '--dry-run=false',
        '--no-package-lock',
        '--no-audit',
        '--no-fund',
        '--ignore-scripts',
      ],
      { cwd: consumer },
    );

    const outputs = [];
    for (const subpath of ['', '/min']) {
      const specifier = JSON.stringify(metadata.name + subpath);
      const esm = `import * as MOD from ${specifier};\n${exercise}`;
      const cjs = `(async () => { const MOD = require(${specifier});\n${exercise} })().catch((e) => { console.error(e); process.exitCode = 1; });`;
      outputs.push(
        run(process.execPath, ['--input-type=module', '--eval', esm], { cwd: consumer, capture: true }),
      );
      outputs.push(
        run(process.execPath, ['--input-type=commonjs', '--eval', cjs], { cwd: consumer, capture: true }),
      );
    }
    assert.ok(outputs.every((o) => o.trim() === 'ok'));

    // Subpaths: mocked client + cache with every store that runs in Node.js.
    const subpaths = (load) => `
      const { createClient, cache } = ${load('')};
      const { memoryStore, redisStore, webStorageStore, cacheBridgeStore } = ${load('/stores')};
      const { fileStore } = ${load('/stores/file')};
      const { mockFetch } = ${load('/testing')};
      const os = await import('node:os');
      const fs = await import('node:fs/promises');
      const dir = await fs.mkdtemp(os.tmpdir() + '/ff-sub-');
      try {
        const map = new Map();
        const storage = { get length() { return map.size; }, key: (i) => [...map.keys()][i] ?? null,
          getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, v), removeItem: (k) => map.delete(k) };
        const kv = new Map();
        const redis = { call: async (cmd, k, v) => cmd === 'GET' ? kv.get(k) ?? null : cmd === 'SET' ? kv.set(k, v) : kv.delete(k) };
        const bridge = { getAsync: async (k) => kv.get(k), setAsync: async (k, v) => kv.set(k, v),
          deleteAsync: async (k) => kv.delete(k), clear: () => kv.clear(), keys: () => [...kv.keys()] };
        const stores = [memoryStore(), webStorageStore(storage), redisStore(redis), cacheBridgeStore(bridge), fileStore({ dir })];
        for (const store of stores) {
          const fetch = mockFetch({ baseUrl: 'https://api.test' }).get('/x', { json: { ok: true } });
          const client = createClient({ baseUrl: 'https://api.test', fetch, plugins: [cache({ store })] });
          await client.get('/x');
          const hit = await client.get('/x');
          if (hit.cache !== 'hit' || hit.data.ok !== true || fetch.calls.length !== 1) throw new Error('cache failed');
        }
        console.log('ok');
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    `;
    const esmSub = subpaths((sub) => `await import(${JSON.stringify(metadata.name + sub)})`);
    const cjsSub = `(async () => {${subpaths((sub) => `require(${JSON.stringify(metadata.name + sub)})`)}})().catch((e) => { console.error(e); process.exitCode = 1; });`;
    for (const [type, code] of [
      ['module', esmSub],
      ['commonjs', cjsSub],
    ]) {
      const out = run(process.execPath, [`--input-type=${type}`, '--eval', code], {
        cwd: consumer,
        capture: true,
      });
      assert.equal(out.trim(), 'ok', `subpath exercise (${type}) failed`);
    }

    for (const name of await readdir(path.join(root, 'examples'))) {
      await copyFile(path.join(root, 'examples', name), path.join(consumer, name));
    }
    const examples = (await readdir(path.join(root, 'examples'))).filter(
      (name) => name.endsWith('.mjs') && !name.startsWith('_'),
    );
    assert.ok(examples.length >= 10, 'expected the full example set');
    for (const name of examples) run(process.execPath, [name], { cwd: consumer });

    for (const extension of ['mts', 'cts']) {
      await copyFile(
        path.join(root, 'test/types', `consumer.${extension}`),
        path.join(consumer, `consumer.${extension}`),
      );
    }
    const tsc = path.join(consumer, 'node_modules/typescript/bin/tsc');
    run(
      process.execPath,
      [
        tsc,
        '--noEmit',
        '--strict',
        '--module',
        'nodenext',
        '--target',
        'es2022',
        'consumer.mts',
        'consumer.cts',
      ],
      { cwd: consumer },
    );
    run(
      process.execPath,
      [
        tsc,
        '--noEmit',
        '--strict',
        '--module',
        'esnext',
        '--moduleResolution',
        'bundler',
        '--target',
        'es2022',
        'consumer.mts',
      ],
      { cwd: consumer },
    );

    run(
      process.execPath,
      [
        path.join(root, 'node_modules/@arethetypeswrong/cli/dist/index.js'),
        tarball,
        '--profile',
        'node16',
        '--exclude-entrypoints',
        'browser',
      ],
      { cwd: root },
    );
    console.log(
      'Packed package: ESM, CommonJS, /min, TypeScript (nodenext, bundler), examples, publint and attw passed.',
    );
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}
